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
    // allpass pair, so magnitude is flat.
    [40, 88.3, 300, 1000, 2500, 8000].forEach((frequency) => {
        const input = S.tone(frequency, 1, RATE, S.dbToGain(-12));
        const out = ott.run(ott.create(), S.stereo(input), { depth: 0 })[0];
        const error = S.gainToDb(S.rms(out, RATE / 2) / S.rms(input, RATE / 2));
        check(`depth 0 is flat at ${frequency} Hz`, Math.abs(error) < 0.15 && !S.hasNonFinite(out),
            `${fmt(error, 3)} dB`);
    });
}

{
    // An impulse must come out finite and settle.
    const input = S.impulse(0.5, RATE, 0.9, 0.1);
    const out = ott.run(ott.create(), S.stereo(input), { depth: 1 })[0];
    check('impulse response is finite and decays', !S.hasNonFinite(out) && S.peak(out, Math.round(0.4 * RATE)) < 1e-3,
        `tail peak ${fmt(S.gainToDb(S.peak(out, Math.round(0.4 * RATE))), 1)} dBFS`);
}

{
    // The Time knob: a level step up (attack) and down (release) in the mid
    // band. The 63% time must grow with Time, and by a lot: the knob spans
    // about two orders of magnitude.
    // The gain is read from the processor after each render quantum rather
    // than inferred from the output: a level step leaves the crossover
    // filters ringing with the old level, which corrupts an output-based
    // estimate for tens of milliseconds. Resolution is one quantum, 2.7 ms.
    const results = [0, 0.25, 0.5, 0.75, 1].map((time) => {
        const input = S.steppedTone(1000, RATE, [
            { db: -40, until: 1.0 },
            { db: -6, until: 2.0 },
            { db: -40, until: 4.0 }
        ]);
        const track = [];
        ott.run(ott.create(), S.stereo(input), { depth: 1, time }, (processor, start) => {
            track.push({ time: start / RATE, db: S.gainToDb(processor.bandGain[1]) });
        });
        return {
            time,
            attack: S.timeConstant(track, 1.0, 1.9, 0),
            release: S.timeConstant(track, 2.0, 3.9, 0)
        };
    });
    results.forEach((r) => note(`time ${r.time}: attack ${fmt(r.attack * 1000, 1)} ms, release ${fmt(r.release * 1000, 1)} ms`));
    const attacks = results.map((r) => r.attack);
    const releases = results.map((r) => r.release);
    const monotonic = (list) => list.every((v, i) => i === 0 || v >= list[i - 1]);
    check('Time knob lengthens attack monotonically', monotonic(attacks) && attacks[4] > attacks[0] * 10,
        `${fmt(attacks[0] * 1000, 1)} ms -> ${fmt(attacks[4] * 1000, 1)} ms`);
    check('Time knob lengthens release monotonically', monotonic(releases) && releases[4] > releases[0] * 10,
        `${fmt(releases[0] * 1000, 1)} ms -> ${fmt(releases[4] * 1000, 1)} ms`);
}

{
    // Smoothness: a steady tone in each band at full depth. Gain moving within
    // a cycle is harmonic distortion; a compressor that is not pumping on its
    // own input should stay well under -50 dB. Time 0 is a 6 ms release, and
    // what a 30 Hz tone leaks into the mid band (about -37 dB through the
    // crossover) is modulated by that band's shorter hold, so the fastest
    // setting gets a looser bound.
    [{ f: 30, band: 'low' }, { f: 60, band: 'low' }, { f: 120, band: 'mid' }, { f: 300, band: 'mid' }, { f: 5000, band: 'high' }]
        .forEach(({ f, band }) => {
            [0, 0.25, 0.5].forEach((time) => {
                const bound = time === 0 ? -40 : -50;
                const input = S.tone(f, 2, RATE, S.dbToGain(-12));
                const out = ott.run(ott.create(), S.stereo(input), { depth: 1, time })[0];
                const thd = S.thdDb(out, f, RATE, RATE, 2 * RATE);
                check(`${band} band ${f} Hz, time ${time}: distortion under ${bound} dB`, thd < bound,
                    `THD ${fmt(thd, 1)} dB`);
            });
        });
}

{
    // A kick and bass pattern, low band gain read every sample. The gain must
    // move smoothly: a step of more than a small fraction of a dB between two
    // samples is a click, and that is what the low band did at every kick
    // onset before the attack floor (1.4 dB per sample). Modulation above
    // 15 Hz is reported for comparison.
    const input = S.kickBass(3, RATE);
    [{ depth: 0.49, time: 0.5 }, { depth: 1, time: 0.5 }, { depth: 1, time: 0.25 }].forEach((cfg) => {
        const gain = new Float32Array(input.length);
        ott.run(ott.create(), S.stereo(input), cfg, (processor, i) => {
            gain[i] = S.gainToDb(processor.bandGain[0]);
        }, 1);
        const rough = S.gainRoughness(gain, RATE, 1, 15);
        check(`kick and bass, depth ${cfg.depth}, time ${cfg.time}: low band gain has no steps`, rough.maxStepDb < 0.05,
            `max ${fmt(rough.maxStepDb, 3)} dB/sample, ${fmt(rough.modulationDb, 2)} dB rms above 15 Hz`);
    });
}

{
    // Quiet, wobbling low-band content, like a room tone or a reverb tail: the
    // floor fade must not act as a fast expander on it. Before the fade was
    // given its own slow envelope this swung 6.5 dB at full depth.
    const input = S.wobblingTone(40, 4, RATE, -65, 6, 5);
    [0.49, 1].forEach((depth) => {
        let min = Infinity;
        let max = -Infinity;
        ott.run(ott.create(), S.stereo(input), { depth, time: 0.5 }, (processor, i) => {
            if (i < 2 * RATE) return;
            const db = S.gainToDb(processor.bandGain[0]);
            if (db < min) min = db;
            if (db > max) max = db;
        });
        check(`quiet wobbling bass, depth ${depth}: low band gain swing under 2 dB`, max - min < 2,
            `${fmt(max - min, 2)} dB peak to peak`);
    });
}

{
    // Silence must stay silent: upward compression and makeup fade out below
    // the floor rather than lifting the noise floor.
    const input = S.tone(1000, 1, RATE, S.dbToGain(-90));
    const out = ott.run(ott.create(), S.stereo(input), { depth: 1 })[0];
    const lift = S.gainToDb(S.rms(out, RATE / 2) / S.rms(input, RATE / 2));
    check('-90 dBFS input is not lifted', lift < 1, `${fmt(lift, 2)} dB`);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
