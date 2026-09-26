'use strict';

/**
 * Test signal generators and measurements. Everything is mono Float32Array
 * in, numbers out; `stereo()` duplicates a signal for the processors, which
 * expect an array of channels.
 */

function dbToGain(db) {
    return Math.pow(10, db / 20);
}

function gainToDb(gain) {
    return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

function silence(seconds, rate) {
    return new Float32Array(Math.round(seconds * rate));
}

function tone(frequency, seconds, rate, amplitude) {
    const out = new Float32Array(Math.round(seconds * rate));
    const step = (2 * Math.PI * frequency) / rate;
    for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin(step * i);
    return out;
}

// One sample at `amplitude` after `offsetSeconds` of silence.
function impulse(seconds, rate, amplitude, offsetSeconds) {
    const out = new Float32Array(Math.round(seconds * rate));
    out[Math.round((offsetSeconds || 0) * rate)] = amplitude;
    return out;
}

// A tone whose amplitude switches between levels (in dB) at the given times,
// so attack and release can be read off the output envelope.
function steppedTone(frequency, rate, steps) {
    const total = steps[steps.length - 1].until;
    const out = new Float32Array(Math.round(total * rate));
    const step = (2 * Math.PI * frequency) / rate;
    let from = 0;
    steps.forEach((segment) => {
        const to = Math.round(segment.until * rate);
        const amplitude = dbToGain(segment.db);
        for (let i = from; i < to; i++) out[i] = amplitude * Math.sin(step * i);
        from = to;
    });
    return out;
}

// A kick every `beat` seconds (120 to 45 Hz sweep, 120 ms decay) and a 55 Hz
// bass note on the off-beat (300 ms decay). Most of what a low band sees.
function kickBass(seconds, rate, beat) {
    const period = beat || 0.5;
    const out = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < out.length; i++) {
        const t = i / rate;
        const tk = t % period;
        const phase = 2 * Math.PI * (45 * tk + 75 * 0.02 * (1 - Math.exp(-tk / 0.02)));
        const kick = 0.8 * Math.exp(-tk / 0.12) * Math.sin(phase);
        const tb = (t + period / 2) % period;
        const bass = 0.4 * Math.exp(-tb / 0.3) * Math.sin(2 * Math.PI * 55 * t);
        out[i] = kick + bass;
    }
    return out;
}

// A tone whose level wobbles: `centreDb` +/- `swingDb` at `wobbleHz`.
function wobblingTone(frequency, seconds, rate, centreDb, swingDb, wobbleHz) {
    const out = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < out.length; i++) {
        const t = i / rate;
        out[i] = dbToGain(centreDb + swingDb * Math.sin(2 * Math.PI * wobbleHz * t))
            * Math.sin(2 * Math.PI * frequency * t);
    }
    return out;
}

function concat(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Float32Array(length);
    let offset = 0;
    parts.forEach((part) => { out.set(part, offset); offset += part.length; });
    return out;
}

function stereo(mono) {
    return [mono, Float32Array.from(mono)];
}

/* ------------------------------------------------------------ measurement */

function peak(signal, from, to) {
    let max = 0;
    const end = to === undefined ? signal.length : to;
    for (let i = from || 0; i < end; i++) {
        const magnitude = signal[i] < 0 ? -signal[i] : signal[i];
        if (magnitude > max) max = magnitude;
    }
    return max;
}

function rms(signal, from, to) {
    const end = to === undefined ? signal.length : to;
    const start = from || 0;
    let sum = 0;
    for (let i = start; i < end; i++) sum += signal[i] * signal[i];
    return Math.sqrt(sum / Math.max(1, end - start));
}

function hasNonFinite(signal) {
    for (let i = 0; i < signal.length; i++) if (!isFinite(signal[i])) return true;
    return false;
}

