'use strict';

/**
 * Offline tests for the two worklets. Run with `npm test` or `node tests/run.js`.
 *
 * Each test drives a processor with a generated signal (tone, stepped tone,
 * impulse) and checks a property that should hold regardless of tuning: the
 * limiter never exceeds its ceiling and does not pump, latency is what the node
 * reports, depth 0 is transparent, the Time knob actually moves the time constants, and so on.
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

/**
 * The gain the limiter applied, per sample and in dB. The detector is linked
 * across channels, so a second channel carrying a small constant comes out as
 * that constant times the gain, whatever is on the first.
 */
function limiterGainDb(processorSet, input, params) {
    const PROBE = 1e-3;
    const probe = new Float32Array(input.length).fill(PROBE);
    const processor = processorSet.create();
    const latency = processor.port.posted.find((m) => m.type === 'latency').samples;
    const out = processorSet.run(processor, [input, probe],
        Object.assign({ ceiling: CEILING }, params || {}));
    const gain = new Float32Array(input.length);
    for (let i = 0; i < gain.length; i++) {
        // Until the probe has reached the output the limiter is at rest.
        gain[i] = i <= latency ? 0 : S.gainToDb(out[1][i] / PROBE);
    }
    return { gainDb: gain, out: out[0], latency };
}

// Seconds after `fromSeconds` at which the gain first comes back above `db`.
function timeToRecover(gainDb, fromSeconds, db) {
    for (let i = Math.round(fromSeconds * RATE); i < gainDb.length; i++) {
        if (gainDb[i] >= db) return i / RATE - fromSeconds;
    }
    return NaN;
}

{
    // A lone transient, 12 dB over on a quiet bed, comes back on the fast
    // release: 90% of the way, in dB, one hold plus one Release after it.
    const HOLD = 0.02;
    [0.05, 0.12, 0.5, 1.0].forEach((release) => {
        const input = S.tone(1000, 1.5 + release * 3, RATE, S.dbToGain(-20.3));
        const at = Math.round(0.5 * RATE);
        for (let i = 0; i < 48; i++) {
            input[at + i] += S.dbToGain(11.7) * Math.sin((Math.PI * i) / 48)
                * Math.sin((2 * Math.PI * 3000 * i) / RATE);
        }
        const { gainDb } = limiterGainDb(limiter, input, { release, hold: HOLD });
        let dip = 0;
        for (let i = at; i < at + RATE * 0.05; i++) if (gainDb[i] < dip) dip = gainDb[i];
        const recovered = timeToRecover(gainDb, 0.5 + 0.002, dip * 0.1);
        const expected = HOLD + release;
        check(`release ${release}s: a lone transient recovers in about that time`,
            dip < -10 && isFinite(recovered) && recovered > expected * 0.7 && recovered < expected * 1.4,
            `dip ${fmt(dip, 1)} dB, 90% back after ${fmt(recovered, 3)} s`);
    });
}

{
    // Sustained reduction does not come back on the fast release. After a
    // second at 12 dB over, the gain a quarter of a second later has barely
    // moved, and the whole recovery is a slope of a few dB per second.
    const recoveries = [0.04, 0.08].map((release) => {
        const input = S.steppedTone(1000, RATE, [
            { db: -20.3, until: 0.5 },
            { db: 11.7, until: 1.5 },
            { db: -20.3, until: 9 }
        ]);
        const { gainDb } = limiterGainDb(limiter, input, { release });
        return {
            release,
            held: gainDb[Math.round(1.4 * RATE)],
            soon: gainDb[Math.round(1.75 * RATE)],
            seconds: timeToRecover(gainDb, 1.5, -0.1)
        };
    });
    const stock = recoveries[1];
    check('sustained limiting: no swell when the programme drops',
        stock.held < -11.5 && stock.soon - stock.held < 1.5,
        `${fmt(stock.held, 2)} dB held, ${fmt(stock.soon, 2)} dB a quarter of a second after`);
    check('sustained limiting: 12 dB comes back in a few seconds',
        stock.seconds > 2 && stock.seconds < 6,
        `within 0.1 dB of unity after ${fmt(stock.seconds, 2)} s`);
    const ratio = stock.seconds / recoveries[0].seconds;
    check('the Release control scales the slow recovery too', ratio > 1.6 && ratio < 2.4,
        `${fmt(recoveries[0].seconds, 2)} s at 40 ms, ${fmt(stock.seconds, 2)} s at 80 ms`);
}

