'use strict';

/**
 * Three-band upward and downward ("OTT-style") multiband compressor.
 *
 * The band split is a 4th-order Linkwitz-Riley tree with an explicit allpass
 * on the low band so the three bands stay phase-coherent. LR4 is
 * two cascaded Butterworth sections at the same cutoff, and its two halves sum
 * to a second-order allpass rather than to unity:
 *
 *   LP_LR4 + HP_LR4 = (s^2 - sqrt2 s + 1) / (s^2 + sqrt2 s + 1)
 *
 * so the three bands sum to AP(f1) * AP(f2) — flat magnitude, no crossover
 * notch, no empirical band trim:
 *
 *   low  = LP4(f1) -> AP2(f2)
 *   mid  = HP4(f1) -> LP4(f2)
 *   high = HP4(f1) -> HP4(f2)
 *
 * Each band and channel runs two asymmetric one-pole envelopes on the SQUARED
 * sample (power domain) — one for the downward stage, one for the upward:
 *
 *   env' = (x^2 + env * N) / (N + 1),   N = attack or release, in samples
 *
 * The downward envelope is clamped to at least the upper threshold and the
 * upward envelope to at most the lower threshold, so each stage's gain is
 * exactly unity until its threshold is crossed — a hard knee in a smooth RMS
 * domain. The gain is a power-law of the envelope's distance from threshold:
 *
 *   down = (upperThreshold / envHigh) ^ (0.5 * downAmount)     <= 1
 *   up   = (lowerThreshold / envLow)  ^ (0.5 * upAmount)       >= 1
 *   gain = clamp(down * up, 0, 32)
 *
 * where the amounts are the per-band ratio scaled by Depth and the global
 * Upward/Downward multipliers, clamped to [0, 1]. An exponent of 0.5 on the
 * power ratio is a hard limit to the threshold; smaller is gentler.
 *
 * Channels are NOT linked: left and right compress independently. That
 * per-channel gain riding is part of the OTT-style sound.
 *
 * Per band, the output is a dry/wet blend of the band against its compressed,
 * gain-trimmed self (the Mix control), summed across bands:
 *
 *   out_band = in * (1 - mix) + in * gain * bandGain * mix
 *
 * Two behaviours specific to unattended web playback:
 *
 * - The band gain (the stock +16.3 / +11.7 / +16.3 dB makeup) is scaled by
 *   Depth, so Depth 0 is bit-exact bypass apart from the crossover's own
 *   allpass. The scaling is proportionate: the downward reduction of a
 *   full-scale signal also scales linearly with Depth.
 * - Upward compression cannot tell a quiet passage from a noise floor, so its
 *   exponent and the positive part of the band gain fade out below
 *   FLOOR_TOP_DB, driven by a slow envelope of their own. Without this,
 *   silence between tracks comes up by 30 dB plus makeup.
 */

// Stock crossover frequencies. The lowCrossHz/highCrossHz parameters move
// them; the split stays sum-flat wherever they sit, because the band sum is
// AP(f1) * AP(f2) for any pair.
const DEFAULT_LOW_CROSSOVER_HZ = 120;
const DEFAULT_HIGH_CROSSOVER_HZ = 5000;
const MIN_CROSSOVER_HZ = 20;
const MAX_CROSSOVER_HZ = 18000;

// Butterworth Q. Two of these cascaded is one Linkwitz-Riley 4th-order filter,
// and it is also the Q of the allpass their sum produces.
const BUTTERWORTH_Q = Math.SQRT1_2;

// Per-band envelope base times, scaled by the Attack/Release knobs.
const BASE_ATTACK_MS = [2.8, 1.4, 0.7];
const BASE_RELEASE_MS = [40, 28, 15];

// The attack/release knobs are exponential, exp(8t - 4), so 0.5 is the base
// time and the ends are 1/55x and 55x.
const KNOB_EXPONENT_SPAN = 8;
const KNOB_EXPONENT_OFFSET = -4;

// The envelope never moves faster than this many samples.
const MIN_ENVELOPE_SAMPLES = 5;

// The combined up*down gain is clamped here (+30 dB).
const MAX_EXPAND_MULT = 32;