// Goertzel power at one frequency over [from, to).
function power(signal, frequency, rate, from, to) {
    const end = to === undefined ? signal.length : to;
    const start = from || 0;
    const n = end - start;
    const k = Math.round((n * frequency) / rate);
    const w = (2 * Math.PI * k) / n;
    const coefficient = 2 * Math.cos(w);
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    for (let i = start; i < end; i++) {
        s0 = signal[i] + coefficient * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return (s1 * s1 + s2 * s2 - coefficient * s1 * s2) / (n * n);
}

// Total harmonic distortion in dB relative to the fundamental, harmonics 2..N.
function thdDb(signal, fundamental, rate, from, to, harmonics) {
    const base = power(signal, fundamental, rate, from, to);
    let sum = 0;
    for (let h = 2; h <= (harmonics || 10); h++) {
        if (fundamental * h >= rate / 2) break;
        sum += power(signal, fundamental * h, rate, from, to);
    }
    return base > 0 ? 10 * Math.log10(sum / base) : -Infinity;
}

/**
 * Output-over-input level per window, in dB: the gain trajectory a dynamics
 * stage applied. Levels are per-window peaks, which for a tone are exact
 * whenever the window is at least one period long and phase-independent
 * otherwise, unlike an RMS over a fraction of a cycle.
 */
function gainTrack(input, output, rate, windowSeconds) {
    const window = Math.max(1, Math.round(windowSeconds * rate));
    const track = [];
    for (let start = 0; start + window <= input.length; start += window) {
        const inLevel = peak(input, start, start + window);
        const outLevel = peak(output, start, start + window);
        track.push({
            time: start / rate,
            db: inLevel > 1e-9 ? gainToDb(outLevel / inLevel) : NaN
        });
    }
    return track;
}

/**
 * Time for the gain to cover 63% of the change between its value before
 * `stepTime` and its settled value from `settledTime` on. `skipSeconds`
 * after the step is ignored, because a level step leaves the crossover
 * filters ringing with the old level for a millisecond or so, which reads as
 * a spurious gain jump against the new input level.
 */
function timeConstant(track, stepTime, settledTime, skipSeconds) {
    const before = track.filter((p) => p.time >= stepTime - 0.02 && p.time < stepTime && !isNaN(p.db));
    const after = track.filter((p) => p.time >= settledTime && !isNaN(p.db));
    if (before.length === 0 || after.length === 0) return NaN;
    const mean = (list) => list.reduce((sum, p) => sum + p.db, 0) / list.length;
    const start = mean(before);
    const target = mean(after);
    const goal = start + 0.63 * (target - start);
    const rising = target > start;
    const from = stepTime + (skipSeconds || 0);
    for (const point of track) {
        if (point.time < from || isNaN(point.db)) continue;
        if (rising ? point.db >= goal : point.db <= goal) return point.time - stepTime;
    }
    return NaN;
}

/**
 * How rough a per-sample gain trajectory (in dB) is, ignoring the first
 * `settleSeconds`: the largest change between consecutive samples, and the
 * RMS of the trajectory above `cutoffHz`. A click is a large step; jitter is
 * energy well above the rate at which the music's level actually changes.
 */
function gainRoughness(gainDb, rate, settleSeconds, cutoffHz) {
    const skip = Math.round((settleSeconds || 0) * rate);
    const c = Math.exp((-2 * Math.PI * (cutoffHz || 15)) / rate);
    let maxStep = 0;
    let highpassed = 0;
    let sum = 0;
    let count = 0;
    for (let i = 1; i < gainDb.length; i++) {
        highpassed = c * (highpassed + gainDb[i] - gainDb[i - 1]);
        if (i < skip) continue;
        const step = Math.abs(gainDb[i] - gainDb[i - 1]);
        if (step > maxStep) maxStep = step;
        sum += highpassed * highpassed;
        count++;
    }
    return { maxStepDb: maxStep, modulationDb: count > 0 ? Math.sqrt(sum / count) : NaN };
}

function rippleDb(track, fromTime, toTime) {
    const points = track.filter((p) => p.time >= fromTime && p.time < toTime && !isNaN(p.db));
    if (points.length === 0) return NaN;
    let min = Infinity;
    let max = -Infinity;
    points.forEach((p) => { if (p.db < min) min = p.db; if (p.db > max) max = p.db; });
    return max - min;
}

module.exports = {
    dbToGain,
    gainToDb,
    silence,
    tone,
    impulse,
    steppedTone,
    kickBass,
    wobblingTone,
    concat,
    stereo,
    peak,
    rms,
    hasNonFinite,
    power,
    thdDb,
    gainTrack,
    timeConstant,
    gainRoughness,
    rippleDb
};