{
    // Dense material driven hard, which is where a limiter pumps: every hit
    // pushes the gain down and the sustained material swells back up behind
    // it. Bounded here are that swell, measured on the gain averaged over
    // 100 ms, and the roughness of the gain from one sample to the next.
    const programme = S.drumsOverBed(8, RATE);
    [12, 24].forEach((driveDb) => {
        const input = Float32Array.from(programme, (v) => v * S.dbToGain(CEILING_DB + driveDb));
        const { gainDb, out } = limiterGainDb(limiter, input);
        const pumping = S.gainPumping(gainDb, RATE, 4);
        const roughness = S.gainRoughness(gainDb, RATE, 4);
        check(`dense programme ${driveDb} dB over: ceiling holds and the gain does not pump`,
            S.peak(out) <= CEILING * (1 + 1e-4) && !S.hasNonFinite(out)
                && pumping.riseDb < 3 && pumping.swingDb < 4 && roughness.maxStepDb < 0.08,
            `swing ${fmt(pumping.swingDb)} dB, rise ${fmt(pumping.riseDb)} dB in 250 ms, `
                + `max ${fmt(roughness.maxStepDb, 3)} dB/sample`);
    });
}

{
    // The attack is an S-curve across the whole look-ahead. A lone click
    // 24 dB over is the steepest thing it has to draw.
    const input = S.impulse(0.4, RATE, CEILING * S.dbToGain(24), 0.1);
    const { gainDb, out } = limiterGainDb(limiter, input);
    const roughness = S.gainRoughness(gainDb, RATE, 0.01);
    let dip = 0;
    for (let i = 0; i < gainDb.length; i++) if (gainDb[i] < dip) dip = gainDb[i];
    check('a 24 dB click is met with a smooth gain curve',
        S.peak(out) <= CEILING * (1 + 1e-4) && dip < -23.9 && roughness.maxStepDb < 0.25,
        `dip ${fmt(dip, 1)} dB, max ${fmt(roughness.maxStepDb, 3)} dB/sample`);
}

{
    // Moving the smoothing control rebuilds the running sums while the
    // envelope is in flight. The ceiling must survive that at any setting.
    const programme = S.drumsOverBed(3, RATE);
    const input = Float32Array.from(programme, (v) => v * S.dbToGain(CEILING_DB + 18));
    let state = 1;
    const smoothing = () => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return 0.0002 + (state / 4294967296) * 0.0048;
    };
    const out = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, smoothing })[0];
    check('ceiling holds while the smoothing control is moved', S.peak(out) <= CEILING * (1 + 1e-4) && !S.hasNonFinite(out),
        `peak ${fmt(S.gainToDb(S.peak(out)), 3)} dBFS`);
}

{
    // The drive is plain gain while nothing is over the ceiling.
    const input = S.tone(1000, 0.5, RATE, S.dbToGain(CEILING_DB - 12));
    const out = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, drive: S.dbToGain(6) })[0];
    const gain = S.gainToDb(S.rms(out, RATE / 4) / S.rms(input, RATE / 4));
    check('drive of 6 dB below the ceiling is 6 dB of gain', Math.abs(gain - 6) < 0.01, `${fmt(gain, 3)} dB`);
}

