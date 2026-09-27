'use strict';

/**
 * Offline tests for the two worklets. Run with `npm test` or `node tests/run.js`.
 *
 * Each test drives a processor with a generated signal (tone, stepped tone,
 * impulse) and checks a property that should hold regardless of tuning: the
 * limiter never exceeds its ceiling, latency is what the node reports, depth 0
 * is transparent, the Time knob actually moves the time constants, and so on.
 * Measured numbers are printed alongside so tuning changes can be compared.
 */

const { loadProcessor } = require('./harness');
const S = require('./signals');

const RATE = 48000;

const ott = loadProcessor('content/ott-processor.js', RATE);
const limiter = loadProcessor('content/limiter-processor.js', RATE);

let failures = 0;
let passes = 0;

function check(name, condition, detail) {
    const status = condition ? 'PASS' : 'FAIL';
    if (condition) passes++; else failures++;
    console.log(`${status}  ${name}${detail ? `  (${detail})` : ''}`);
}

function note(text) {
    console.log(`      ${text}`);
}

function fmt(value, digits) {
    return isFinite(value) ? value.toFixed(digits === undefined ? 2 : digits) : String(value);
}

/* ----------------------------------------------------------------- limiter */

console.log('\n== Limiter ==');

const CEILING_DB = -0.3;
const CEILING = S.dbToGain(CEILING_DB);

{
    // A tone 12 dB over the ceiling must come out at or under the ceiling,
    // sample for sample, with ISP on and off.
    [1, 0].forEach((isp) => {
        const input = S.tone(1000, 1, RATE, S.dbToGain(CEILING_DB + 12));
        const out = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, isp })[0];
        const max = S.peak(out, RATE * 0.1);
        check(`ceiling holds on a +12 dB tone (isp=${isp})`, max <= CEILING * (1 + 1e-4) && !S.hasNonFinite(out),
            `peak ${fmt(S.gainToDb(max), 3)} dBFS vs ceiling ${CEILING_DB}`);
    });
}

{
    // Isolated full-scale impulses, 12 dB over: none may pass the ceiling and
    // the delay must match the reported latency.
    const input = S.concat([
        S.impulse(0.2, RATE, S.dbToGain(11.7), 0.1),
        S.impulse(0.2, RATE, -S.dbToGain(11.7), 0.1)
    ]);
    const processor = limiter.create();
    const reported = processor.port.posted.find((m) => m.type === 'latency');
    const out = limiter.run(processor, S.stereo(input), { ceiling: CEILING })[0];

    let argmax = 0;
    for (let i = 0; i < out.length / 2; i++) if (Math.abs(out[i]) > Math.abs(out[argmax])) argmax = i;
    const measuredLatency = argmax - Math.round(0.1 * RATE);
    check('impulse stays under the ceiling', S.peak(out) <= CEILING * (1 + 1e-4),
        `peak ${fmt(S.gainToDb(S.peak(out)), 3)} dBFS`);
    check('measured latency matches the reported latency', reported && measuredLatency === reported.samples,
        `${measuredLatency} samples measured, ${reported ? reported.samples : '?'} reported`);
}

{
    // Release: a 12 dB-over burst then a tone just under the ceiling. The gain
    // should be back within 1% of unity roughly `release` seconds after the
    // burst ends, at every release setting. The control is defined as the
    // time to 99% recovery, so a wide tolerance around 1.0x is the check.
    [0.05, 0.12, 0.5, 1.0].forEach((release) => {
        const input = S.steppedTone(1000, RATE, [
            { db: -20.3, until: 0.2 },
            { db: 11.7, until: 0.7 },
            { db: -20.3, until: 0.7 + release * 2 + 0.5 }
        ]);
        const out = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, release })[0];
        const track = S.gainTrack(input, out, RATE, 0.001);
        const settled = track.find((p) => p.time > 0.7 + 0.01 && p.db > -0.1);
        const recovered = settled ? settled.time - 0.7 : NaN;
        check(`release ${release}s recovers in about that time`, isFinite(recovered) && recovered > release * 0.5 && recovered < release * 1.5,
            `99% recovery after ${fmt(recovered, 3)} s`);
    });
}

