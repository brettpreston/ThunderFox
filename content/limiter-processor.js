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
 */

// Fixed, so the node's latency never changes while audio is running. Changing
// it mid-stream would shift the delay line and click.
const LOOKAHEAD_SECONDS = 0.005;

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
                defaultValue: 0.12,
                minValue: 0.005,
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
        this.boxSum = 0;
        this.boxCount = 0;
        this.boxLength = 0;

        this.gain = 1;
        this.sampleIndex = 0;

        this.port.onmessage = (event) => {
            if (event.data && event.data.type === 'reset') this.reset();
        };
    }

    reset() {
        this.delay.forEach((buffer) => buffer.fill(0));
        this.delayPos = 0;
        this.dequeHead = 0;
        this.dequeCount = 0;
        this.minima.fill(1);
        this.minimaIndex = -1;
        this.boxSum = 0;
        this.boxCount = 0;
        this.gain = 1;
        this.sampleIndex = 0;
    }

    ensureDelay(channelCount) {
        if (this.delay.length === channelCount) return;
        this.delay = [];
        for (let c = 0; c < channelCount; c++) {
            this.delay.push(new Float32Array(this.lookahead));
        }
        this.delayPos = 0;
    }

    // Rebuild the running sum when the user moves the smoothing control.
    resizeBox(length) {
        const capacity = this.minima.length;
        // minimaIndex is negative until the delay line has filled.
        const available = Math.max(0, Math.min(length, this.minimaIndex + 1));

        this.boxLength = length;
        this.boxSum = 0;
        this.boxCount = available;

        for (let i = 0; i < available; i++) {
            const index = this.minimaIndex - i;
            this.boxSum += this.minima[((index % capacity) + capacity) % capacity];
        }
    }

    runningMinimum(value, index) {
        const capacity = this.dequeValues.length;

        // Anything already queued that is not smaller than the new value can
        // never be the window minimum again.
        while (this.dequeCount > 0) {
            const tail = (this.dequeHead + this.dequeCount - 1) % capacity;
            if (this.dequeValues[tail] >= value) this.dequeCount--;
            else break;
        }

        const slot = (this.dequeHead + this.dequeCount) % capacity;
        this.dequeValues[slot] = value;
        this.dequeIndices[slot] = index;
        this.dequeCount++;

        const oldest = index - this.lookahead + 1;
        while (this.dequeCount > 0 && this.dequeIndices[this.dequeHead] < oldest) {
            this.dequeHead = (this.dequeHead + 1) % capacity;
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

        if (!input || input.length === 0) {
            for (let c = 0; c < channelCount; c++) output[c].fill(0);
            return true;
        }

        this.ensureDelay(channelCount);

        const ceiling = parameters.ceiling[0];
        const releaseSamples = Math.max(1, parameters.release[0] * sampleRate);
        const releaseCoefficient = Math.exp(-1 / releaseSamples);

        const requestedBox = Math.round(parameters.smoothing[0] * sampleRate);
        const boxLength = Math.max(1, Math.min(this.lookahead, requestedBox));
        if (boxLength !== this.boxLength) this.resizeBox(boxLength);

        const capacity = this.minima.length;
        const delayLength = this.lookahead;

        for (let i = 0; i < frames; i++) {
            // Peak is taken across channels so gain reduction is linked and the
            // stereo image cannot shift.
            let peak = 0;
            for (let c = 0; c < channelCount; c++) {
                const sample = input[c] ? input[c][i] : 0;
                this.delay[c][this.delayPos] = sample;
                const magnitude = sample < 0 ? -sample : sample;
                if (magnitude > peak) peak = magnitude;
            }

            const required = peak > ceiling ? ceiling / peak : 1;
            const minimum = this.runningMinimum(required, this.sampleIndex);

            const outIndex = this.sampleIndex - delayLength + 1;
            this.boxSum += minimum;
            if (this.boxCount < this.boxLength) {
                this.boxCount++;
            } else {
                const evicted = outIndex - this.boxLength;
                this.boxSum -= this.minima[((evicted % capacity) + capacity) % capacity];
            }
            this.minima[((outIndex % capacity) + capacity) % capacity] = minimum;
            this.minimaIndex = outIndex;

            const smoothed = this.boxSum / this.boxCount;

            // Gain may fall as fast as the envelope demands but only recovers at
            // the release rate, which is what keeps bass from being modulated.
            const recovered = 1 + (this.gain - 1) * releaseCoefficient;
            this.gain = smoothed < recovered ? smoothed : recovered;

            const readPos = (this.delayPos + 1) % delayLength;
            for (let c = 0; c < channelCount; c++) {
                output[c][i] = this.delay[c][readPos] * this.gain;
            }

            this.delayPos = readPos;
            this.sampleIndex++;
        }

        return true;
    }
}

registerProcessor('thunderfox-brickwall-limiter', BrickwallLimiterProcessor);
