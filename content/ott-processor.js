'use strict';

/**
 * Three-band upward and downward compressor, in the style of OTT.
 *
 * The band split is a 4th-order Linkwitz-Riley tree. LR4 is two cascaded
 * Butterworth sections at the same cutoff, and its two halves sum to a
 * second-order allpass rather than to unity:
 *
 *   LP_LR4 + HP_LR4 = (s^2 - sqrt2 s + 1) / (s^2 + sqrt2 s + 1)
 *
 * because (s^2 + 1)^2 - 2 s^2 = s^4 + 1. So splitting twice leaves the low band
 * one allpass short of the other two, and running it through that same allpass
 * makes all three sum to AP(f1) * AP(f2) — flat magnitude, no crossover notch,
 * no empirical band trim.
 *
 *   low  = LP4(f1) -> AP2(f2)
 *   mid  = HP4(f1) -> LP4(f2)
 *   high = HP4(f1) -> HP4(f2)
 *
 * Each band has one detector driving both a downward and an upward stage, which
 * are summed in dB. Depth scales that sum, so it is a gain-domain control: there
 * is no dry path to comb against the wet one, and depth 0 is bit-exact bypass
 * apart from the crossover's own allpass.
 *
 * Upward compression cannot tell a quiet passage from a noise floor, so its gain
 * is clamped and then faded out below UP_FLOOR_TOP_DB. Without that, silence
 * between tracks comes up as loud as the music.
 */

const LOW_CROSSOVER_HZ = 88.3;
const HIGH_CROSSOVER_HZ = 2500;

// Butterworth Q. Two of these cascaded is one Linkwitz-Riley 4th-order filter,
// and it is also the Q of the allpass their sum produces.
const BUTTERWORTH_Q = Math.SQRT1_2;

// The fixed curve the user-facing controls scale. Depth and the per-band
// amounts do the work; these only define the shape.
const DOWN_THRESHOLD_DB = -24;
const DOWN_RATIO = 4;
const DOWN_KNEE_DB = 6;

const UP_THRESHOLD_DB = -38;
const UP_RATIO = 4;
const UP_KNEE_DB = 6;

const UP_MAX_DB = 18;
const UP_FLOOR_TOP_DB = -60;
const UP_FLOOR_BOTTOM_DB = -80;

// The floor fade follows its own slow envelope rather than the band detector.
// Between UP_FLOOR_TOP_DB and UP_FLOOR_BOTTOM_DB the positive gain (up to
// UP_MAX_DB plus makeup) fades to nothing over 20 dB of level, which is an
// expander with a ratio near 1:2.6. Driven by the fast detector that expander
// tracked every wobble in quiet low-band content, so a room tone or a reverb
// tail fluttered by tens of dB at the Time knob's rate, scaling with Down
// because makeup does. A 20 ms rise lets the first note after a gap open the
// band at once; the 400 ms fall means only a genuine pause closes it.
const FLOOR_ATTACK_SECONDS = 0.02;
const FLOOR_RELEASE_SECONDS = 0.4;

// Time knob, geometric about its midpoint so 50% lands on OTT's nominal
// 1 ms attack / 78 ms release.
const ATTACK_CENTRE_MS = 1;
const ATTACK_SPAN = 50;
const RELEASE_CENTRE_MS = 78;
const RELEASE_SPAN = 12.8;

// Per-band detector window, in seconds: a little over one half-period of the
// lowest frequency each band carries (20 Hz, the 88 Hz crossover, the 2.5 kHz
// crossover). The detector follows the peak over this window rather than the
// rectified sample. A follower on the raw rectified signal starts releasing
// between one half-cycle's peak and the next, so its gain rides the waveform
// itself: on a 30 Hz tone at the Time knob's midpoint that was -37 dB of
// harmonic distortion. A hold fixed the steady case but on a decaying bass
// note it produced a sawtooth instead, as the envelope sagged after each hold
// and every new peak snapped it back up. The windowed peak has neither: it
// steps only when a peak enters or leaves the window, by the amount the
// level actually changed, and Time then sets how fast the gain follows.
const BAND_WINDOW_SECONDS = [0.026, 0.006, 0.00025];

// Per-band attack floor. The low band's gain must not move by tens of dB
// inside a fraction of a bass cycle, whatever Time is set to: at the knob's
// 1 ms midpoint the low band gain was dropping more than 1 dB per sample at
// each kick onset, which is a click, not compression. 10 ms is about half a
// cycle at 50 Hz. The Time knob still lengthens the attack past the floor.
const BAND_MIN_ATTACK_SECONDS = [0.010, 0, 0];