{
    // Sustained bass through a heavily driven limiter. What the ear calls
    // jitter or roughness is gain moving within a cycle, which shows up as
    // harmonic distortion of a pure tone. The Loudness macro drives the
    // limiter by up to 24 dB, so 12 dB over is a normal operating point.
    [0.12, 0.5].forEach((release) => {
        [40, 80, 200].forEach((frequency) => {
            const input = S.tone(frequency, 2, RATE, S.dbToGain(CEILING_DB + 12));
            const out = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, release })[0];
            const thd = S.thdDb(out, frequency, RATE, RATE, 2 * RATE);
            check(`driven ${frequency} Hz, release ${release}s: ceiling holds and distortion under -50 dB`,
                S.peak(out, RATE) <= CEILING * (1 + 1e-4) && thd < -50,
                `THD ${fmt(thd, 1)} dB`);
        });
    });
}

{
    // A transient on top of a steady tone: the gain must dip for the hit and
    // then come back, not stay down. Checks that hold and release do not
    // latch under a continuous signal.
    const bed = S.tone(1000, 1.5, RATE, S.dbToGain(CEILING_DB - 6));
    const hit = S.impulse(1.5, RATE, S.dbToGain(CEILING_DB + 6), 0.5);
    const input = new Float32Array(bed.length);
    for (let i = 0; i < input.length; i++) input[i] = bed[i] + hit[i];
    const out = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING })[0];
    const track = S.gainTrack(input, out, RATE, 0.001);
    const during = track.find((p) => p.time >= 0.5 && p.time < 0.51);
    const later = track.find((p) => p.time >= 1.0);
    check('gain dips for a transient and recovers on a steady bed', during && later && during.db < -3 && later.db > -0.1,
        `dip ${fmt(during ? during.db : NaN, 1)} dB, ${fmt(later ? later.db : NaN, 2)} dB half a second later`);
}

/* --------------------------------------------------------------------- OTT */

console.log('\n== OTT ==');

{
    // Depth 0 must be transparent in level at every band: the split sums to an
    // allpass pair, so magnitude is flat, the ratios scale to zero and the
    // band gains (which scale with depth) go to 0 dB.
    [40, 120, 300, 1000, 2500, 8000].forEach((frequency) => {
        const input = S.tone(frequency, 1, RATE, S.dbToGain(-12));
        const out = ott.run(ott.create(), S.stereo(input), { depth: 0 })[0];
        const error = S.gainToDb(S.rms(out, RATE / 2) / S.rms(input, RATE / 2));
        check(`depth 0 is flat at ${frequency} Hz`, Math.abs(error) < 0.15 && !S.hasNonFinite(out),
            `${fmt(error, 3)} dB`);
    });
}

{
    // Moving the crossovers must not break the flat sum: the three bands
    // reconstruct to AP(f1) * AP(f2) wherever f1 and f2 sit.
    [40, 300, 1000, 8000].forEach((frequency) => {
        const input = S.tone(frequency, 1, RATE, S.dbToGain(-12));
        const out = ott.run(ott.create(), S.stereo(input),
            { depth: 0, lowCrossHz: 250, highCrossHz: 6000 })[0];
        const error = S.gainToDb(S.rms(out, RATE / 2) / S.rms(input, RATE / 2));
        check(`depth 0 is flat at ${frequency} Hz with crossovers at 250/6000`, Math.abs(error) < 0.15 && !S.hasNonFinite(out),
            `${fmt(error, 3)} dB`);
    });
}

{
    // The crossover parameters actually move the split. A 300 Hz tone sits in
    // the mid band at the stock 120/5000 Hz split; raising the low crossover
    // to 600 Hz moves it into the low band. The per-band floor envelope says
    // where the energy landed.
    const input = S.tone(300, 1, RATE, S.dbToGain(-12));
    const bandLevels = (params) => {
        const processor = ott.create();
        ott.run(processor, S.stereo(input), params);
        return Array.from(processor.floorEnvelope);
    };
    const stock = bandLevels({ depth: 1 });
    const moved = bandLevels({ depth: 1, lowCrossHz: 600 });
    check('300 Hz lands in the mid band at the stock crossover', stock[1] > stock[0] * 10,
        `low ${fmt(10 * Math.log10(stock[0] + 1e-20), 1)} dB vs mid ${fmt(10 * Math.log10(stock[1] + 1e-20), 1)} dB`);
    check('raising the low crossover to 600 Hz moves 300 Hz into the low band', moved[0] > moved[1] * 10,
        `low ${fmt(10 * Math.log10(moved[0] + 1e-20), 1)} dB vs mid ${fmt(10 * Math.log10(moved[1] + 1e-20), 1)} dB`);
}