{
    // Turning the drive down while the limiter is deep in sustained
    // reduction. The reduction the drive was responsible for has to go with
    // it; left to the slow release, the output would drop by the full 12 dB
    // and take seconds to come back. Compared against the same programme
    // at the lower drive throughout, quarter of a second by quarter.
    const programme = Float32Array.from(S.drumsOverBed(10, RATE), (v) => v * CEILING);
    const high = S.dbToGain(24);
    const low = S.dbToGain(12);
    const drive = (start) => {
        const t = start / RATE - 6;
        return t < 0 ? high : low + (high - low) * Math.exp(-t / 0.02);
    };
    const moved = limiter.run(limiter.create(), S.stereo(programme), { ceiling: CEILING, drive })[0];
    const steady = limiter.run(limiter.create(), S.stereo(programme), { ceiling: CEILING, drive: low })[0];
    let worst = 0;
    for (let t = 6; t < 8; t += 0.25) {
        const from = Math.round(t * RATE);
        const to = from + Math.round(0.25 * RATE);
        const difference = S.gainToDb(S.rms(moved, from, to) / S.rms(steady, from, to));
        if (Math.abs(difference) > Math.abs(worst)) worst = difference;
    }
    check('turning the drive down 12 dB does not leave the output quiet',
        S.peak(moved) <= CEILING * (1 + 1e-4) && !S.hasNonFinite(moved) && Math.abs(worst) < 1,
        `worst ${fmt(worst, 2)} dB against the lower drive held throughout`);
}

{
    // The ceiling under a drive that never stops moving, up and down.
    const programme = Float32Array.from(S.drumsOverBed(4, RATE), (v) => v * CEILING);
    const drive = (start) => S.dbToGain(12 + 12 * Math.sin((2 * Math.PI * 3 * start) / RATE));
    const out = limiter.run(limiter.create(), S.stereo(programme), { ceiling: CEILING, drive })[0];
    check('ceiling holds while the drive is moved', S.peak(out) <= CEILING * (1 + 1e-4) && !S.hasNonFinite(out),
        `peak ${fmt(S.gainToDb(S.peak(out)), 3)} dBFS`);
}

{
    // Same guarantee and the same latency report at 44.1 kHz, where the
    // look-ahead is an odd number of samples.
    const limiter441 = loadProcessor('content/limiter-processor.js', 44100);
    const input = S.concat([
        S.impulse(0.2, 44100, S.dbToGain(11.7), 0.1),
        Float32Array.from(S.drumsOverBed(2, 44100), (v) => v * S.dbToGain(CEILING_DB + 18))
    ]);
    const processor = limiter441.create();
    const reported = processor.port.posted.find((m) => m.type === 'latency');
    const out = limiter441.run(processor, S.stereo(input), { ceiling: CEILING })[0];
    let argmax = 0;
    for (let i = 0; i < 0.2 * 44100; i++) if (Math.abs(out[i]) > Math.abs(out[argmax])) argmax = i;
    check('44.1 kHz: ceiling holds and latency matches the report',
        S.peak(out) <= CEILING * (1 + 1e-4) && !S.hasNonFinite(out)
            && argmax - Math.round(0.1 * 44100) === reported.samples,
        `peak ${fmt(S.gainToDb(S.peak(out)), 3)} dBFS, ${reported.samples} samples`);
}

{
    // A tone at a quarter of the sample rate, sampled 45 degrees off its
    // crests: every sample reads 3 dB under the peak the waveform actually
    // reaches. With ISP on, the reconstructed output has to stay under the
    // ceiling, not just the samples.
    const input = new Float32Array(RATE);
    for (let i = 0; i < input.length; i++) {
        input[i] = S.dbToGain(CEILING_DB + 12) * Math.sin((Math.PI * i) / 2 + Math.PI / 4);
    }
    const on = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, isp: 1 })[0];
    const off = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, isp: 0 })[0];
    const onPeak = S.truePeak(on, RATE / 2, RATE / 2 + 4800);
    const offPeak = S.truePeak(off, RATE / 2, RATE / 2 + 4800);
    check('ISP holds the reconstructed peak of an off-crest tone under the ceiling',
        onPeak <= CEILING * (1 + 1e-3),
        `true peak ${fmt(S.gainToDb(onPeak), 3)} dBFS with ISP, ${fmt(S.gainToDb(offPeak), 3)} dBFS without`);
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
    // envelope takes multiplicative steps and the applied gain follows it
    // through a 0.2 ms smoother, so a kick onset moves the gain by a fraction
    // of a dB per sample at the start of the attack. What must not happen is
    // an unbounded step or a non-finite gain.
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