const DB_PER_LOG = 20 / Math.LN10;
const LOG_PER_DB = Math.LN10 / 20;

// -180 dBFS: below any real dither, so the log is always finite.
const LEVEL_EPSILON = 1e-9;

const BAND_COUNT = 3;

function dbToGain(db) {
    return Math.exp(db * LOG_PER_DB);
}

/**
 * Maximum over the last `window` samples, amortised O(1) per sample: a
 * monotonic deque of candidates, each dropped once a larger value arrives or
 * once it ages out of the window.
 */
class RunningMax {
    constructor(window) {
        this.window = Math.max(1, window);
        const capacity = this.window + 1;
        this.values = new Float64Array(capacity);
        this.indices = new Float64Array(capacity);
        this.head = 0;
        this.count = 0;
    }

    reset() {
        this.head = 0;
        this.count = 0;
    }

    push(value, index) {
        const capacity = this.values.length;

        while (this.count > 0) {
            let tail = this.head + this.count - 1;
            if (tail >= capacity) tail -= capacity;
            if (this.values[tail] <= value) this.count--;
            else break;
        }

        let slot = this.head + this.count;
        if (slot >= capacity) slot -= capacity;
        this.values[slot] = value;
        this.indices[slot] = index;
        this.count++;

        const oldest = index - this.window + 1;
        while (this.count > 0 && this.indices[this.head] < oldest) {
            this.head = this.head + 1 === capacity ? 0 : this.head + 1;
            this.count--;
        }

        return this.values[this.head];
    }
}

/**
 * One biquad section in transposed direct form II, with independent state per
 * channel. TDF2 is used rather than DF1 because it keeps its accumulator in the
 * output's own scale, which matters for the very low cutoffs in the low band.
 */
class Biquad {
    constructor() {
        this.b0 = 1;
        this.b1 = 0;
        this.b2 = 0;
        this.a1 = 0;
        this.a2 = 0;
        this.z1 = new Float64Array(0);
        this.z2 = new Float64Array(0);
    }

    setChannelCount(count) {
        if (this.z1.length === count) return;
        this.z1 = new Float64Array(count);
        this.z2 = new Float64Array(count);
    }

    reset() {
        this.z1.fill(0);
        this.z2.fill(0);
    }

    // RBJ cookbook, normalised by a0.
    setLowpass(frequency, q, rate) {
        const w0 = 2 * Math.PI * Math.min(frequency / rate, 0.4999);
        const cos = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * q);
        const a0 = 1 + alpha;
        this.b0 = ((1 - cos) / 2) / a0;
        this.b1 = (1 - cos) / a0;
        this.b2 = this.b0;
        this.a1 = (-2 * cos) / a0;
        this.a2 = (1 - alpha) / a0;
    }

    setHighpass(frequency, q, rate) {
        const w0 = 2 * Math.PI * Math.min(frequency / rate, 0.4999);
        const cos = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * q);
        const a0 = 1 + alpha;
        this.b0 = ((1 + cos) / 2) / a0;
        this.b1 = -(1 + cos) / a0;
        this.b2 = this.b0;
        this.a1 = (-2 * cos) / a0;
        this.a2 = (1 - alpha) / a0;
    }

    setAllpass(frequency, q, rate) {
        const w0 = 2 * Math.PI * Math.min(frequency / rate, 0.4999);
        const cos = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * q);
        const a0 = 1 + alpha;
        this.b0 = (1 - alpha) / a0;
        this.b1 = (-2 * cos) / a0;
        this.b2 = 1;
        this.a1 = (-2 * cos) / a0;
        this.a2 = (1 - alpha) / a0;
    }

    process(x, channel) {
        const y = this.b0 * x + this.z1[channel];
        this.z1[channel] = this.b1 * x - this.a1 * y + this.z2[channel];
        this.z2[channel] = this.b2 * x - this.a2 * y;
        return y;
    }
}

class OttProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        // Input and output trims are GainNodes in the host graph (pre-boost
        // ahead, limiter drive behind), so the worklet does not duplicate them.
        const descriptors = [
            { name: 'depth', defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'time', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
        ];

        ['low', 'mid', 'high'].forEach((band) => {
            descriptors.push(
                { name: `${band}Up`, defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
                { name: `${band}Down`, defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
                { name: `${band}GainDb`, defaultValue: 0, minValue: -20, maxValue: 20, automationRate: 'k-rate' }
            );
        });

        return descriptors;
    }

    constructor() {
        super();

        this.channelCount = 0;

        this.lowSplitLp = [new Biquad(), new Biquad()];
        this.lowSplitHp = [new Biquad(), new Biquad()];
        this.highSplitLp = [new Biquad(), new Biquad()];
        this.highSplitHp = [new Biquad(), new Biquad()];
        this.lowAllpass = new Biquad();

        this.sections = [
            this.lowSplitLp[0], this.lowSplitLp[1],
            this.lowSplitHp[0], this.lowSplitHp[1],
            this.highSplitLp[0], this.highSplitLp[1],
            this.highSplitHp[0], this.highSplitHp[1],
            this.lowAllpass
        ];

        // Detector state, one per band. Gain reduction is channel-linked, so
        // there is one envelope per band rather than one per band per channel.
        // Allocated before designCrossover(), which sizes the windows.
        this.envelope = new Float64Array(BAND_COUNT);
        this.floorEnvelope = new Float64Array(BAND_COUNT);
        this.floorAttackCoefficient = 0;
        this.floorReleaseCoefficient = 0;
        this.windowMax = [];
        this.sampleIndex = 0;
        this.bandGain = new Float64Array(BAND_COUNT).fill(1);

        this.designCrossover();

        // Scratch, so the per-sample loop allocates nothing. The split output is
        // held per channel because the gain pass needs it again after the
        // detector has looked at every channel.
        this.bandSample = new Float64Array(BAND_COUNT);
        this.scratchLow = new Float64Array(0);
        this.scratchMid = new Float64Array(0);
        this.scratchHigh = new Float64Array(0);

        // The k-rate parameters, gathered per band. Preallocated so reading
        // them does not allocate three arrays on every render quantum, which
        // is about 1,100 allocations a second on the audio thread.
        this.upAmount = new Float64Array(BAND_COUNT);
        this.downAmount = new Float64Array(BAND_COUNT);
        this.bandGainDb = new Float64Array(BAND_COUNT);

        this.attackCoefficient = new Float64Array(BAND_COUNT);
        this.releaseCoefficient = 0;
        this.lastTime = -1;

        this.makeupDb = 0;

        this.port.onmessage = (event) => {
            if (event.data && event.data.type === 'reset') this.reset();
        };
    }

    designCrossover() {
        this.designedRate = sampleRate;
        // The Time coefficients are in samples, so they are stale at a new rate
        // too; forcing updateTiming() to recompute them on the next quantum.
        this.lastTime = -1;
        this.windowMax = [];
        for (let b = 0; b < BAND_COUNT; b++) {
            this.windowMax.push(new RunningMax(Math.round(BAND_WINDOW_SECONDS[b] * sampleRate)));
        }
        this.sampleIndex = 0;
        this.floorAttackCoefficient = Math.exp(-1 / (FLOOR_ATTACK_SECONDS * sampleRate));
        this.floorReleaseCoefficient = Math.exp(-1 / (FLOOR_RELEASE_SECONDS * sampleRate));
        this.lowSplitLp.forEach((section) => section.setLowpass(LOW_CROSSOVER_HZ, BUTTERWORTH_Q, sampleRate));
        this.lowSplitHp.forEach((section) => section.setHighpass(LOW_CROSSOVER_HZ, BUTTERWORTH_Q, sampleRate));
        this.highSplitLp.forEach((section) => section.setLowpass(HIGH_CROSSOVER_HZ, BUTTERWORTH_Q, sampleRate));
        this.highSplitHp.forEach((section) => section.setHighpass(HIGH_CROSSOVER_HZ, BUTTERWORTH_Q, sampleRate));
        this.lowAllpass.setAllpass(HIGH_CROSSOVER_HZ, BUTTERWORTH_Q, sampleRate);
    }

    reset() {
        this.sections.forEach((section) => section.reset());
        this.envelope.fill(0);
        this.floorEnvelope.fill(0);
        this.windowMax.forEach((window) => window.reset());
        this.sampleIndex = 0;
        this.bandGain.fill(1);
    }

    ensureChannels(count) {
        if (this.channelCount === count) return;
        this.channelCount = count;
        this.sections.forEach((section) => {
            section.setChannelCount(count);
            section.reset();
        });
        this.scratchLow = new Float64Array(count);
        this.scratchMid = new Float64Array(count);
        this.scratchHigh = new Float64Array(count);
        this.envelope.fill(0);
        this.floorEnvelope.fill(0);
        this.windowMax.forEach((window) => window.reset());
        this.sampleIndex = 0;
    }

    // Only recomputed when the Time knob moves; never per sample.
    updateTiming(time) {
        if (time === this.lastTime) return;
        this.lastTime = time;

        const exponent = 2 * time - 1;
        const attackMs = ATTACK_CENTRE_MS * Math.pow(ATTACK_SPAN, exponent);
        const releaseMs = RELEASE_CENTRE_MS * Math.pow(RELEASE_SPAN, exponent);

        const releaseSamples = Math.max(1, (releaseMs / 1000) * sampleRate);
        this.releaseCoefficient = Math.exp(-1 / releaseSamples);

        for (let b = 0; b < BAND_COUNT; b++) {
            const attackSeconds = Math.max(attackMs / 1000, BAND_MIN_ATTACK_SECONDS[b]);
            const attackSamples = Math.max(1, attackSeconds * sampleRate);
            this.attackCoefficient[b] = Math.exp(-1 / attackSamples);
        }
    }

    /**
     * Downward gain for a level, in dB, always <= 0. Quadratic soft knee, so the
     * curve and its slope are continuous at both knee edges.
     */
    static downwardGainDb(levelDb) {
        const over = levelDb - DOWN_THRESHOLD_DB;
        const half = DOWN_KNEE_DB / 2;
        const slope = 1 / DOWN_RATIO - 1;

        if (over <= -half) return 0;
        if (over >= half) return over * slope;

        const kneed = over + half;
        return (slope * kneed * kneed) / (2 * DOWN_KNEE_DB);
    }

    /**
     * Upward gain for a level, in dB, always >= 0 and clamped to UP_MAX_DB.
     */
    static upwardGainDb(levelDb) {
        const under = UP_THRESHOLD_DB - levelDb;
        const half = UP_KNEE_DB / 2;
        const slope = 1 - 1 / UP_RATIO;

        let gain;
        if (under <= -half) {
            gain = 0;
        } else if (under >= half) {
            gain = under * slope;
        } else {
            const kneed = under + half;
            gain = (slope * kneed * kneed) / (2 * UP_KNEE_DB);
        }

        return gain > UP_MAX_DB ? UP_MAX_DB : gain;
    }

    /**
     * How much of the positive gain — upward plus downward makeup — survives at
     * this level. Both are faded out together below UP_FLOOR_TOP_DB, reaching
     * zero at UP_FLOOR_BOTTOM_DB. The level passed in is the slow floor
     * envelope, not the band detector; see FLOOR_ATTACK_SECONDS.
     *
     * Tapering only the upward stage is not enough: makeup alone is +18 dB at
     * full depth, so a noise floor or an inter-track gap still comes up by that
     * much. Fading the pair means the compressor stops acting on material below
     * its own noise floor and silence stays silent, which is where the old
     * implementation's +34 dB of floor lift came from.
     */
    static floorFactor(levelDb) {
        if (levelDb >= UP_FLOOR_TOP_DB) return 1;
        if (levelDb <= UP_FLOOR_BOTTOM_DB) return 0;
        return (levelDb - UP_FLOOR_BOTTOM_DB) / (UP_FLOOR_TOP_DB - UP_FLOOR_BOTTOM_DB);
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!output || output.length === 0) return true;

        const channelCount = output.length;
        const frames = output[0].length;

        this.ensureChannels(channelCount);

        // A context's sampleRate is fixed for its lifetime, so this is a guard
        // rather than a code path. Coefficients designed for one rate would put
        // both crossovers at the wrong frequency at any other.
        if (sampleRate !== this.designedRate) {
            this.designCrossover();
            this.reset();
        }

        if (!input || input.length === 0) {
            for (let c = 0; c < channelCount; c++) output[c].fill(0);
            this.reset();
            return true;
        }

        const depth = parameters.depth[0];
        this.updateTiming(parameters.time[0]);

        const upAmount = this.upAmount;
        upAmount[0] = parameters.lowUp[0];
        upAmount[1] = parameters.midUp[0];
        upAmount[2] = parameters.highUp[0];

        const downAmount = this.downAmount;
        downAmount[0] = parameters.lowDown[0];
        downAmount[1] = parameters.midDown[0];
        downAmount[2] = parameters.highDown[0];

        const bandGainDb = this.bandGainDb;
        bandGainDb[0] = parameters.lowGainDb[0];
        bandGainDb[1] = parameters.midGainDb[0];
        bandGainDb[2] = parameters.highGainDb[0];

        // Makeup that puts a full-scale input back at full scale. Because the
        // curve is ours rather than the browser's, this cancels exactly within a
        // band instead of approximately. It does not cancel exactly at the
        // summed output: a tone in one band still leaves skirt energy in its
        // neighbour, and that neighbour applies its own makeup. The residual is
        // small and bounded, and it is inherent to per-band makeup.
        const makeupFullDb = -OttProcessor.downwardGainDb(0);

        const attackCoefficient = this.attackCoefficient;
        const releaseCoefficient = this.releaseCoefficient;

        const envelope = this.envelope;
        const floorEnvelope = this.floorEnvelope;
        const floorAttackCoefficient = this.floorAttackCoefficient;
        const floorReleaseCoefficient = this.floorReleaseCoefficient;
        const windowMax = this.windowMax;
        let sampleIndex = this.sampleIndex;
        const bandSample = this.bandSample;
        const bandGain = this.bandGain;
        const scratchLow = this.scratchLow;
        const scratchMid = this.scratchMid;
        const scratchHigh = this.scratchHigh;

        const lowLpA = this.lowSplitLp[0];
        const lowLpB = this.lowSplitLp[1];
        const lowHpA = this.lowSplitHp[0];
        const lowHpB = this.lowSplitHp[1];
        const highLpA = this.highSplitLp[0];
        const highLpB = this.highSplitLp[1];
        const highHpA = this.highSplitHp[0];
        const highHpB = this.highSplitHp[1];
        const allpass = this.lowAllpass;

        // Hoisted out of the frame loop: which input channels actually exist.
        const sourceChannels = Math.min(input.length, channelCount);

        for (let i = 0; i < frames; i++) {
            // Split every channel first, tracking the loudest magnitude in each
            // band so gain reduction stays linked and the stereo image holds.
            let lowPeak = 0;
            let midPeak = 0;
            let highPeak = 0;

            for (let c = 0; c < channelCount; c++) {
                let x = c < sourceChannels ? input[c][i] : 0;
                // A single NaN would poison every filter's state permanently.
                if (!(x === x)) x = 0;

                const lowMid = lowLpB.process(lowLpA.process(x, c), c);
                const upper = lowHpB.process(lowHpA.process(x, c), c);

                const low = allpass.process(lowMid, c);
                const mid = highLpB.process(highLpA.process(upper, c), c);
                const high = highHpB.process(highHpA.process(upper, c), c);

                const lowMag = low < 0 ? -low : low;
                const midMag = mid < 0 ? -mid : mid;
                const highMag = high < 0 ? -high : high;

                if (lowMag > lowPeak) lowPeak = lowMag;
                if (midMag > midPeak) midPeak = midMag;
                if (highMag > highPeak) highPeak = highMag;

                // Stash for the gain pass below; channel 0's values are needed
                // again, so keep the split output rather than recomputing it.
                scratchLow[c] = low;
                scratchMid[c] = mid;
                scratchHigh[c] = high;
            }

            bandSample[0] = lowPeak;
            bandSample[1] = midPeak;
            bandSample[2] = highPeak;

            for (let b = 0; b < BAND_COUNT; b++) {
                // The peak over the band's window, not the rectified sample,
                // so a steady tone reads as a steady level.
                const magnitude = windowMax[b].push(bandSample[b], sampleIndex);
                const previous = envelope[b];
                const coefficient = magnitude > previous ? attackCoefficient[b] : releaseCoefficient;
                let level = coefficient * previous + (1 - coefficient) * magnitude;
                // The one-pole tail goes subnormal on a fade to silence.
                if (level < LEVEL_EPSILON) level = 0;
                envelope[b] = level;

                const levelDb = Math.log(level + LEVEL_EPSILON) * DB_PER_LOG;

                const floorPrevious = floorEnvelope[b];
                const floorCoefficient = magnitude > floorPrevious
                    ? floorAttackCoefficient
                    : floorReleaseCoefficient;
                let floorLevel = floorCoefficient * floorPrevious + (1 - floorCoefficient) * magnitude;
                if (floorLevel < LEVEL_EPSILON) floorLevel = 0;
                floorEnvelope[b] = floorLevel;
                const floorDb = Math.log(floorLevel + LEVEL_EPSILON) * DB_PER_LOG;

                const down = OttProcessor.downwardGainDb(levelDb) * downAmount[b];
                const up = OttProcessor.upwardGainDb(levelDb) * upAmount[b];
                const makeup = makeupFullDb * downAmount[b];
                const positive = (up + makeup) * OttProcessor.floorFactor(floorDb);

                const totalDb = (down + positive) * depth + bandGainDb[b];
                bandGain[b] = dbToGain(totalDb);
            }

            const lowGain = bandGain[0];
            const midGain = bandGain[1];
            const highGain = bandGain[2];

            for (let c = 0; c < channelCount; c++) {
                output[c][i] = scratchLow[c] * lowGain
                    + scratchMid[c] * midGain
                    + scratchHigh[c] * highGain;
            }

            sampleIndex++;
        }

        this.sampleIndex = sampleIndex;
        return true;
    }
}

registerProcessor('thunderfox-ott', OttProcessor);
