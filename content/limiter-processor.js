'use strict';

/**
 * Look-ahead brickwall limiter with a program-dependent release.
 *
 * The signal is delayed while the gain envelope is computed from samples that
 * have not been heard yet, so the gain is already down by the time a peak
 * arrives. There is no clipping, no saturation and no waveshaping, only a
 * smooth gain envelope.
 *
 * Everything between the detector and the output works on the gain reduction
 * in the log domain (nepers, positive = quieter), because that is the scale
 * loudness is heard on. A release that is exponential in linear gain gives
 * back 20 dB of a 24 dB reduction in its first time constant, which is heard
 * as a swell; the same release in decibels is heard as a fade.
 *
 * The envelope is built in four steps:
 *
 *   r[n] = max(0, ln(|x[n]| / ceiling))      required reduction, per sample
 *   m[k] = max(r[k .. k + D - 1])            running maximum over the window
 *   e[k] = release(m)[k],  e[k] >= m[k]      hold and two-stage release
 *   g[k] = (w * e)[k]                        smoothing, kernel w of support <= D
 *
 * with D the look-ahead in samples. Output is y[k] = exp(-g[k]) * x[k].
 *
 * This guarantees |y| <= ceiling. The kernel w is non-negative, sums to one
 * and spans at most D samples, so g[p] is a weighted mean of e[j] for j in
 * [p - D + 1, p]. Each e[j] >= m[j], and each m[j] is a maximum over a window
 * [j, j + D - 1] that contains p, so every term is at least r[p] and their
 * mean is too. The release stage sits *inside* that bound: whatever it does,
 * it may only ever hold the envelope at or above the running maximum.
 *
 * Smoothing comes last, so it rounds off every corner the envelope has, the
 * start of a release as much as the start of an attack. The kernel is two
 * boxcars in cascade (a triangle), which turns a step into an S-curve with a
 * continuous slope.
 *
 * |x[n]| is the inter-sample peak, not the sample magnitude, when ISP is on:
 * a signal can pass between two samples and still reconstruct above the ceiling
 * in any downstream resampler or codec. See the ISP section below.
 *
 * The release. A single fast release is what makes a hard-driven limiter pump:
 * after every peak the gain races back up, the sustained material swells with
 * it, and the next peak pushes it down again. A single slow release avoids
 * that but lets one stray click duck everything after it. So the reduction is
 * kept in two parts, e = fast + slow:
 *
 *   - a new peak is taken up by the fast part, which recovers exponentially,
 *     inside the time the transient itself masks;
 *   - reduction the programme keeps asking for moves across to the slow part,
 *     which recovers along a straight line in decibels, a few dB per second.
 *
 * How readily it moves depends on how long the programme has been over the
 * ceiling. A lone transient is gone before anything has moved, so all of it
 * comes back fast. Sustained or dense material moves nearly all of its
 * reduction across, and from then on the gain rides the programme's level
 * rather than its individual peaks. The harder and longer the limiter is
 * driven, the more of the reduction sits in the slow part and the longer the
 * effective release. The hand-over is a transfer between two continuous
 * quantities whose sum it leaves unchanged, not a switch between two release
 * rates, so there is no stage change to hear.
 *
 * The drive. The gain ahead of the limiter is applied here rather than by a
 * node in front of it, because then the limiter knows when it changes.
 * Reduction that was only there because of the drive is handed back as the
 * drive comes down, in step with it. Left to the slow release it would take
 * seconds, and turning the drive down would be heard as the level dropping
 * away and creeping back. A rising drive needs nothing special: the
 * look-ahead meets it like any other rise in level.
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

// The release parameter is the time the fast part takes to give back 90% of
// its reduction, in decibels, rather than one time constant, so the number on
// the control is close to what is heard after a transient.
const RELEASE_DECADES = Math.log(10);

// The slow part, in units of the fast part's time constant, so the single
// Release control scales the whole recovery. CHARGE_RATIO is the time constant
// on which sustained reduction moves from the fast part to the slow part.
// RELEASE_SLOPE is how far the slow part recovers, in nepers, per fast time
// constant. At the default release of 80 ms these come to 26 ms and 3 dB per
// second.
const SLOW_CHARGE_RATIO = 0.75;
const SLOW_RELEASE_SLOPE = 0.012;

// Headroom added to the required reduction, about 0.00001 dB, so rounding in
// the running sums and in the Float32 output cannot land above the ceiling.
const GUARD = 1e-6;

// Below this a one-pole is heading for denormals, which cost a hardware
// penalty for no audible benefit.
const REDUCTION_SETTLED = 1e-9;

// A peak that asks for the reduction already in place restarts the hold. The
// envelope is a sum of two parts that trade reduction every sample, so "the
// same" has to allow for rounding.
const HOLD_TOLERANCE = 1e-9;

// Rebuilding the boxcar sums periodically bounds the random walk that a
// running add/subtract accumulator would otherwise accrue.
const BOX_RESUM_INTERVAL = 1 << 16;

class BrickwallLimiterProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            {
                name: 'drive',
                defaultValue: 1,
                minValue: 0.001,
                maxValue: 100,
                automationRate: 'a-rate'
            },
            {
                name: 'ceiling',
                defaultValue: 0.966,
                minValue: 0.001,
                maxValue: 1,
                automationRate: 'k-rate'
            },
            {
                name: 'smoothing',
                defaultValue: LOOKAHEAD_SECONDS,
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
        this.latency = this.lookahead - 1 + ISP_LATENCY;

        this.delay = [];
        this.delayPos = 0;

        // The drive each sample went in at, as a logarithm, kept until that
        // sample comes out. The first block sets the starting value, so a
        // drive that was already up when the stream began is not mistaken
        // for a change.
        this.driveRing = new Float64Array(this.latency + 1);
        this.drivePos = 0;
        this.drive = 1;
        this.driveLog = 0;
        this.delayedDriveLog = 0;
        this.driveKnown = false;

        // Monotonic deque over the required reduction, so the running maximum
        // costs amortised O(1) per sample instead of O(lookahead). Indices are
        // doubles rather than Int32, which would wrap after about twelve hours
        // of continuous playback and corrupt the window comparison.
        const dequeCapacity = this.lookahead + 1;
        this.dequeValues = new Float64Array(dequeCapacity);
        this.dequeIndices = new Float64Array(dequeCapacity);
        this.dequeHead = 0;
        this.dequeCount = 0;

        // The two boxcars of the smoothing kernel, each with the ring of its
        // own recent inputs. Zero is "no reduction", so a fresh ring is
        // already the right history for a stream that has not started. Each
        // boxcar is at most half the look-ahead, which keeps the pair inside
        // the bound in the header even across a change of length, when the
        // second ring still holds averages taken at the old one.
        this.boxCapacity = Math.max(1, Math.floor((this.lookahead + 1) / 2));
        this.envelopeRing = new Float64Array(this.boxCapacity);
        this.averageRing = new Float64Array(this.boxCapacity);
        this.ringPos = 0;
        this.boxLength = 0;
        this.envelopeSum = 0;
        this.averageSum = 0;
        this.resumCountdown = BOX_RESUM_INTERVAL;

        this.fast = 0;
        this.slow = 0;
        this.sustain = 0;
        this.holdCountdown = 0;
        this.sampleIndex = 0;

        // The inter-sample peak found between the previous sample and this
        // one. It counts against both of its neighbours.
        this.previousBetween = 0;

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
            samples: this.latency,
            seconds: this.latency / sampleRate
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
        this.driveRing.fill(this.driveLog);
        this.drivePos = 0;
        this.delayedDriveLog = this.driveLog;
        this.dequeHead = 0;
        this.dequeCount = 0;
        this.envelopeRing.fill(0);
        this.averageRing.fill(0);
        this.ringPos = 0;
        this.envelopeSum = 0;
        this.averageSum = 0;
        this.resumCountdown = BOX_RESUM_INTERVAL;
        this.fast = 0;
        this.slow = 0;
        this.sustain = 0;
        this.holdCountdown = 0;
        this.sampleIndex = 0;
        this.previousBetween = 0;
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

    // Sum of the `length` most recent entries of a ring whose next write goes
    // to `ringPos`.
    sumRecent(ring, length) {
        const capacity = this.boxCapacity;
        let slot = this.ringPos;
        let sum = 0;
        for (let i = 0; i < length; i++) {
            slot = slot === 0 ? capacity - 1 : slot - 1;
            sum += ring[slot];
        }
        return sum;
    }

    // Rebuild both running sums: when the user moves the smoothing control,
    // and periodically to discard accumulated float drift.
    rebuildBoxes(length) {
        this.boxLength = length;
        this.envelopeSum = this.sumRecent(this.envelopeRing, length);
        this.averageSum = this.sumRecent(this.averageRing, length);
    }

    runningMaximum(value, index) {
        const capacity = this.dequeValues.length;

        // Anything already queued that is not larger than the new value can
        // never be the window maximum again.
        while (this.dequeCount > 0) {
            let tail = this.dequeHead + this.dequeCount - 1;
            if (tail >= capacity) tail -= capacity;
            if (this.dequeValues[tail] <= value) this.dequeCount--;
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

        // One value per sample while the drive is being automated, otherwise
        // one for the block. A lone value that differs from the last one used
        // is ramped to across the block rather than stepped to.
        const driveValues = parameters.drive;
        const driveAutomated = driveValues.length > 1;
        if (!this.driveKnown) {
            this.drive = driveValues[0];
            this.driveLog = Math.log(this.drive);
            this.driveRing.fill(this.driveLog);
            this.delayedDriveLog = this.driveLog;
            this.driveKnown = true;
        }
        const driveStep = driveAutomated ? 0 : (driveValues[0] - this.drive) / frames;
        let drive = this.drive;
        let driveLog = this.driveLog;

        const fastTau = Math.max(1, (parameters.release[0] * sampleRate) / RELEASE_DECADES);
        const fastCoefficient = Math.exp(-1 / fastTau);
        const slowStep = SLOW_RELEASE_SLOPE / fastTau;
        const chargeRate = 1 - Math.exp(-1 / (fastTau * SLOW_CHARGE_RATIO));
        const holdSamples = Math.round(parameters.hold[0] * sampleRate);

        // The control is the width of the whole kernel, which is two boxcars
        // of half that each.
        const requestedBox = Math.round((parameters.smoothing[0] * sampleRate) / 2);
        const boxLength = Math.max(1, Math.min(this.boxCapacity, requestedBox));
        if (boxLength !== this.boxLength) this.rebuildBoxes(boxLength);

        // A change of drive is answered when the sample it was applied to
        // comes out, less the delay of the smoothing kernel, so that the
        // smoothed gain moves when the level does.
        const driveCapacity = this.driveRing.length;
        const driveDelay = Math.max(0, this.latency - (boxLength - 1));
        const driveRing = this.driveRing;

        const boxCapacity = this.boxCapacity;
        const delayLength = this.lookahead;
        const envelopeRing = this.envelopeRing;
        const averageRing = this.averageRing;
        const ispCoefficients = this.ispCoefficients;

        // Hoisted out of the frame loop: an input can present fewer channels
        // than the output, and testing that per sample per channel is wasteful.
        const sourceChannels = input ? Math.min(input.length, channelCount) : 0;

        for (let i = 0; i < frames; i++) {
            // Push into the history ring, twice, so the tap loop below reads a
            // contiguous run. Then take the delayed sample the rest of the
            // algorithm treats as "now".
            const historyRead = this.historyPos + 1;
            let peak = 0;
            let between = 0;

            let nextDrive;
            if (driveAutomated) nextDrive = driveValues[i];
            else nextDrive = i === frames - 1 ? driveValues[0] : drive + driveStep;
            if (nextDrive !== drive && nextDrive > 0) {
                drive = nextDrive;
                driveLog = Math.log(drive);
            }

            for (let c = 0; c < channelCount; c++) {
                let sample = c < sourceChannels ? input[c][i] * drive : 0;
                // A NaN would never raise `peak` (every comparison against it is
                // false), so it would sail through at unity gain and then poison
                // the running sums permanently.
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
                        if (interpolated > between) between = interpolated;
                    }
                }
            }

            this.historyPos = this.historyPos + 1 === ISP_TAPS ? 0 : this.historyPos + 1;

            // A peak between two samples is shaped by the gain on both of
            // them, so it counts against the one before it and the one after.
            if (between > peak) peak = between;
            if (this.previousBetween > peak) peak = this.previousBetween;
            this.previousBetween = between;

            const required = peak > ceiling ? Math.log(peak / ceiling) + GUARD : 0;
            const maximum = this.runningMaximum(required, this.sampleIndex);

            let fast = this.fast;
            let slow = this.slow;

            // Hand back what a falling drive no longer needs, from the slow
            // part first. If that is more than the audio already in the
            // look-ahead allows, the check against the running maximum below
            // puts the difference straight back.
            driveRing[this.drivePos] = driveLog;
            let driveRead = this.drivePos - driveDelay;
            if (driveRead < 0) driveRead += driveCapacity;
            const delayedDriveLog = driveRing[driveRead];
            this.drivePos = this.drivePos + 1 === driveCapacity ? 0 : this.drivePos + 1;
            if (delayedDriveLog < this.delayedDriveLog) {
                slow -= this.delayedDriveLog - delayedDriveLog;
                if (slow < 0) {
                    fast += slow;
                    slow = 0;
                    if (fast < 0) fast = 0;
                }
            }
            this.delayedDriveLog = delayedDriveLog;

            // How much of the recent past the programme has spent over the
            // ceiling, 0 to 1. It scales the transfer below, so reduction only
            // moves to the slow part once the need for it has lasted.
            let sustain = this.sustain;
            sustain += ((maximum > 0 ? 1 : 0) - sustain) * chargeRate;
            if (sustain < REDUCTION_SETTLED) sustain = 0;
            this.sustain = sustain;

            // Reduction the detector is asking for right now moves from the
            // fast part to the slow part. The sum does not change, only how
            // quickly it will come back. Reduction that is merely being held
            // or released after a peak has passed does not move.
            if (maximum > slow) {
                let moved = (maximum - slow) * chargeRate * sustain;
                if (moved > fast) moved = fast;
                fast -= moved;
                slow += moved;
            }

            if (this.holdCountdown > 0) {
                this.holdCountdown--;
            } else {
                fast *= fastCoefficient;
                if (fast < REDUCTION_SETTLED) fast = 0;
                slow -= slowStep;
                if (slow < 0) slow = 0;
            }

            // The hold restarts whenever the detector still asks for at least
            // the reduction in place, equality included. A steady tone asks for
            // exactly the same reduction at every peak; if those peaks did not
            // restart the hold, the gain would creep up between them and be
            // pushed back down at each one, which is the within-cycle movement
            // the hold exists to prevent.
            const envelope = fast + slow;
            if (maximum > 0 && maximum >= envelope - HOLD_TOLERANCE) {
                if (maximum > envelope) fast = maximum - slow;
                this.holdCountdown = holdSamples;
            }
            this.fast = fast;
            this.slow = slow;

            // Two boxcars in cascade. The slot about to be overwritten is the
            // oldest in the ring; the one leaving a boxcar of boxLength is
            // that many writes back.
            const ringPos = this.ringPos;
            let evictSlot = ringPos - boxLength;
            if (evictSlot < 0) evictSlot += boxCapacity;

            const held = fast + slow;
            this.envelopeSum += held - envelopeRing[evictSlot];
            envelopeRing[ringPos] = held;

            const average = this.envelopeSum / boxLength;
            this.averageSum += average - averageRing[evictSlot];
            averageRing[ringPos] = average;

            this.ringPos = ringPos + 1 === boxCapacity ? 0 : ringPos + 1;

            if (--this.resumCountdown <= 0) {
                this.resumCountdown = BOX_RESUM_INTERVAL;
                this.rebuildBoxes(boxLength);
            }

            const reduction = this.averageSum / boxLength;
            const gain = reduction > 0 ? Math.exp(-reduction) : 1;

            const readPos = this.delayPos + 1 === delayLength ? 0 : this.delayPos + 1;
            for (let c = 0; c < channelCount; c++) {
                output[c][i] = this.delay[c][readPos] * gain;
            }

            this.delayPos = readPos;
            this.sampleIndex++;
        }

        this.drive = drive;
        this.driveLog = driveLog;

        return true;
    }
}

registerProcessor('thunderfox-brickwall-limiter', BrickwallLimiterProcessor);
