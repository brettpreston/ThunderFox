// Defaults, ranges and the Loudness morph, shared by the content script, the
// popup and the options page. Before this existed the popup declared its own
// copy of every range and they drifted: the EQ sliders were ±12 in the markup,
// ±18 once the popup's init() had run, and ±18 again in the content script's
// clamp. One definition, three consumers.
var ThunderFoxSettings = (function() {
    // 8 bands, roughly 1.1 octaves apart. The outer two are shelves so content
    // below 68 Hz and above 15 kHz is reachable at all; as peaking filters it
    // was not.
    const EQ_BANDS = [
        { frequency: 68, type: 'lowshelf', label: '68 Hz' },
        { frequency: 147, type: 'peaking', label: '147 Hz' },
        { frequency: 315, type: 'peaking', label: '315 Hz' },
        { frequency: 678, type: 'peaking', label: '678 Hz' },
        { frequency: 1464, type: 'peaking', label: '1.5 kHz' },
        { frequency: 3153, type: 'peaking', label: '3.2 kHz' },
        { frequency: 6787, type: 'peaking', label: '6.8 kHz' },
        { frequency: 14635, type: 'highshelf', label: '14.6 kHz' }
    ];

    // For a peaking biquad, Q = sqrt(2^BW) / (2^BW - 1). The bands sit
    // log2(147/68) = 1.11 octaves apart, so matched bandwidth wants 1.27. The
    // old Q of 1.0 is 1.39 octaves — 26% wider than the spacing, which is why
    // eight sliders at +12 dB used to give about +15 dB through the middle.
    const EQ_Q = 1.27;
    const EQ_GAIN_LIMIT = 18;
    const EQ_BAND_COUNT = EQ_BANDS.length;

    // Butterworth. The old value of 1.0 put a +1.25 dB resonant bump just above
    // the cutoff, on a control labelled "Bass cut".
    const HIGHPASS_Q = Math.SQRT1_2;
    const HIGHPASS_HZ = 200;

    // The Loudness slider's own scale. Stored negated as `limiterThreshold` for
    // compatibility with settings written by earlier versions.
    const MAX_LOUDNESS_DB = 30;

    const DEFAULTS = {
        enabled: true,
        hpEnabled: false,
        eqEnabled: true,
        limiterThreshold: -12,
        eqGains: [0, 0, 0, 0, 0, 0, 0, 0],
        advancedEnabled: false,

        preBoostDb: 0,

        // The OTT-style stock preset at half depth: full mix, both directions
        // at 1x, knobs at their base times, band ratios 0.8 up and
        // 0.9/0.857/1.0 down, band gains +16.3/+11.7/+16.3 dB. The band gain
        // is scaled by Depth inside the worklet, so the Loudness macro's low
        // end stays gentle.
        ottDepth: 0.5,
        ottMix: 1,
        ottAttack: 0.5,
        ottRelease: 0.5,
        ottUpward: 1,
        ottDownward: 1,
        ottLowCrossHz: 120,
        ottHighCrossHz: 5000,
        ottLowUp: 0.8,
        ottLowDown: 0.9,
        ottLowGainDb: 16.3,
        ottMidUp: 0.8,
        ottMidDown: 0.857,
        ottMidGainDb: 11.7,
        ottHighUp: 0.8,
        ottHighDown: 1,
        ottHighGainDb: 16.3,

        // Linear-phase band split: complementary FIR pairs instead of the IIR
        // tree. Costs latency (~11 ms at the stock crossovers) and CPU, so it
        // is opt-in.
        ottLinearPhase: false,

        limiterAttackMs: 2.5,
        limiterReleaseMs: 80,
        limiterHoldMs: 20,
        limiterCeilingDb: -0.3,
        limiterIsp: true
    };

    // unit drives both the slider mapping and the readout: 'db' and 'percent'
    // are linear; 'ms' and 'hz' are logarithmic because those ranges span three
    // orders of magnitude and a linear slider buries everything useful in the
    // first pixels. The crossover range is 20 Hz - 18 kHz on both.
    const LIMITS = {
        preBoostDb: { min: 0, max: 24, unit: 'db' },

        ottDepth: { min: 0, max: 1, unit: 'percent' },
        ottMix: { min: 0, max: 1, unit: 'percent' },
        ottAttack: { min: 0, max: 1, unit: 'percent' },
        ottRelease: { min: 0, max: 1, unit: 'percent' },
        ottUpward: { min: 0, max: 2, unit: 'percent' },
        ottDownward: { min: 0, max: 2, unit: 'percent' },
        ottLowCrossHz: { min: 20, max: 18000, unit: 'hz' },
        ottHighCrossHz: { min: 20, max: 18000, unit: 'hz' },
        ottLowUp: { min: 0, max: 1, unit: 'percent' },
        ottLowDown: { min: 0, max: 1, unit: 'percent' },
        ottLowGainDb: { min: -30, max: 30, unit: 'db' },
        ottMidUp: { min: 0, max: 1, unit: 'percent' },
        ottMidDown: { min: 0, max: 1, unit: 'percent' },
        ottMidGainDb: { min: -30, max: 30, unit: 'db' },
        ottHighUp: { min: 0, max: 1, unit: 'percent' },
        ottHighDown: { min: 0, max: 1, unit: 'percent' },
        ottHighGainDb: { min: -30, max: 30, unit: 'db' },

        limiterAttackMs: { min: 0.2, max: 5, unit: 'ms' },
        limiterReleaseMs: { min: 10, max: 1000, unit: 'ms' },
        limiterHoldMs: { min: 0, max: 50, unit: 'ms' },
        limiterCeilingDb: { min: -3, max: 0, unit: 'db' }
    };

    // Advanced-only keys: when the Advanced switch is off these revert to
    // DEFAULTS while the user's own values stay in storage.
    const ADVANCED_KEYS = Object.keys(LIMITS);

    // Bumped whenever a default changes in a way stored values should follow.
    // Stored values silently override DEFAULTS, so without this a changed
    // default only ever reaches fresh installs. Storage that predates the key
    // is version 0.
    const SETTINGS_VERSION = 4;

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function isFiniteNumber(value) {
        return typeof value === 'number' && isFinite(value);
    }

    // MIGRATIONS[n] upgrades stored values from version n to n + 1. Each takes
    // the stored object as it stands and returns only the keys it changes. A
    // migration moves a value only when it still equals the old default: a
    // value the user set deliberately is theirs, even if it happens to be the
    // old default, and there is no way to tell the two apart, so equality is
    // the honest cut.
    const MIGRATIONS = [
        // 0 -> 1: per-band Up and Down defaults moved from 100% to 80%.
        (stored) => {
            const patch = {};
            ['ottLowUp', 'ottLowDown', 'ottMidUp', 'ottMidDown', 'ottHighUp', 'ottHighDown']
                .forEach((key) => {
                    if (stored[key] === 1) patch[key] = DEFAULTS[key];
                });
            return patch;
        },
        // 1 -> 2: limiter hold default moved from 2 ms to 20 ms, long enough
        // to cover one half-cycle of bass so the gain no longer moves within a
        // cycle under sustained limiting.
        (stored) => {
            const patch = {};
            if (stored.limiterHoldMs === 2) patch.limiterHoldMs = DEFAULTS.limiterHoldMs;
            return patch;
        },
        // 2 -> 3: the multiband stage was rebuilt around the OTT-style stock
        // preset. The Time knob split into Attack and Release (a set value
        // carries over to both); the Down ratios, band gains, Depth and the
        // limiter release moved to the stock preset where they still equal
        // the old default.
        (stored) => {
            const patch = {};
            if (isFiniteNumber(stored.ottTime) && stored.ottTime !== 0.5) {
                patch.ottAttack = clamp(stored.ottTime, 0, 1);
                patch.ottRelease = patch.ottAttack;
            }
            if (stored.ottDepth === 0.35) patch.ottDepth = DEFAULTS.ottDepth;
            ['ottLowDown', 'ottMidDown', 'ottHighDown'].forEach((key) => {
                if (stored[key] === 0.8) patch[key] = DEFAULTS[key];
            });
            ['ottLowGainDb', 'ottMidGainDb', 'ottHighGainDb'].forEach((key) => {
                if (stored[key] === 0) patch[key] = DEFAULTS[key];
            });
            if (stored.limiterReleaseMs === 120) patch.limiterReleaseMs = DEFAULTS.limiterReleaseMs;
            return patch;
        },
        // 3 -> 4: the Depth default moved from 100% to 50% and the mid/high
        // crossover from 2.5 kHz to 5 kHz (less of the presence region rides
        // the high band's faster envelope). The popup's log-scale slider can
        // only ever store values like 2504, never exactly 2500, so equality
        // still separates "never touched" from "set deliberately".
        (stored) => {
            const patch = {};
            if (stored.ottDepth === 1) patch.ottDepth = DEFAULTS.ottDepth;
            if (stored.ottHighCrossHz === 2500) patch.ottHighCrossHz = DEFAULTS.ottHighCrossHz;
            return patch;
        }
    ];

    // The patch that brings `stored` up to SETTINGS_VERSION, or an empty object
    // if it is current already. Storage from a newer version is left alone.
    function migrateStored(stored) {
        const source = stored || {};
        const from = isFiniteNumber(source.settingsVersion) ? source.settingsVersion : 0;
        if (from >= SETTINGS_VERSION) return {};

        const patch = {};
        for (let version = from; version < SETTINGS_VERSION; version++) {
            Object.assign(patch, MIGRATIONS[version](Object.assign({}, source, patch)));
        }
        patch.settingsVersion = SETTINGS_VERSION;
        return patch;
    }

    function sanitizeAdvanced(source) {
        const result = {};
        ADVANCED_KEYS.forEach((key) => {
            const limits = LIMITS[key];
            const value = source && isFiniteNumber(source[key]) ? source[key] : DEFAULTS[key];
            result[key] = clamp(value, limits.min, limits.max);
        });
        // Crossed crossovers would invert the mid band. Storage written by
        // older versions allowed it, so swap rather than clamp: both chosen
        // frequencies survive, in the only order the split makes sense in.
        if (result.ottLowCrossHz > result.ottHighCrossHz) {
            const swapped = result.ottLowCrossHz;
            result.ottLowCrossHz = result.ottHighCrossHz;
            result.ottHighCrossHz = swapped;
        }
        result.limiterIsp = source && typeof source.limiterIsp === 'boolean'
            ? source.limiterIsp
            : DEFAULTS.limiterIsp;
        result.ottLinearPhase = source && typeof source.ottLinearPhase === 'boolean'
            ? source.ottLinearPhase
            : DEFAULTS.ottLinearPhase;
        return result;
    }

    function sanitizeEqGains(value) {
        const source = Array.isArray(value) && value.length === EQ_BAND_COUNT
            ? value
            : DEFAULTS.eqGains;
        return source.map((gain) => clamp(isFiniteNumber(gain) ? gain : 0, -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT));
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    // Slider position as a 0..1 fraction, from the negated storage value.
    function loudnessAmount(thresholdDb) {
        const value = isFiniteNumber(thresholdDb) ? thresholdDb : DEFAULTS.limiterThreshold;
        return clamp(-value, 0, MAX_LOUDNESS_DB) / MAX_LOUDNESS_DB;
    }

    /**
     * One macro drives two things: how hard the multiband works, and how hard
     * the result is pushed into a fixed ceiling. Both sit ahead of the limiter,
     * so raising Loudness never adds gain after the only stage protecting the
     * output.
     *
     * There is no dry/wet blend here. Depth is a gain-domain control inside the
     * OTT worklet, so morphing it cannot comb-filter the way mixing a delayed
     * wet path against a dry one would.
     */
    function loudnessProfile(amount) {
        const t = clamp(amount, 0, 1);
        return {
            depth: lerp(0.15, 1, t),
            driveDb: lerp(0, 24, t)
        };
    }

    return {
        EQ_BANDS,
        EQ_BAND_COUNT,
        EQ_Q,
        EQ_GAIN_LIMIT,
        HIGHPASS_Q,
        HIGHPASS_HZ,
        MAX_LOUDNESS_DB,
        DEFAULTS,
        LIMITS,
        ADVANCED_KEYS,
        SETTINGS_VERSION,
        clamp,
        migrateStored,
        sanitizeAdvanced,
        sanitizeEqGains,
        loudnessAmount,
        loudnessProfile
    };
})();