/* ------------------------------------------------------- OTT: linear phase */

console.log('\n== OTT: linear phase ==');

{
    // In linear-phase mode the two FIR splits are complementary by
    // construction, so at depth 0 the three bands must sum to a PURE delay:
    // one sample where the latency says, nothing anywhere else.
    [{ label: 'stock crossovers', params: {} },
        { label: 'crossovers 250/6000', params: { lowCrossHz: 250, highCrossHz: 6000 } }]
        .forEach(({ label, params }) => {
            const processor = ott.create();
            const input = S.impulse(0.5, RATE, 0.9, 0.1);
            const out = ott.run(processor, S.stereo(input),
                Object.assign({ depth: 0, linearPhase: 1 }, params))[0];
            const expected = Math.round(0.1 * RATE) + processor.firLatencySamples;
            let argmax = 0;
            let residual = 0;
            for (let i = 0; i < out.length; i++) {
                if (Math.abs(out[i]) > Math.abs(out[argmax])) argmax = i;
                if (i !== expected && Math.abs(out[i]) > residual) residual = Math.abs(out[i]);
            }
            check(`linear phase, depth 0: impulse is a pure delay (${label})`,
                argmax === expected
                    && Math.abs(out[expected] - 0.9) < 1e-3
                    && residual < 0.9 * S.dbToGain(-80)
                    && !S.hasNonFinite(out),
                `peak at ${argmax} (expected ${expected}), residual ${fmt(S.gainToDb(residual / 0.9), 1)} dB`);
        });
}

{
    // Tap counts follow the crossovers: 1023 taps at 120 Hz (capped), 63 at
    // 5 kHz, so the splitter's latency at the stock split is 511 + 31.
    const processor = ott.create();
    ott.run(processor, S.stereo(S.silence(0.05, RATE)), { linearPhase: 1 });
    check('linear phase: latency at the stock crossovers is 542 samples',
        processor.firLatencySamples === 542,
        `${processor.firLatencySamples} samples (${fmt((processor.firLatencySamples / RATE) * 1000, 1)} ms)`);
}

{
    // Depth 0 flatness on tones — tighter than the IIR bound, because the
    // sum is a pure delay rather than an allpass pair.
    [40, 120, 300, 1000, 5000, 8000].forEach((frequency) => {
        const input = S.tone(frequency, 1, RATE, S.dbToGain(-12));
        const out = ott.run(ott.create(), S.stereo(input), { depth: 0, linearPhase: 1 })[0];
        const error = S.gainToDb(S.rms(out, RATE / 2) / S.rms(input, RATE / 2));
        check(`linear phase, depth 0 is flat at ${frequency} Hz`, Math.abs(error) < 0.05 && !S.hasNonFinite(out),
            `${fmt(error, 3)} dB`);
    });
}