{
    // An impulse must come out finite and settle.
    const input = S.impulse(0.5, RATE, 0.9, 0.1);
    const out = ott.run(ott.create(), S.stereo(input), { depth: 1 })[0];
    check('impulse response is finite and decays', !S.hasNonFinite(out) && S.peak(out, Math.round(0.4 * RATE)) < 1e-3,
        `tail peak ${fmt(S.gainToDb(S.peak(out, Math.round(0.4 * RATE))), 1)} dBFS`);
}

{
    // The OTT transfer curve: quiet content comes up, loud content comes
    // down, so the level range shrinks. A -50 dB mid-band tone sits below the
    // lower threshold and must be boosted well past its makeup; the span
    // between a -50 dB and a -6 dB input must come out much narrower.
    const quiet = S.tone(1000, 2, RATE, S.dbToGain(-50));
    const loud = S.tone(1000, 2, RATE, S.dbToGain(-6));
    const quietOut = ott.run(ott.create(), S.stereo(quiet), { depth: 1 })[0];
    const loudOut = ott.run(ott.create(), S.stereo(loud), { depth: 1 })[0];
    const quietGain = S.gainToDb(S.rms(quietOut, RATE) / S.rms(quiet, RATE));
    const loudGain = S.gainToDb(S.rms(loudOut, RATE) / S.rms(loud, RATE));
    const rangeIn = 44;
    const rangeOut = rangeIn + loudGain - quietGain;
    check('upward compression lifts a -50 dB tone above its makeup', quietGain > 13,
        `${fmt(quietGain, 1)} dB (makeup alone is 11.7)`);
    check('the -50..-6 dB range is compressed', rangeOut < rangeIn - 8,
        `${fmt(rangeIn, 0)} dB in -> ${fmt(rangeOut, 1)} dB out`);
}

{
    // The Attack and Release knobs: a level step up (attack) and down
    // (release) in the mid band. The 63% time must grow with the knob, and by
    // a lot: each knob spans exp(±4), about 55x each way off the band's base
    // time. The gain is read from the processor after each render quantum
    // rather than inferred from the output; resolution is one quantum, 2.7 ms.
    const attacks = [0, 0.5, 1].map((attack) => {
        const input = S.steppedTone(1000, RATE, [
            { db: -40, until: 1.0 },
            { db: -6, until: 2.5 }
        ]);
        const track = [];
        ott.run(ott.create(), S.stereo(input), { depth: 1, attack }, (processor, start) => {
            track.push({ time: start / RATE, db: S.gainToDb(processor.bandGain[1]) });
        });
        return S.timeConstant(track, 1.0, 2.4, 0);
    });
    const releases = [0, 0.5, 1].map((release) => {
        const input = S.steppedTone(1000, RATE, [
            { db: -6, until: 1.0 },
            { db: -40, until: 6.0 }
        ]);
        const track = [];
        ott.run(ott.create(), S.stereo(input), { depth: 1, release }, (processor, start) => {
            track.push({ time: start / RATE, db: S.gainToDb(processor.bandGain[1]) });
        });
        return S.timeConstant(track, 1.0, 5.5, 0);
    });
    note(`attack knob 0/0.5/1: ${attacks.map((a) => `${fmt(a * 1000, 1)} ms`).join(', ')}`);
    note(`release knob 0/0.5/1: ${releases.map((r) => `${fmt(r * 1000, 1)} ms`).join(', ')}`);
    const monotonic = (list) => list.every((v, i) => i === 0 || v >= list[i - 1]);
    check('Attack knob lengthens attack monotonically', monotonic(attacks) && attacks[2] > attacks[0] * 10,
        `${fmt(attacks[0] * 1000, 1)} ms -> ${fmt(attacks[2] * 1000, 1)} ms`);
    check('Release knob lengthens release monotonically', monotonic(releases) && releases[2] > releases[0] * 10,
        `${fmt(releases[0] * 1000, 1)} ms -> ${fmt(releases[2] * 1000, 1)} ms`);
}