// The gain is computed per sample from an envelope that ripples at twice the
// signal frequency; applying it raw amplitude-modulates the band, and above
// about 6 kHz the AM sidebands fold back below Nyquist as discrete inharmonic
// tones (worst measured spur: -65 dBc at 44.1 kHz). A 0.2 ms one-pole on the
// *applied* gain — decoupled from the detector, so attack/release switching
// is untouched — attenuates that ripple by 16-25 dB while leaving the
// transfer curve and the low band's intentional envelope grit (< 0.05 dB
// effect at 80 Hz) as they were.
const GAIN_SMOOTHING_SECONDS = 0.0002;

// OTT's stock thresholds per band, in dBFS. The upper threshold is where
// downward compression begins; the lower is where upward compression begins.
const UPPER_THRESHOLD_DB = [-28, -25, -30];
const LOWER_THRESHOLD_DB = [-35, -36, -35];

// The upward fade near silence. Between FLOOR_TOP_DB and FLOOR_BOTTOM_DB the
// upward exponent and the positive band gain scale down to nothing. The fade
// follows its own slow envelope rather than the band detector: driven by the
// fast detector it acted as an expander on quiet content, and a room tone or
// a reverb tail fluttered at the detector's rate. A 20 ms rise lets the first
// note after a gap open the band at once; the 400 ms fall means only a
// genuine pause closes it.
const FLOOR_TOP_DB = -60;
const FLOOR_BOTTOM_DB = -80;
const FLOOR_ATTACK_SECONDS = 0.02;
const FLOOR_RELEASE_SECONDS = 0.4;

const BAND_COUNT = 3;

const LOG_PER_DB = Math.LN10 / 20;

// Well below any real signal, so power-domain logs and divisions stay finite.
const POWER_EPSILON = 1e-20;

function dbToGain(db) {
    return Math.exp(db * LOG_PER_DB);
}

// Amplitude thresholds squared: the envelopes live in the power domain.
function dbToPower(db) {
    const g = dbToGain(db);
    return g * g;
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

/* --------------------------------------------------------- linear phase */

// The optional linear-phase band split: complementary FIR pairs instead of
// the IIR tree. The lowpass is a Hamming-windowed sinc; the highpass is
// never designed — it is the delayed input minus the lowpass, so each split
// is complementary by construction and the three bands sum to a PURE DELAY:
// exactly flat magnitude and exactly linear phase. With Dn = (taps_n - 1)/2:
//
//   stage1 (f1): lowWide = L1 * x       rest = x[n - D1] - lowWide
//   stage2 (f2): mid     = L2 * rest    high = rest[n - D2] - mid
//   low = lowWide delayed by D2
//   low + mid + high === x[n - D1 - D2]
//
// The cost is latency (D1 + D2 samples; 542 = ~11.3 ms at the stock
// crossovers at 48 kHz) and CPU: direct convolution is taps1 + taps2
// multiply-adds per sample per channel, ~104M madd/s for stereo 48 kHz at
// the stock 120 Hz / 5 kHz split and ~200M worst case with both crossovers
// low. That is why the mode is opt-in and default-off.
const FIR_TAP_STEPS = [63, 127, 255, 511, 1023];

// A Hamming window's transition band is about 3.3 * rate / taps wide, so
// 5.5 * rate / frequency keeps the transition within roughly +/-0.65 octave
// of the crossover. The cap bounds CPU and latency; below ~260 Hz the FIR
// edge is honestly looser than the IIR tree's. Quantised steps mean dragging
// a crossover only rebuilds the kernel at ~octave boundaries.
function firTapCount(frequency, rate) {
    const wanted = (5.5 * rate) / frequency;
    for (let i = 0; i < FIR_TAP_STEPS.length; i++) {
        if (FIR_TAP_STEPS[i] >= wanted) return FIR_TAP_STEPS[i];
    }
    return FIR_TAP_STEPS[FIR_TAP_STEPS.length - 1];
}

// Odd-length Hamming-windowed sinc lowpass, normalised so the coefficient
// sum is exactly 1 (0 dB at DC).
function designLowpassFir(frequency, taps, rate) {
    const kernel = new Float64Array(taps);
    const centre = (taps - 1) / 2;
    const normalized = Math.min(frequency / rate, 0.4999);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
        const n = i - centre;
        const sinc = n === 0
            ? 2 * normalized
            : Math.sin(2 * Math.PI * normalized * n) / (Math.PI * n);
        const window = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (taps - 1));
        kernel[i] = sinc * window;
        sum += kernel[i];
    }
    for (let i = 0; i < taps; i++) kernel[i] /= sum;
    return kernel;
}

