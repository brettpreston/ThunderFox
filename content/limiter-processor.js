'use strict';

/**
 * Look-ahead brickwall limiter.
 *
 * The signal is delayed while the gain envelope is computed from samples that
 * have not been heard yet, so the gain is already down by the time a peak
 * arrives. That is what makes it transparent: there is no clipping, no
 * saturation and no waveshaping, only a smooth gain envelope.
 *
 * The envelope is built in three steps:
 *
 *   r[n] = min(1, ceiling / |x[n]|)          required gain, per sample
 *   m[k] = min(r[k .. k + D - 1])            running minimum over the window
 *   s[k] = mean(m[k - L + 1 .. k])           boxcar, turns the staircase into a ramp
 *
 * with D the look-ahead in samples and L <= D the smoothing width. Output is
 * y[k] = g[k] * x[k], where g[k] = min(s[k], recovery).
 *
 * This guarantees |y| <= ceiling. For any peak at index p, every m[j] averaged
 * into s[p] is taken over a window [j, j + D - 1] that contains p, because j
 * ranges over [p - L + 1, p] and L <= D. Each of those minima is therefore at
 * most r[p], so their mean is too, and g[p] <= s[p] <= r[p]. Taking a minimum
 * with the recovery term can only lower the gain further, so the release
 * envelope cannot break the bound either.
 *
 * |x[n]| is the inter-sample peak, not the sample magnitude, when ISP is on:
 * a signal can pass between two samples and still reconstruct above the ceiling
 * in any downstream resampler or codec. See the ISP section below.
 */

// Fixed, so the node's latency never changes while audio is running. Changing
// it mid-stream would shift the delay line and click.
const LOOKAHEAD_SECONDS = 0.005;

// Inter-sample peak detection: a 12-tap windowed-sinc polyphase interpolator at
// 4x, giving three sub-sample estimates between each pair of samples. The
// history delay is applied whether or not ISP is enabled, so toggling it cannot
// change the node's latency and cannot click.
const ISP_TAPS = 12;
const ISP_PHASES = 4;
const ISP_CENTRE = ISP_TAPS / 2 - 1;
const ISP_LATENCY = ISP_TAPS - 1 - ISP_CENTRE;

// The release parameter is the time to recover 99% of the gain reduction rather
// than one time constant, so the number on the control matches what is heard.
// ln(100) time constants gets there. This is the "digital time constant" from
// gin::Dynamics (FigBug's Gin, the engine behind the SocaLabs/slPlugins
// Limiter), whose release this stage follows: a single exponential, rather
// than the staged fast-then-slow recovery an earlier version used, whose
// stage switch was audible as a kink in the release.
const RECOVERY_DECADES = Math.log(100);

// Below this the release one-pole is denormal and costs a hardware penalty for
// no audible benefit.
const GAIN_SETTLED = 1e-12;

// Rebuilding the boxcar sum periodically bounds the random walk that a running
// add/subtract accumulator over Float32 stores would otherwise accrue.
const BOX_RESUM_INTERVAL = 1 << 16;

class BrickwallLimiterProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            {
                name: 'ceiling',
                defaultValue: 0.966,
                minValue: 0.001,
                maxValue: 1,
                automationRate: 'k-rate'
            },
            {
                name: 'smoothing',
                defaultValue: 0.0025,
                minValue: 0.0002,
                maxValue: LOOKAHEAD_SECONDS,
                automationRate: 'k-rate'
            },
            {
                name: 'release',
                defaultValue: 0.08,
                minValue: 0.005,
                maxValue: 1,
                automationRate: 'k-rate'
            },
            {
                name: 'hold',
                defaultValue: 0.02,
                minValue: 0,
                maxValue: 0.05,
                automationRate: 'k-rate'
            },
            {
                name: 'isp',
                defaultValue: 1,
                minValue: 0,
                maxValue: 1,
                automationRate: 'k-rate'
            }
        ];
    }

    constructor() {
        super();

        this.lookahead = Math.max(2, Math.round(LOOKAHEAD_SECONDS * sampleRate));

        this.delay = [];
        this.delayPos = 0;

        // Monotonic deque over the required gain, so the running minimum costs
        // amortised O(1) per sample instead of O(lookahead). Indices are
        // doubles rather than Int32, which would wrap after about twelve hours
        // of continuous playback and corrupt the window comparison.
        const dequeCapacity = this.lookahead + 1;
        this.dequeValues = new Float32Array(dequeCapacity);
        this.dequeIndices = new Float64Array(dequeCapacity);
        this.dequeHead = 0;
        this.dequeCount = 0;

        // Ring of minima feeding the boxcar average. Unity is "no reduction",
        // so unwritten entries must start there rather than at zero.
        this.minima = new Float32Array(this.lookahead + 1).fill(1);
        this.minimaIndex = -1;
        this.minimaWrite = 0;
        this.boxSum = 0;
        this.boxCount = 0;
        this.boxLength = 0;
        this.resumCountdown = BOX_RESUM_INTERVAL;

        this.gain = 1;
        this.sampleIndex = 0;
        this.holdCountdown = 0;

        // Doubled ring, so a tap loop can read ISP_TAPS consecutive samples
        // without a modulo on every tap.
        this.history = [];
        this.historyPos = 0;

        this.ispCoefficients = BrickwallLimiterProcessor.buildIspCoefficients();

        this.port.onmessage = (event) => {
            if (event.data && event.data.type === 'reset') this.reset();
        };

        this.port.postMessage({
            type: 'latency',
            samples: this.lookahead - 1 + ISP_LATENCY,
            seconds: (this.lookahead - 1 + ISP_LATENCY) / sampleRate
        });
    }

    /**
     * Windowed-sinc interpolation kernels for the three sub-sample phases.
     * Each phase is normalised to unity DC gain, or the interpolated peak would
     * carry a small level error of its own.
     */
    static buildIspCoefficients() {
        const table = new Float32Array((ISP_PHASES - 1) * ISP_TAPS);
        const halfWidth = ISP_TAPS / 2;

        for (let phase = 1; phase < ISP_PHASES; phase++) {
            const centre = ISP_CENTRE + phase / ISP_PHASES;
            const base = (phase - 1) * ISP_TAPS;
            let sum = 0;

            for (let k = 0; k < ISP_TAPS; k++) {
                const d = k - centre;
                const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
                // Hamming expressed as a function of distance from the
                // interpolation point, so every phase is windowed about its own
                // centre rather than about the buffer's.
                const window = 0.54 + 0.46 * Math.cos((Math.PI * d) / halfWidth);
                const value = Math.abs(d) >= halfWidth ? 0 : sinc * window;
                table[base + k] = value;
                sum += value;
            }

            if (Math.abs(sum) > 1e-12) {
                for (let k = 0; k < ISP_TAPS; k++) table[base + k] /= sum;
            }
        }

        return table;
    }

    reset() {
        this.delay.forEach((buffer) => buffer.fill(0));
        this.history.forEach((buffer) => buffer.fill(0));
        this.delayPos = 0;
        this.historyPos = 0;
        this.dequeHead = 0;
        this.dequeCount = 0;
        this.minima.fill(1);
        this.minimaIndex = -1;
        this.minimaWrite = 0;
        this.boxSum = 0;
        this.boxCount = 0;
        this.boxLength = 0;
        this.resumCountdown = BOX_RESUM_INTERVAL;
        this.gain = 1;
        this.sampleIndex = 0;
        this.holdCountdown = 0;
    }

    ensureChannels(channelCount) {
        if (this.delay.length === channelCount) return;

        this.delay = [];
        this.history = [];
        for (let c = 0; c < channelCount; c++) {
            this.delay.push(new Float32Array(this.lookahead));
            this.history.push(new Float32Array(ISP_TAPS * 2));
        }

        // The envelope in flight was computed from audio that is no longer in
        // the delay line, so everything downstream of the detector has to go
        // with it. Resetting only delayPos leaves the two desynchronised.
        this.reset();
    }

    // Rebuild the running sum when the user moves the smoothing control.
    resizeBox(length) {
        const capacity = this.minima.length;
        // minimaIndex is negative until the delay line has filled.
        const available = Math.max(0, Math.min(length, this.minimaIndex + 1));

        this.boxLength = length;
        this.boxSum = 0;
        this.boxCount = available;

        let slot = this.minimaWrite;
        for (let i = 0; i < available; i++) {
            slot = slot === 0 ? capacity - 1 : slot - 1;
            this.boxSum += this.minima[slot];
        }
    }

    // Recompute the boxcar sum in place, discarding accumulated float drift.
    resumBox() {
        const capacity = this.minima.length;
        let slot = this.minimaWrite;
        let sum = 0;
        for (let i = 0; i < this.boxCount; i++) {
            slot = slot === 0 ? capacity - 1 : slot - 1;
            sum += this.minima[slot];
        }
        this.boxSum = sum;
    }

    runningMinimum(value, index) {
        const capacity = this.dequeValues.length;

        // Anything already queued that is not smaller than the new value can
        // never be the window minimum again.
        while (this.dequeCount > 0) {
            let tail = this.dequeHead + this.dequeCount - 1;
            if (tail >= capacity) tail -= capacity;
            if (this.dequeValues[tail] >= value) this.dequeCount--;
            else break;
        }

        let slot = this.dequeHead + this.dequeCount;
        if (slot >= capacity) slot -= capacity;
        this.dequeValues[slot] = value;
        this.dequeIndices[slot] = index;
        this.dequeCount++;

        const oldest = index - this.lookahead + 1;
        while (this.dequeCount > 0 && this.dequeIndices[this.dequeHead] < oldest) {
            this.dequeHead = this.dequeHead + 1 === capacity ? 0 : this.dequeHead + 1;
            this.dequeCount--;
        }

        return this.dequeValues[this.dequeHead];
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!output || output.length === 0) return true;

        const channelCount = output.length;
        const frames = output[0].length;

        this.ensureChannels(channelCount);

        const ceiling = parameters.ceiling[0];
        const ispEnabled = parameters.isp[0] >= 0.5;

        const releaseSeconds = parameters.release[0];
        const releaseTauSamples = Math.max(1, (releaseSeconds * sampleRate) / RECOVERY_DECADES);
        const releaseCoefficient = Math.exp(-1 / releaseTauSamples);
        const holdSamples = Math.round(parameters.hold[0] * sampleRate);

        const requestedBox = Math.round(parameters.smoothing[0] * sampleRate);
        const boxLength = Math.max(1, Math.min(this.lookahead, requestedBox));
        if (boxLength !== this.boxLength) this.resizeBox(boxLength);

        const minimaCapacity = this.minima.length;
        const delayLength = this.lookahead;
        const minima = this.minima;
        const ispCoefficients = this.ispCoefficients;

        // Hoisted out of the frame loop: an input can present fewer channels
        // than the output, and testing that per sample per channel is wasteful.
        const sourceChannels = input ? Math.min(input.length, channelCount) : 0;

        for (let i = 0; i < frames; i++) {
            // Push into the history ring, twice, so the tap loop below reads a
            // contiguous run. Then take the delayed sample the rest of the
            // algorithm treats as "now".
            let historyRead = this.historyPos + 1;
            let peak = 0;

            for (let c = 0; c < channelCount; c++) {
                let sample = c < sourceChannels ? input[c][i] : 0;
                // A NaN would never raise `peak` (every comparison against it is
                // false), so it would sail through at unity gain and then poison
                // the boxcar sum permanently.
                if (!(sample === sample)) sample = 0;

                const ring = this.history[c];
                ring[this.historyPos] = sample;
                ring[this.historyPos + ISP_TAPS] = sample;

                const delayed = ring[historyRead + ISP_CENTRE];
                this.delay[c][this.delayPos] = delayed;

                const magnitude = delayed < 0 ? -delayed : delayed;
                if (magnitude > peak) peak = magnitude;

                if (ispEnabled) {
                    for (let phase = 0; phase < ISP_PHASES - 1; phase++) {
                        const base = phase * ISP_TAPS;
                        let accumulator = 0;
                        for (let k = 0; k < ISP_TAPS; k++) {
                            accumulator += ispCoefficients[base + k] * ring[historyRead + k];
                        }
                        const interpolated = accumulator < 0 ? -accumulator : accumulator;
                        if (interpolated > peak) peak = interpolated;
                    }
                }
            }

            this.historyPos = this.historyPos + 1 === ISP_TAPS ? 0 : this.historyPos + 1;

            const required = peak > ceiling ? ceiling / peak : 1;
            const minimum = this.runningMinimum(required, this.sampleIndex);

            const outIndex = this.sampleIndex - delayLength + 1;
            this.boxSum += minimum;
            if (this.boxCount < this.boxLength) {
                this.boxCount++;
            } else {
                let evictSlot = this.minimaWrite - this.boxLength;
                if (evictSlot < 0) evictSlot += minimaCapacity;
                this.boxSum -= minima[evictSlot];
            }
            minima[this.minimaWrite] = minimum;
            this.minimaIndex = outIndex;
            this.minimaWrite = this.minimaWrite + 1 === minimaCapacity ? 0 : this.minimaWrite + 1;

            if (--this.resumCountdown <= 0) {
                this.resumCountdown = BOX_RESUM_INTERVAL;
                this.resumBox();
            }

            const smoothed = this.boxSum / this.boxCount;

            // Gain may fall as fast as the envelope demands but only recovers
            // after the hold, and then along a single exponential toward
            // unity, gin::Dynamics style.
            let recovered;
            if (this.holdCountdown > 0) {
                this.holdCountdown--;
                recovered = this.gain;
            } else {
                recovered = 1 + (this.gain - 1) * releaseCoefficient;
                if (recovered > 1 - GAIN_SETTLED) recovered = 1;
            }

            // The hold restarts whenever the envelope still asks for at least
            // the current reduction, equality included. A steady tone asks for
            // exactly the same gain at every peak, and with a strict comparison
            // those peaks did not restart the hold, so the gain crept up
            // between them and was snapped back down at each one: the same
            // within-cycle movement the hold exists to prevent.
            if (smoothed <= recovered) {
                this.gain = smoothed;
                this.holdCountdown = holdSamples;
            } else {
                this.gain = recovered;
            }

            const readPos = this.delayPos + 1 === delayLength ? 0 : this.delayPos + 1;
            const gain = this.gain;
            for (let c = 0; c < channelCount; c++) {
                output[c][i] = this.delay[c][readPos] * gain;
            }

            this.delayPos = readPos;
            this.sampleIndex++;
        }

        return true;
    }
}

registerProcessor('thunderfox-brickwall-limiter', BrickwallLimiterProcessor);