{
    // Steady-tone distortion per band at the default knobs. The detector
    // envelope is an asymmetric one-pole on the squared sample, so it ripples
    // at twice the tone frequency — that grit is part of the OTT sound and
    // the bounds say how much of it is normal, not that it is absent. The
    // low band's 40 ms base release against a 40 Hz half-period is the worst
    // case; higher bands smooth their ripple far below audibility.
    [
        { f: 40, band: 'low', bound: -18 },
        { f: 60, band: 'low', bound: -22 },
        { f: 120, band: 'mid', bound: -30 },
        { f: 300, band: 'mid', bound: -35 },
        { f: 8000, band: 'high', bound: -40 }
    ].forEach(({ f, band, bound }) => {
        const input = S.tone(f, 2, RATE, S.dbToGain(-12));
        const out = ott.run(ott.create(), S.stereo(input), { depth: 1 })[0];
        const thd = S.thdDb(out, f, RATE, RATE, 2 * RATE);
        check(`${band} band ${f} Hz at default knobs: distortion under ${bound} dB`, thd < bound,
            `THD ${fmt(thd, 1)} dB`);
    });
}

{
    // A kick and bass pattern, low band gain read every sample. The detector
    // envelope takes multiplicative steps, so a kick onset moves the gain by
    // a few dB per sample at the start of the attack — that snap is the OTT
    // attack. What must not happen is an unbounded step or a non-finite gain.
    const input = S.kickBass(3, RATE);
    [{ depth: 0.5 }, { depth: 1 }].forEach((cfg) => {
        const gain = new Float32Array(input.length);
        let finite = true;
        ott.run(ott.create(), S.stereo(input), cfg, (processor, i) => {
            gain[i] = S.gainToDb(processor.bandGain[0]);
            if (!isFinite(gain[i])) finite = false;
        }, 1);
        const rough = S.gainRoughness(gain, RATE, 1, 15);
        check(`kick and bass, depth ${cfg.depth}: low band gain stays bounded`, finite && rough.maxStepDb < 8,
            `max ${fmt(rough.maxStepDb, 2)} dB/sample, ${fmt(rough.modulationDb, 2)} dB rms above 15 Hz`);
    });
}

{
    // Quiet, wobbling low-band content, like a room tone or a reverb tail.
    // The upward stage legitimately counters the wobble now, but the fade
    // near the floor must not turn it into an expander: the output's level
    // swing may not exceed the input's.
    const input = S.wobblingTone(40, 4, RATE, -65, 6, 5);
    const levelSwing = (signal) => {
        const window = Math.round(0.05 * RATE);
        let min = Infinity;
        let max = -Infinity;
        for (let start = 2 * RATE; start + window <= signal.length; start += window) {
            const db = S.gainToDb(S.rms(signal, start, start + window));
            if (db < min) min = db;
            if (db > max) max = db;
        }
        return max - min;
    };
    const inSwing = levelSwing(input);
    [0.5, 1].forEach((depth) => {
        const out = ott.run(ott.create(), S.stereo(input), { depth })[0];
        const outSwing = levelSwing(out);
        check(`quiet wobbling bass, depth ${depth}: output swing does not exceed the input's`,
            outSwing < inSwing + 0.5 && !S.hasNonFinite(out),
            `${fmt(outSwing, 2)} dB out vs ${fmt(inSwing, 2)} dB in`);
    });
}

/* ------------------------------------------------------ OTT: HF alias spurs */

console.log('\n== OTT: HF alias spurs ==');

const ott441 = loadProcessor('content/ott-processor.js', 44100);