/**
 * One FIR split. process() returns the lowpass of the input; delayed()
 * returns the input `centre` samples back, read from the same ring buffer,
 * so the highpass complement (delayed - lowpass) costs one subtraction.
 * All channels share one write position; advance() moves it once per frame,
 * after every channel has been processed.
 */
class FirSplitStage {
    constructor(frequency, rate) {
        this.taps = firTapCount(frequency, rate);
        this.centre = (this.taps - 1) / 2;
        this.kernel = designLowpassFir(frequency, this.taps, rate);
        this.history = new Float64Array(0);
        this.writeIndex = 0;
        this.channelCount = 0;
    }

    setChannelCount(count) {
        if (this.channelCount === count) return;
        this.channelCount = count;
        this.history = new Float64Array(this.taps * count);
        this.writeIndex = 0;
    }

    reset() {
        this.history.fill(0);
        this.writeIndex = 0;
    }

    process(x, channel) {
        const taps = this.taps;
        const kernel = this.kernel;
        const history = this.history;
        const base = channel * taps;
        const write = this.writeIndex;
        history[base + write] = x;
        // Dot product as two linear loops split at the write index: kernel[k]
        // multiplies the sample k frames back, no per-tap modulo.
        let acc = 0;
        let k = 0;
        for (let i = base + write; i >= base; i--, k++) acc += kernel[k] * history[i];
        for (let i = base + taps - 1; k < taps; i--, k++) acc += kernel[k] * history[i];
        return acc;
    }

    delayed(channel) {
        let index = this.writeIndex - this.centre;
        if (index < 0) index += this.taps;
        return this.history[channel * this.taps + index];
    }

    advance() {
        this.writeIndex = this.writeIndex + 1 === this.taps ? 0 : this.writeIndex + 1;
    }
}

// A plain delay, for holding the low band while the second split's FIR
// catches the other two up. Same shared-write-position contract as
// FirSplitStage: process() every channel, then advance() once.
class DelayLine {
    constructor(delaySamples) {
        this.delay = delaySamples;
        this.size = delaySamples + 1;
        this.buffer = new Float64Array(0);
        this.writeIndex = 0;
        this.channelCount = 0;
    }

    setChannelCount(count) {
        if (this.channelCount === count) return;
        this.channelCount = count;
        this.buffer = new Float64Array(this.size * count);
        this.writeIndex = 0;
    }

    reset() {
        this.buffer.fill(0);
        this.writeIndex = 0;
    }

    process(x, channel) {
        const base = channel * this.size;
        this.buffer[base + this.writeIndex] = x;
        let read = this.writeIndex - this.delay;
        if (read < 0) read += this.size;
        return this.buffer[base + read];
    }

    advance() {
        this.writeIndex = this.writeIndex + 1 === this.size ? 0 : this.writeIndex + 1;
    }
}

class OttProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        // Input and output trims are GainNodes in the host graph (pre-boost
        // ahead, limiter drive behind), so the worklet does not duplicate them.
        const descriptors = [
            { name: 'depth', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'mix', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'attack', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'release', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
            { name: 'upward', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
            { name: 'downward', defaultValue: 1, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
            { name: 'lowCrossHz', defaultValue: DEFAULT_LOW_CROSSOVER_HZ, minValue: MIN_CROSSOVER_HZ, maxValue: MAX_CROSSOVER_HZ, automationRate: 'k-rate' },
            { name: 'highCrossHz', defaultValue: DEFAULT_HIGH_CROSSOVER_HZ, minValue: MIN_CROSSOVER_HZ, maxValue: MAX_CROSSOVER_HZ, automationRate: 'k-rate' },
            // Structural 0/1 switch (worklet parameters are floats); the host
            // steps it, never ramps it. See the linear-phase section above.
            { name: 'linearPhase', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
        ];

        // Per band: Up is the upward (lower-threshold) ratio, Down the
        // downward (upper-threshold) ratio, Gain the output trim. Defaults are
        // OTT's stock preset.
        const upDefaults = [0.8, 0.8, 0.8];
        const downDefaults = [0.9, 0.857, 1.0];
        const gainDefaults = [16.3, 11.7, 16.3];

        ['low', 'mid', 'high'].forEach((band, index) => {
            descriptors.push(
                { name: `${band}Up`, defaultValue: upDefaults[index], minValue: 0, maxValue: 1, automationRate: 'k-rate' },
                { name: `${band}Down`, defaultValue: downDefaults[index], minValue: 0, maxValue: 1, automationRate: 'k-rate' },
                { name: `${band}GainDb`, defaultValue: gainDefaults[index], minValue: -30, maxValue: 30, automationRate: 'k-rate' }
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

        // Detector state: one downward and one upward envelope per band per
        // channel, indexed band * channelCount + channel. Power domain.
        this.envHigh = new Float64Array(0);
        this.envLow = new Float64Array(0);

        // The applied-gain smoother's state, same indexing. Gain domain.
        this.smoothedGain = new Float64Array(0);
        this.gainSmoothingCoefficient = 0;

        // The floor fade's slow envelope, per band, linked across channels.
        this.floorEnvelope = new Float64Array(BAND_COUNT);
        this.floorAttackCoefficient = 0;
        this.floorReleaseCoefficient = 0;

        // Channel 0's gain per band, for tests and metering. Not used by the
        // audio path, which keeps per-channel gains in scratch.
        this.bandGain = new Float64Array(BAND_COUNT).fill(1);

        // The linear-phase splitter is only built when the mode is switched
        // on; until then it costs nothing.
        this.linearPhase = false;
        this.firStage1 = null;
        this.firStage2 = null;
        this.lowDelay = null;
        this.firLatencySamples = 0;

        this.lowCrossoverHz = DEFAULT_LOW_CROSSOVER_HZ;
        this.highCrossoverHz = DEFAULT_HIGH_CROSSOVER_HZ;
        this.designCrossover();

        // Scratch, so the per-sample loop allocates nothing. The split output
        // is held per channel because the gain pass reuses it.
        this.scratchLow = new Float64Array(0);
        this.scratchMid = new Float64Array(0);
        this.scratchHigh = new Float64Array(0);

        // Per-block parameter working sets, preallocated.
        this.attackSamples = new Float64Array(BAND_COUNT);
        this.releaseSamples = new Float64Array(BAND_COUNT);
        this.downExponent = new Float64Array(BAND_COUNT);
        this.upExponent = new Float64Array(BAND_COUNT);
        this.bandGainDb = new Float64Array(BAND_COUNT);
        this.bandOutMult = new Float64Array(BAND_COUNT);
        this.upperPower = new Float64Array(BAND_COUNT);
        this.lowerPower = new Float64Array(BAND_COUNT);
        for (let b = 0; b < BAND_COUNT; b++) {
            this.upperPower[b] = dbToPower(UPPER_THRESHOLD_DB[b]);
            this.lowerPower[b] = dbToPower(LOWER_THRESHOLD_DB[b]);
        }

        this.lastAttack = -1;
        this.lastRelease = -1;

        this.port.onmessage = (event) => {
            if (event.data && event.data.type === 'reset') this.reset();
        };
    }

    designCrossover() {
        this.designedRate = sampleRate;
        // The knob coefficients are in samples, so they are stale at a new
        // rate too; force updateTiming() to recompute them next quantum.
        this.lastAttack = -1;
        this.lastRelease = -1;
        this.floorAttackCoefficient = Math.exp(-1 / (FLOOR_ATTACK_SECONDS * sampleRate));
        this.floorReleaseCoefficient = Math.exp(-1 / (FLOOR_RELEASE_SECONDS * sampleRate));
        this.gainSmoothingCoefficient = Math.exp(-1 / (GAIN_SMOOTHING_SECONDS * sampleRate));
        const lowHz = this.lowCrossoverHz;
        const highHz = this.highCrossoverHz;
        this.lowSplitLp.forEach((section) => section.setLowpass(lowHz, BUTTERWORTH_Q, sampleRate));
        this.lowSplitHp.forEach((section) => section.setHighpass(lowHz, BUTTERWORTH_Q, sampleRate));
        this.highSplitLp.forEach((section) => section.setLowpass(highHz, BUTTERWORTH_Q, sampleRate));
        this.highSplitHp.forEach((section) => section.setHighpass(highHz, BUTTERWORTH_Q, sampleRate));
        this.lowAllpass.setAllpass(highHz, BUTTERWORTH_Q, sampleRate);
        if (this.linearPhase) this.designFir();
    }

    // (Re)build the FIR splitter for the current crossovers. A rebuild
    // changes tap counts and therefore latency, so a crossover drag in
    // linear-phase mode can click at a tap-count boundary; a crossfade
    // between two full splitters would double the CPU, which is not worth a
    // transient on a control that is rarely moved.
    designFir() {
        this.firStage1 = new FirSplitStage(this.lowCrossoverHz, sampleRate);
        this.firStage2 = new FirSplitStage(this.highCrossoverHz, sampleRate);
        this.lowDelay = new DelayLine(this.firStage2.centre);
        this.firLatencySamples = this.firStage1.centre + this.firStage2.centre;
        if (this.channelCount > 0) {
            this.firStage1.setChannelCount(this.channelCount);
            this.firStage2.setChannelCount(this.channelCount);
            this.lowDelay.setChannelCount(this.channelCount);
        }
    }

    reset() {
        this.sections.forEach((section) => section.reset());
        if (this.firStage1) {
            this.firStage1.reset();
            this.firStage2.reset();
            this.lowDelay.reset();
        }
        // The downward envelope idles at its threshold clamp, the upward one
        // at zero; both are where a long silence would leave them.
        for (let b = 0; b < BAND_COUNT; b++) {
            for (let c = 0; c < this.channelCount; c++) {
                this.envHigh[b * this.channelCount + c] = this.upperPower[b];
                this.envLow[b * this.channelCount + c] = 0;
            }
        }
        this.floorEnvelope.fill(0);
        this.bandGain.fill(1);
        this.smoothedGain.fill(1);
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
        if (this.firStage1) {
            this.firStage1.setChannelCount(count);
            this.firStage2.setChannelCount(count);
            this.lowDelay.setChannelCount(count);
        }
        this.envHigh = new Float64Array(BAND_COUNT * count);
        this.envLow = new Float64Array(BAND_COUNT * count);
        this.smoothedGain = new Float64Array(BAND_COUNT * count);
        this.reset();
    }

    // Only recomputed when a knob moves; never per sample.
    updateTiming(attack, release) {
        if (attack === this.lastAttack && release === this.lastRelease) return;
        this.lastAttack = attack;
        this.lastRelease = release;

        const samplesPerMs = sampleRate / 1000;
        const attackScale = Math.exp(attack * KNOB_EXPONENT_SPAN + KNOB_EXPONENT_OFFSET);
        const releaseScale = Math.exp(release * KNOB_EXPONENT_SPAN + KNOB_EXPONENT_OFFSET);

        for (let b = 0; b < BAND_COUNT; b++) {
            this.attackSamples[b] = Math.max(
                MIN_ENVELOPE_SAMPLES, BASE_ATTACK_MS[b] * samplesPerMs * attackScale);
            this.releaseSamples[b] = Math.max(
                MIN_ENVELOPE_SAMPLES, BASE_RELEASE_MS[b] * samplesPerMs * releaseScale);
        }
    }

    /**
     * How much of the upward action survives at this level: 1 above
     * FLOOR_TOP_DB, 0 below FLOOR_BOTTOM_DB. `powerLevel` is the slow floor
     * envelope, in the power domain, so 10*log10 is amplitude dB.
     */
    static floorFactor(powerLevel) {
        const db = 10 * Math.log10(powerLevel + POWER_EPSILON);
        if (db >= FLOOR_TOP_DB) return 1;
        if (db <= FLOOR_BOTTOM_DB) return 0;
        return (db - FLOOR_BOTTOM_DB) / (FLOOR_TOP_DB - FLOOR_BOTTOM_DB);
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

        // Structural mode switch. Both splitters start clean on a toggle:
        // entering builds the FIR stages, and leaving must not replay the IIR
        // tree's stale state from before the mode switch.
        const wantLinearPhase = parameters.linearPhase[0] >= 0.5;
        if (wantLinearPhase !== this.linearPhase) {
            this.linearPhase = wantLinearPhase;
            if (wantLinearPhase) this.designFir();
            this.reset();
        }

        // Crossover moves retune the coefficients in place, keeping the filter
        // state: dragging the slider steps the split once per quantum, and a
        // TDF2 section rides a coefficient step far more gracefully than the
        // click a state reset would put out.
        let lowCross = parameters.lowCrossHz[0];
        let highCross = parameters.highCrossHz[0];
        // The UI and the sanitiser both keep low <= high; this is the last
        // line of defence for a host that does not.
        if (lowCross > highCross) {
            const swapped = lowCross;
            lowCross = highCross;
            highCross = swapped;
        }
        if (lowCross !== this.lowCrossoverHz || highCross !== this.highCrossoverHz) {
            this.lowCrossoverHz = lowCross;
            this.highCrossoverHz = highCross;
            this.designCrossover();
        }

        const depth = parameters.depth[0];
        const mix = parameters.mix[0];
        const upward = parameters.upward[0];
        const downward = parameters.downward[0];
        this.updateTiming(parameters.attack[0], parameters.release[0]);

        // The effective ratio is the per-band ratio times Depth times the
        // global direction multiplier, clamped to [0, 1], and the
        // power-domain exponent is half that.
        const downExponent = this.downExponent;
        downExponent[0] = 0.5 * Math.min(1, Math.max(0, parameters.lowDown[0] * depth * downward));
        downExponent[1] = 0.5 * Math.min(1, Math.max(0, parameters.midDown[0] * depth * downward));
        downExponent[2] = 0.5 * Math.min(1, Math.max(0, parameters.highDown[0] * depth * downward));

        const upExponent = this.upExponent;
        upExponent[0] = 0.5 * Math.min(1, Math.max(0, parameters.lowUp[0] * depth * upward));
        upExponent[1] = 0.5 * Math.min(1, Math.max(0, parameters.midUp[0] * depth * upward));
        upExponent[2] = 0.5 * Math.min(1, Math.max(0, parameters.highUp[0] * depth * upward));

        // Band gain, scaled by Depth (see the header). The positive part also
        // fades with the floor factor; the full-level multiplier is cached and
        // recomputed per sample only while a fade is in progress.
        const bandGainDb = this.bandGainDb;
        bandGainDb[0] = parameters.lowGainDb[0] * depth;
        bandGainDb[1] = parameters.midGainDb[0] * depth;
        bandGainDb[2] = parameters.highGainDb[0] * depth;
        const bandOutMult = this.bandOutMult;
        for (let b = 0; b < BAND_COUNT; b++) bandOutMult[b] = dbToGain(bandGainDb[b]);

        const attackSamples = this.attackSamples;
        const releaseSamples = this.releaseSamples;
        const upperPower = this.upperPower;
        const lowerPower = this.lowerPower;
        const envHigh = this.envHigh;
        const envLow = this.envLow;
        const floorEnvelope = this.floorEnvelope;
        const floorAttackCoefficient = this.floorAttackCoefficient;
        const floorReleaseCoefficient = this.floorReleaseCoefficient;
        const scratchLow = this.scratchLow;
        const scratchMid = this.scratchMid;
        const scratchHigh = this.scratchHigh;
        const bandGain = this.bandGain;
        const smoothedGain = this.smoothedGain;
        const gainSmoothing = this.gainSmoothingCoefficient;
        const dry = 1 - mix;

        const lowLpA = this.lowSplitLp[0];
        const lowLpB = this.lowSplitLp[1];
        const lowHpA = this.lowSplitHp[0];
        const lowHpB = this.lowSplitHp[1];
        const highLpA = this.highSplitLp[0];
        const highLpB = this.highSplitLp[1];
        const highHpA = this.highSplitHp[0];
        const highHpB = this.highSplitHp[1];
        const allpass = this.lowAllpass;

        const linearPhase = this.linearPhase;
        const firStage1 = this.firStage1;
        const firStage2 = this.firStage2;
        const lowDelay = this.lowDelay;

        // Hoisted out of the frame loop: which input channels actually exist.
        const sourceChannels = Math.min(input.length, channelCount);

        for (let i = 0; i < frames; i++) {
            // Split every channel first, tracking the loudest power in each
            // band; the floor fade is linked so a pause closes all channels
            // together.
            let lowPeak = 0;
            let midPeak = 0;
            let highPeak = 0;

            for (let c = 0; c < channelCount; c++) {
                let x = c < sourceChannels ? input[c][i] : 0;
                // A single NaN would poison every filter's state permanently.
                if (!(x === x)) x = 0;

                let low;
                let mid;
                let high;
                if (linearPhase) {
                    const lowWide = firStage1.process(x, c);
                    const rest = firStage1.delayed(c) - lowWide;
                    mid = firStage2.process(rest, c);
                    high = firStage2.delayed(c) - mid;
                    low = lowDelay.process(lowWide, c);
                } else {
                    const lowMid = lowLpB.process(lowLpA.process(x, c), c);
                    const upper = lowHpB.process(lowHpA.process(x, c), c);

                    low = allpass.process(lowMid, c);
                    mid = highLpB.process(highLpA.process(upper, c), c);
                    high = highHpB.process(highHpA.process(upper, c), c);
                }

                scratchLow[c] = low;
                scratchMid[c] = mid;
                scratchHigh[c] = high;

                const lowPower = low * low;
                const midPower = mid * mid;
                const highPower = high * high;
                if (lowPower > lowPeak) lowPeak = lowPower;
                if (midPower > midPeak) midPeak = midPower;
                if (highPower > highPeak) highPeak = highPower;
            }

            if (linearPhase) {
                firStage1.advance();
                firStage2.advance();
                lowDelay.advance();
            }

            for (let c = 0; c < channelCount; c++) output[c][i] = 0;

            for (let b = 0; b < BAND_COUNT; b++) {
                const peak = b === 0 ? lowPeak : b === 1 ? midPeak : highPeak;
                const scratch = b === 0 ? scratchLow : b === 1 ? scratchMid : scratchHigh;

                // The slow floor envelope and its fade factor, per band.
                const floorPrevious = floorEnvelope[b];
                const floorCoefficient = peak > floorPrevious
                    ? floorAttackCoefficient
                    : floorReleaseCoefficient;
                let floorLevel = floorCoefficient * floorPrevious + (1 - floorCoefficient) * peak;
                if (floorLevel < POWER_EPSILON) floorLevel = 0;
                floorEnvelope[b] = floorLevel;
                const factor = OttProcessor.floorFactor(floorLevel);

                const upExp = upExponent[b] * factor;
                const downExp = downExponent[b];
                const upperP = upperPower[b];
                const lowerP = lowerPower[b];
                const attackN = attackSamples[b];
                const releaseN = releaseSamples[b];
                const outMult = factor === 1 || bandGainDb[b] <= 0
                    ? bandOutMult[b]
                    : dbToGain(bandGainDb[b] * factor);

                const base = b * channelCount;
                for (let c = 0; c < channelCount; c++) {
                    const sample = scratch[c];
                    const power = sample * sample;

                    // Downward stage: envelope clamped to at least the upper
                    // threshold, so its gain is unity until the band exceeds it.
                    let eh = envHigh[base + c];
                    const nh = power > eh ? attackN : releaseN;
                    eh = (power + eh * nh) / (nh + 1);
                    if (eh < upperP) eh = upperP;
                    envHigh[base + c] = eh;

                    let gain = 1;
                    if (downExp > 0 && eh > upperP) {
                        gain = Math.pow(upperP / eh, downExp);
                    }

                    // Upward stage: envelope clamped to at most the lower
                    // threshold, so its gain is unity until the band falls
                    // below it.
                    let el = envLow[base + c];
                    const nl = power > el ? attackN : releaseN;
                    el = (power + el * nl) / (nl + 1);
                    if (el > lowerP) el = lowerP;
                    if (el < POWER_EPSILON) el = 0;
                    envLow[base + c] = el;

                    if (upExp > 0 && el < lowerP) {
                        gain *= Math.pow(lowerP / (el + POWER_EPSILON), upExp);
                    }

                    if (gain > MAX_EXPAND_MULT) gain = MAX_EXPAND_MULT;

                    // Smooth the applied gain (see GAIN_SMOOTHING_SECONDS):
                    // the detector above stays raw so its attack/release
                    // switching is unchanged; only the multiplier the band is
                    // ridden by loses its supersonic ripple.
                    gain = smoothedGain[base + c] =
                        gainSmoothing * smoothedGain[base + c] + (1 - gainSmoothing) * gain;

                    if (c === 0) bandGain[b] = gain * outMult;

                    output[c][i] += sample * (dry + mix * gain * outMult);
                }
            }
        }

        return true;
    }
}

registerProcessor('thunderfox-ott', OttProcessor);