{
    // The compressor behind the FIR split: same transfer-curve expectations
    // as the IIR-mode test, and the band routing must still follow the
    // crossover parameters.
    const quiet = S.tone(1000, 2, RATE, S.dbToGain(-50));
    const loud = S.tone(1000, 2, RATE, S.dbToGain(-6));
    const quietOut = ott.run(ott.create(), S.stereo(quiet), { depth: 1, linearPhase: 1 })[0];
    const loudOut = ott.run(ott.create(), S.stereo(loud), { depth: 1, linearPhase: 1 })[0];
    const quietGain = S.gainToDb(S.rms(quietOut, RATE) / S.rms(quiet, RATE));
    const loudGain = S.gainToDb(S.rms(loudOut, RATE) / S.rms(loud, RATE));
    check('linear phase: upward compression lifts a -50 dB tone above its makeup', quietGain > 13,
        `${fmt(quietGain, 1)} dB (makeup alone is 11.7)`);
    check('linear phase: the -50..-6 dB range is compressed', 44 + loudGain - quietGain < 44 - 8,
        `44 dB in -> ${fmt(44 + loudGain - quietGain, 1)} dB out`);

    const bandLevels = (params) => {
        const processor = ott.create();
        ott.run(processor, S.stereo(S.tone(300, 1, RATE, S.dbToGain(-12))), params);
        return Array.from(processor.floorEnvelope);
    };
    const stock = bandLevels({ depth: 1, linearPhase: 1 });
    const moved = bandLevels({ depth: 1, linearPhase: 1, lowCrossHz: 600 });
    check('linear phase: 300 Hz lands in the mid band at the stock crossover', stock[1] > stock[0] * 10,
        `low ${fmt(10 * Math.log10(stock[0] + 1e-20), 1)} dB vs mid ${fmt(10 * Math.log10(stock[1] + 1e-20), 1)} dB`);
    check('linear phase: raising the low crossover moves 300 Hz into the low band', moved[0] > moved[1] * 10,
        `low ${fmt(10 * Math.log10(moved[0] + 1e-20), 1)} dB vs mid ${fmt(10 * Math.log10(moved[1] + 1e-20), 1)} dB`);
}

{
    // The alias-spur bound holds in FIR mode too: the fix is in the gain
    // application, not in the splitter.
    const rate = 44100;
    const input = S.tone(10000, 1.5, rate, S.dbToGain(-12));
    const out = ott441.run(ott441.create(), S.stereo(input), { depth: 1, linearPhase: 1 })[0];
    const spur = S.worstSpurDb(out, 10000, rate, Math.round(0.4 * rate), Math.round(1.4 * rate));
    check('linear phase: worst alias spur at 10 kHz / 44.1 kHz under -78 dBc',
        spur.db <= -78 && !S.hasNonFinite(out),
        `${fmt(spur.db, 1)} dBc at ${Math.round(spur.hz)} Hz`);
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

/* ------------------------------------------------------------------ settings */

console.log('\n== Settings ==');

{
    // common/settings.js is browser-free, so it runs as-is in a bare context.
    const fs = require('fs');
    const path = require('path');
    const vm = require('vm');
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'common', 'settings.js'), 'utf8');
    const settings = vm.runInNewContext(`${source}; ThunderFoxSettings`, {});

    const swapped = settings.sanitizeAdvanced({ ottLowCrossHz: 8000, ottHighCrossHz: 300 });
    check('sanitizeAdvanced swaps crossed crossovers',
        swapped.ottLowCrossHz === 300 && swapped.ottHighCrossHz === 8000,
        `${swapped.ottLowCrossHz} / ${swapped.ottHighCrossHz} Hz`);

    const current = settings.SETTINGS_VERSION;

    const nudged = settings.migrateStored({ settingsVersion: 3, ottDepth: 1, ottHighCrossHz: 2500 });
    check('migration 3 -> 4 nudges values still at the old defaults',
        nudged.ottDepth === 0.5 && nudged.ottHighCrossHz === 5000 && nudged.settingsVersion === current,
        JSON.stringify(nudged));

    const kept = settings.migrateStored({ settingsVersion: 3, ottDepth: 0.9, ottHighCrossHz: 2600 });
    check('migration 3 -> 4 leaves deliberate values alone',
        kept.ottDepth === undefined && kept.ottHighCrossHz === undefined && kept.settingsVersion === current,
        JSON.stringify(kept));

    const widened = settings.migrateStored({ settingsVersion: 4, limiterAttackMs: 2.5 });
    const narrow = settings.migrateStored({ settingsVersion: 4, limiterAttackMs: 1 });
    check('migration 4 -> 5 moves the limiter attack only from its old default',
        widened.limiterAttackMs === 5 && narrow.limiterAttackMs === undefined
            && widened.settingsVersion === 5 && narrow.settingsVersion === 5,
        `${JSON.stringify(widened)} / ${JSON.stringify(narrow)}`);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