{
    // The compressor gain is recomputed every sample from an envelope that
    // ripples at twice the signal frequency. Applying that gain raw
    // amplitude-modulates the band, and above about 6 kHz the AM products
    // fold back below Nyquist as discrete inharmonic tones — the "ringing"
    // audible on bright content. 48 kHz hides much of it, because the folds
    // of fundamentals that divide the rate land back on the harmonic grid;
    // 44.1 kHz is the rate that shows the problem. The bound is on the worst
    // discrete off-harmonic spur (see worstSpurDb for why not an integral).
    [ott, ott441].forEach((instance) => {
        const rate = instance.sampleRate;
        [6000, 8000, 10000, 12000].forEach((f0) => {
            [['sine', S.tone], ['square', S.squareBandlimited]].forEach(([kind, generate]) => {
                const input = generate(f0, 1.5, rate, S.dbToGain(-12));
                const out = instance.run(instance.create(), S.stereo(input), { depth: 1 })[0];
                const spur = S.worstSpurDb(out, f0, rate, Math.round(0.4 * rate), Math.round(1.4 * rate));
                const inharmonic = S.inharmonicRatioDb(out, f0, rate, Math.round(0.4 * rate), Math.round(1.4 * rate));
                check(`${kind} ${f0} Hz at ${rate} Hz: worst alias spur under -78 dBc`,
                    spur.db <= -78 && !S.hasNonFinite(out),
                    `${fmt(spur.db, 1)} dBc at ${Math.round(spur.hz)} Hz, inharmonic total ${fmt(inharmonic, 1)} dB`);
            });
        });
    });
}

{
    // A naive square already contains folded harmonics of its own. The
    // processor must not add substantially to them, and must stay finite.
    const rate = 44100;
    [8000, 10000].forEach((f0) => {
        const input = S.squareNaive(f0, 1.5, rate, S.dbToGain(-12));
        const out = ott441.run(ott441.create(), S.stereo(input), { depth: 1 })[0];
        const inSpur = S.worstSpurDb(input, f0, rate, Math.round(0.4 * rate), Math.round(1.4 * rate));
        const outSpur = S.worstSpurDb(out, f0, rate, Math.round(0.4 * rate), Math.round(1.4 * rate));
        check(`naive square ${f0} Hz: spurs stay near the input's own`,
            outSpur.db <= inSpur.db + 6 && !S.hasNonFinite(out),
            `in ${fmt(inSpur.db, 1)} dBc -> out ${fmt(outSpur.db, 1)} dBc`);
    });
}

{
    // Comb filtering would notch the magnitude response. At depth 0 the band
    // sum is an allpass pair, so the response must be flat outright; at depth
    // 1 compression tilts the spectrum, but smoothly — a tone sitting well
    // below the local trend is what a band misalignment would leave.
    // Integer frequencies sit exactly on the bins of the one-second Goertzel
    // window, so no leakage: the allpass rotates each tone's phase, and
    // off-bin leakage would interfere differently in input and output.
    const frequencies = [];
    for (let i = 0; i < 40; i++) frequencies.push(Math.round(40 * Math.pow(18000 / 40, i / 39)));
    const input = S.multitone(frequencies, 2, RATE, S.dbToGain(-30));

    [{ label: 'stock crossovers', params: { depth: 0 } },
     { label: 'crossovers 250/6000', params: { depth: 0, lowCrossHz: 250, highCrossHz: 6000 } }]
        .forEach(({ label, params }) => {
            const out = ott.run(ott.create(), S.stereo(input), params)[0];
            const gains = S.toneGainsDb(input, out, frequencies, RATE, RATE, 2 * RATE);
            const spread = Math.max(...gains) - Math.min(...gains);
            check(`multitone at depth 0 (${label}): response flat within 0.3 dB`,
                spread < 0.3 && !S.hasNonFinite(out), `spread ${fmt(spread, 3)} dB`);
        });

    const squashed = ott.run(ott.create(), S.stereo(input), { depth: 1 })[0];
    const squashedGains = S.toneGainsDb(input, squashed, frequencies, RATE, RATE, 2 * RATE);
    const notch = S.notchDepthDb(squashedGains);
    check('multitone at depth 1: no comb notch against the local trend', notch < 3 && !S.hasNonFinite(squashed),
        `worst notch ${fmt(notch, 2)} dB`);
}

{
    // Silence must stay silent: the upward stage and the positive band gain
    // fade out below the floor rather than lifting the noise floor by the
    // 30 dB the expand clamp would otherwise allow.
    const input = S.tone(1000, 1, RATE, S.dbToGain(-90));
    const out = ott.run(ott.create(), S.stereo(input), { depth: 1 })[0];
    const lift = S.gainToDb(S.rms(out, RATE / 2) / S.rms(input, RATE / 2));
    check('-90 dBFS input is not lifted', lift < 1, `${fmt(lift, 2)} dB`);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
