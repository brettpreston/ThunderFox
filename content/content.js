(function() {
    // Values used when the Advanced section is switched off. The user's own
    // settings stay in storage so toggling Advanced back on restores them.
    const DEFAULT_DYNAMICS = {
        preBoostDb: 6,
        compAttackMs: 10,
        compReleaseMs: 300,
        limiterAttackMs: 3,
        limiterReleaseMs: 100
    };

    // limiterAttackMs is the limiter's gain-envelope smoothing width and cannot
    // exceed the worklet's fixed 5 ms look-ahead.
    const DYNAMICS_LIMITS = {
        preBoostDb: { min: 0, max: 24 },
        compAttackMs: { min: 0.1, max: 100 },
        compReleaseMs: { min: 20, max: 1000 },
        limiterAttackMs: { min: 0.2, max: 5 },
        limiterReleaseMs: { min: 10, max: 500 }
    };

    // Gain staging. The band splitter reconstructs flat within 0.1 dB above
    // 700 Hz but carries a gentle +3 dB shelf below 400 Hz, which the low trim
    // cancels. Loudness comes from pre-boost, the band makeups and the drive
    // control, all of which sit ahead of the limiter.
    const BAND_TRIM_DB = { low: -3, mid: 0, high: 0 };
    const MASTER_TRIM_DB = 0;
    const MAX_DRIVE_DB = 30;
    // Stored as a negative "threshold" for backwards compatibility with
    // settings written by earlier versions; the magnitude is the drive in dB.
    const DEFAULT_LIMITER_THRESHOLD = -12;

    // Upward compression is slower than downward on purpose; a fast upward
    // release is what makes quiet passages audibly breathe.
    const UPWARD_ATTACK_SCALE = 3;
    const UPWARD_RELEASE_SCALE = 2;

    // Fixed wet mix of the two compressed paths. There is no dry path: the FIR
    // band splitter and the look-ahead limiter both add delay, so blending dry
    // against wet would comb-filter. Loudness morphs the compressor and drive
    // parameters instead (see LOUDNESS_LIGHT / LOUDNESS_EXTREME).
    const BLEND = { down: 0.65, up: 0.35 };

    // Loudness 0% → light compression, light drive into the brickwall.
    // Loudness 100% → strong upward/downward compression, heavy drive.
    const LOUDNESS_LIGHT = {
        downward: { thresholdDb: -6, kneeDb: 4, ratio: 2 },
        upward: { thresholdDb: -18, kneeDb: 6, ratio: 2.5 },
        driveDb: 0
    };
    const LOUDNESS_EXTREME = {
        downward: { thresholdDb: -18, kneeDb: 8, ratio: 8 },
        upward: { thresholdDb: -42, kneeDb: 12, ratio: 16 },
        driveDb: MAX_DRIVE_DB
    };

    // The brickwall limiter cannot exceed this, so it is a true ceiling rather
    // than a target. Left a little under 0 dBFS for inter-sample peaks, which
    // a sample-domain limiter does not see.
    const OUTPUT_CEILING_DB = -0.3;
    const LIMITER_WORKLET_PATH = 'content/limiter-processor.js';
    const LIMITER_WORKLET_NAME = 'thunderfox-brickwall-limiter';

    const PARAM_SMOOTHING_SECONDS = 0.02;

    const STATE = {
        audioContext: null,
        contextReady: null,
        pendingElements: new Set(),
        mediaElToNodes: new Map(),
        masterGain: null,
        limiter: null,
        enabled: true,
        observer: null,
        limiterThresholdDb: DEFAULT_LIMITER_THRESHOLD,
        hpEnabled: false,
        eqEnabled: true,
        eq: null,
        eqGains: [0, 0, 0, 0, 0, 0, 0, 0], // 8 bands, default 0 dB
        advancedEnabled: false,
        dynamics: Object.assign({}, DEFAULT_DYNAMICS)
    };

    function dbToGain(db) {
        return Math.pow(10, db / 20);
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function msToSeconds(ms) {
        return clamp(ms / 1000, 0, 1);
    }

    function sanitizeDynamics(source) {
        const result = {};
        Object.keys(DEFAULT_DYNAMICS).forEach((key) => {
            const limits = DYNAMICS_LIMITS[key];
            const value = source && typeof source[key] === 'number' && isFinite(source[key])
                ? source[key]
                : DEFAULT_DYNAMICS[key];
            result[key] = clamp(value, limits.min, limits.max);
        });
        return result;
    }

    function effectiveDynamics() {
        return STATE.advancedEnabled ? STATE.dynamics : DEFAULT_DYNAMICS;
    }

    // Smoothed writes for anything in the signal path; assigning .value directly
    // on every slider input event is what produces zipper noise.
    function rampParam(param, value) {
        if (!param) return;
        if (!STATE.audioContext) {
            param.value = value;
            return;
        }
        const now = STATE.audioContext.currentTime;
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, PARAM_SMOOTHING_SECONDS);
    }

    // Web Audio's compression curve, used to derive makeup gains that exactly
    // cancel each compressor's effect at 0 dBFS.
    function compressorOutputDb(inputDb, thresholdDb, kneeDb, ratio) {
        if (inputDb <= thresholdDb) return inputDb;
        if (kneeDb > 0 && inputDb <= thresholdDb + kneeDb) {
            const over = inputDb - thresholdDb;
            return inputDb + ((1 / ratio - 1) * over * over) / (2 * kneeDb);
        }
        return thresholdDb + kneeDb / 2 + kneeDb / (2 * ratio) + (inputDb - thresholdDb - kneeDb) / ratio;
    }

    // Makeup that puts a full-scale input back at full scale, so the compressor
    // only ever lifts what sits below its threshold. This is what turns a
    // downward compressor into the upward-acting stage OTT-style processing
    // depends on.
    function unityMakeupDb(config) {
        return -compressorOutputDb(0, config.thresholdDb, config.kneeDb, config.ratio);
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    // Slider position as a 0..1 fraction. Stored as a negative "threshold" for
    // compatibility with settings written by earlier versions.
    function loudnessAmount(thresholdDb) {
        return clamp(-thresholdDb, 0, MAX_DRIVE_DB) / MAX_DRIVE_DB;
    }

    // Crossfade compressor and drive settings between light and extreme.
    // Both wet paths share the FIR delay, so morphing parameters never
    // introduces comb filtering the way a dry/wet mix would.
    function loudnessProfile(amount) {
        const t = clamp(amount, 0, 1);
        const mix = (light, extreme) => ({
            thresholdDb: lerp(light.thresholdDb, extreme.thresholdDb, t),
            kneeDb: lerp(light.kneeDb, extreme.kneeDb, t),
            ratio: lerp(light.ratio, extreme.ratio, t)
        });
        return {
            downward: mix(LOUDNESS_LIGHT.downward, LOUDNESS_EXTREME.downward),
            upward: mix(LOUDNESS_LIGHT.upward, LOUDNESS_EXTREME.upward),
            driveDb: lerp(LOUDNESS_LIGHT.driveDb, LOUDNESS_EXTREME.driveDb, t)
        };
    }

    function applyCompressorSettings(comp, makeup, config) {
        if (!comp) return;
        rampParam(comp.threshold, config.thresholdDb);
        rampParam(comp.knee, config.kneeDb);
        rampParam(comp.ratio, config.ratio);
        if (makeup) rampParam(makeup.gain, dbToGain(unityMakeupDb(config)));
    }

    // Building the context is asynchronous now that the limiter is an
    // AudioWorklet, so callers await a single shared promise.
    function ensureAudioContext() {
        if (!STATE.contextReady) STATE.contextReady = buildAudioContext();
        return STATE.contextReady;
    }

    async function buildAudioContext() {
        const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        STATE.audioContext = ctx;

        STATE.masterGain = ctx.createGain();
        STATE.masterGain.gain.value = dbToGain(MASTER_TRIM_DB);
        // Highpass filter placed after multiband output but before limiter (biquad, 200Hz)
        STATE.hpFilter = createBiquadHighpass(ctx, 200);
        // 8-band equalizer before limiter
        STATE.eq = create8BandEQ(ctx);
        STATE.limiter = await createLimiter(ctx);

        applyLoudness(STATE.limiterThresholdDb);
        applyDynamics();

        // Wire DSP chain
        updateDSPChain();
        STATE.limiter.output.connect(ctx.destination);

        if (STATE.eq && STATE.eq.setGains) STATE.eq.setGains(STATE.eqGains);
    }

    function create8BandEQ(ctx) {
        // Standard 8-band EQ frequencies (Hz)
        const frequencies = [68, 147, 315, 678, 1464, 3153, 6787, 14635];
        const Q = 1.0; // Quality factor for reasonable bandwidth

        const input = ctx.createGain();
        const filters = [];

        // Create 8 peaking filters in series
        let currentNode = input;
        frequencies.forEach((freq) => {
            const filter = ctx.createBiquadFilter();
            filter.type = 'peaking';
            filter.frequency.value = freq;
            filter.Q.value = Q;
            filter.gain.value = 0; // Default to 0 dB (no boost/cut)

            currentNode.connect(filter);
            currentNode = filter;
            filters.push(filter);
        });

        return {
            input,
            output: currentNode,
            filters,
            setGain: (bandIndex, gainDb) => {
                if (bandIndex >= 0 && bandIndex < filters.length) {
                    rampParam(filters[bandIndex].gain, gainDb);
                }
            },
            setGains: (gainsDb) => {
                gainsDb.forEach((gainDb, index) => {
                    if (index < filters.length) {
                        rampParam(filters[index].gain, gainDb);
                    }
                });
            }
        };
    }

    // A look-ahead brickwall limiter needs to see samples before they play,
    // which no built-in node can do, so the real limiter lives in an
    // AudioWorklet. If that cannot be loaded the chain still has to be safe,
    // hence the compressor fallback below.
    async function createBrickwallNode(ctx) {
        try {
            const url = browser.runtime.getURL(LIMITER_WORKLET_PATH);
            await ctx.audioWorklet.addModule(url);

            const node = new AudioWorkletNode(ctx, LIMITER_WORKLET_NAME, {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                parameterData: { ceiling: dbToGain(OUTPUT_CEILING_DB) }
            });

            return {
                node,
                brickwall: true,
                setSmoothing: (seconds) => rampParam(node.parameters.get('smoothing'), seconds),
                setRelease: (seconds) => rampParam(node.parameters.get('release'), seconds)
            };
        } catch (error) {
            console.warn('ThunderFox: brickwall worklet unavailable, using compressor fallback', error);

            const comp = ctx.createDynamicsCompressor();
            comp.threshold.value = OUTPUT_CEILING_DB - 2;
            comp.knee.value = 0;
            comp.ratio.value = 20;
            comp.attack.value = 0.001;
            comp.release.value = msToSeconds(DEFAULT_DYNAMICS.limiterReleaseMs);

            return {
                node: comp,
                brickwall: false,
                setSmoothing: (seconds) => rampParam(comp.attack, seconds),
                setRelease: (seconds) => rampParam(comp.release, seconds)
            };
        }
    }

    async function createLimiter(ctx) {
        const input = ctx.createGain();

        // Drive sits ahead of the limiter, so raising Loudness pushes signal
        // into a fixed ceiling rather than adding gain after the only stage
        // protecting the output. This is the LoudMax threshold control: lowering
        // the threshold and making up the difference is the same operation.
        const drive = ctx.createGain();
        drive.gain.value = 1.0;

        const limiter = await createBrickwallNode(ctx);

        input.connect(drive);
        drive.connect(limiter.node);

        return {
            input,
            output: limiter.node,
            drive,
            brickwall: limiter.brickwall,
            setSmoothing: limiter.setSmoothing,
            setRelease: limiter.setRelease
        };
    }

    function updateDSPChain() {
        if (!STATE.audioContext || !STATE.masterGain || !STATE.limiter || !STATE.eq) return;

        // Disconnect all potential intermediate nodes to reset the chain
        try {
            STATE.masterGain.disconnect();
        } catch (_) {}
        try {
            if (STATE.hpFilter) STATE.hpFilter.disconnect();
        } catch (_) {}
        try {
            STATE.eq.output.disconnect();
        } catch (_) {}

        let currentNode = STATE.masterGain;

        // 1. Highpass Filter (Optional)
        if (STATE.hpEnabled) {
            if (!STATE.hpFilter) {
                STATE.hpFilter = createBiquadHighpass(STATE.audioContext, 200);
            }
            currentNode.connect(STATE.hpFilter);
            currentNode = STATE.hpFilter;
        }

        // 2. Equalizer (Optional)
        if (STATE.eqEnabled) {
            currentNode.connect(STATE.eq.input);
            currentNode = STATE.eq.output;
        }

        // 3. Limiter (Always last before destination)
        currentNode.connect(STATE.limiter.input);
    }

    function generateFIRFilter(sampleRate, filterType, cutoffFreq, filterLength = 127) {
        // Generate FIR filter coefficients using windowed sinc method because math
        // This creates linear phase filters that avoid phase distortion
        // Reduced filter length to minimize latency and processing overhead
        // Cycles per sample, which is what sin(2*pi*F*n)/(pi*n) expects. Using
        // cutoff/nyquist here instead doubled every cutoff, and pushed the
        // 20 kHz lowpass past 0.5 where the sinc stops being a lowpass at all
        // and turns into a ~2x passthrough (the band's old +6 dB error).
        const normalizedFreq = Math.min(cutoffFreq / sampleRate, 0.4999);
        const halfLength = Math.floor(filterLength / 2);
        const coefficients = new Float32Array(filterLength);

        // Generate sinc function
        for (let i = 0; i < filterLength; i++) {
            const n = i - halfLength;
            if (n === 0) {
                coefficients[i] = 2 * normalizedFreq;
            } else {
                const sinc = Math.sin(2 * Math.PI * normalizedFreq * n) / (Math.PI * n);
                // Apply Hamming window
                const window = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (filterLength - 1));
                coefficients[i] = sinc * window;
            }
        }

        // For highpass, subtract lowpass from impulse
        if (filterType === 'highpass') {
            const impulse = new Float32Array(filterLength);
            impulse[halfLength] = 1;
            for (let i = 0; i < filterLength; i++) {
                coefficients[i] = impulse[i] - coefficients[i];
            }
        }

        // Normalize to unity passband gain by evaluating the filter's own
        // response where its passband lives: DC for a lowpass, Nyquist for a
        // highpass. Normalizing a highpass by peak coefficient magnitude
        // instead (which is not passband gain) left the 2.5 kHz band running
        // 8 dB hot.
        let passbandGain = 0;
        if (filterType === 'lowpass') {
            // H(0) = sum(h[n])
            for (let i = 0; i < filterLength; i++) passbandGain += coefficients[i];
        } else {
            // H(Nyquist) = sum(h[n] * (-1)^n)
            for (let i = 0; i < filterLength; i++) {
                passbandGain += (i % 2 === 0) ? coefficients[i] : -coefficients[i];
            }
        }

        if (Math.abs(passbandGain) > 1e-12) {
            const factor = 1.0 / passbandGain;
            for (let i = 0; i < filterLength; i++) coefficients[i] *= factor;
        }

        return coefficients;
    }

    function createBiquadHighpass(ctx, cutoffHz) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = cutoffHz;
        filter.Q.value = 1.0; // Quality factor

        return filter;
    }

    // CRITICAL: ConvolverNode.normalize defaults to true, which applies an
    // equal-power scaling calibrated for multi-second reverb impulses. On a
    // 127-tap FIR that works out to between -19 dB and -43 dB per filter, and
    // there are two per band. It must be set to false, and it is only read at
    // the moment .buffer is assigned, so the order below matters.
    function createFIRConvolver(ctx, coefficients, sampleRate) {
        const convolver = ctx.createConvolver();
        convolver.normalize = false;

        const buffer = ctx.createBuffer(1, coefficients.length, sampleRate);
        buffer.copyToChannel(coefficients, 0);
        convolver.buffer = buffer;

        return convolver;
    }

    function createLinearPhaseBandpass(ctx, lowHz, highHz) {
        const sampleRate = ctx.sampleRate;

        // Lowpass sets the band's upper edge, highpass its lower edge.
        const lowpassConvolver = createFIRConvolver(
            ctx, generateFIRFilter(sampleRate, 'lowpass', highHz), sampleRate
        );
        const highpassConvolver = createFIRConvolver(
            ctx, generateFIRFilter(sampleRate, 'highpass', lowHz), sampleRate
        );

        // Chain highpass into lowpass to create a band-pass
        highpassConvolver.connect(lowpassConvolver);

        return {
            input: highpassConvolver,
            output: lowpassConvolver,
            first: highpassConvolver,
            last: lowpassConvolver
        };
    }

    function createBand(ctx, lowHz, highHz, trimDb) {
        // Split band using linear phase filters
        const filters = createLinearPhaseBandpass(ctx, lowHz, highHz);

        const splitter = ctx.createGain();
        const dynamics = effectiveDynamics();
        const compAttack = msToSeconds(dynamics.compAttackMs);
        const compRelease = msToSeconds(dynamics.compReleaseMs);
        const profile = loudnessProfile(loudnessAmount(STATE.limiterThresholdDb));

        // Downward path: holds the loud end of the band in check, then makeup
        // returns full-scale content to where it started so the compression
        // reads as density rather than as a volume drop.
        const downComp = ctx.createDynamicsCompressor();
        downComp.threshold.value = profile.downward.thresholdDb;
        downComp.knee.value = profile.downward.kneeDb;
        downComp.ratio.value = profile.downward.ratio;
        downComp.attack.value = compAttack;
        downComp.release.value = compRelease;

        const downMakeup = ctx.createGain();
        downMakeup.gain.value = dbToGain(unityMakeupDb(profile.downward));

        // Upward path: a low threshold with a high ratio collapses the band's
        // dynamic range from the bottom, and the makeup below restores the loud
        // end exactly, so the net effect is that only quiet content is lifted.
        // (DynamicsCompressorNode clamps ratio to 1-20, so a sub-1 ratio cannot
        // be used to get upward behaviour directly.)
        const upComp = ctx.createDynamicsCompressor();
        upComp.threshold.value = profile.upward.thresholdDb;
        upComp.knee.value = profile.upward.kneeDb;
        upComp.ratio.value = profile.upward.ratio;
        upComp.attack.value = clamp(compAttack * UPWARD_ATTACK_SCALE, 0, 1);
        upComp.release.value = clamp(compRelease * UPWARD_RELEASE_SCALE, 0, 1);

        const upMakeup = ctx.createGain();
        upMakeup.gain.value = dbToGain(unityMakeupDb(profile.upward));

        // Both paths share the FIR delay, so a fixed wet mix is phase-safe.
        const downGain = ctx.createGain();
        downGain.gain.value = BLEND.down;

        const upGain = ctx.createGain();
        upGain.gain.value = BLEND.up;

        // Tonal trim only, correcting the splitter's own response.
        const trim = ctx.createGain();
        trim.gain.value = dbToGain(trimDb);

        filters.last.connect(splitter);

        splitter.connect(downComp);
        downComp.connect(downMakeup);
        downMakeup.connect(downGain);

        splitter.connect(upComp);
        upComp.connect(upMakeup);
        upMakeup.connect(upGain);

        downGain.connect(trim);
        upGain.connect(trim);

        return {
            input: filters.first,
            output: trim,
            downComp,
            upComp,
            downMakeup,
            upMakeup,
            downGain,
            upGain
        };
    }

    function applyDynamics() {
        const dynamics = effectiveDynamics();
        const compAttack = msToSeconds(dynamics.compAttackMs);
        const compRelease = msToSeconds(dynamics.compReleaseMs);
        const upAttack = clamp(compAttack * UPWARD_ATTACK_SCALE, 0, 1);
        const upRelease = clamp(compRelease * UPWARD_RELEASE_SCALE, 0, 1);
        const preBoost = dbToGain(dynamics.preBoostDb);

        STATE.mediaElToNodes.forEach((nodes) => {
            rampParam(nodes.preGain.gain, preBoost);
            [nodes.low, nodes.mid, nodes.high].forEach((band) => {
                if (!band) return;
                band.downComp.attack.value = compAttack;
                band.downComp.release.value = compRelease;
                band.upComp.attack.value = upAttack;
                band.upComp.release.value = upRelease;
            });
        });

        if (STATE.limiter) {
            STATE.limiter.setSmoothing(msToSeconds(dynamics.limiterAttackMs));
            STATE.limiter.setRelease(msToSeconds(dynamics.limiterReleaseMs));
        }
    }

    // Morph compressor strength and limiter drive together. No dry/wet mix:
    // that would comb against the FIR and look-ahead delays.
    function applyLoudness(thresholdDb) {
        const profile = loudnessProfile(loudnessAmount(thresholdDb));

        if (STATE.limiter && STATE.limiter.drive) {
            rampParam(STATE.limiter.drive.gain, dbToGain(profile.driveDb));
        }

        STATE.mediaElToNodes.forEach((nodes) => {
            [nodes.low, nodes.mid, nodes.high].forEach((band) => {
                if (!band) return;
                applyCompressorSettings(band.downComp, band.downMakeup, profile.downward);
                applyCompressorSettings(band.upComp, band.upMakeup, profile.upward);
            });
        });
    }

    async function wireMediaElement(mediaEl) {
        if (STATE.mediaElToNodes.has(mediaEl) || STATE.pendingElements.has(mediaEl)) return;

        // Checked before building anything, so a page that only carries DRM
        // content never gets an AudioContext at all.
        if (mediaEl.mediaKeys != null || mediaEl.encrypted || mediaEl.hasAttribute('data-eme')) {
            console.log('ThunderFox: DRM protected content detected, bypassing audio processing');
            return;
        }

        // Loading the limiter worklet is asynchronous, so the same element can
        // arrive again from the observer before the first call finishes.
        STATE.pendingElements.add(mediaEl);
        try {
            await ensureAudioContext();
        } catch (error) {
            STATE.pendingElements.delete(mediaEl);
            console.log('ThunderFox: Unable to start audio processing:', error);
            return;
        }

        try {
            if (STATE.mediaElToNodes.has(mediaEl) || !mediaEl.isConnected) return;

            const ctx = STATE.audioContext;

            let source;
            try {
                source = ctx.createMediaElementSource(mediaEl);
            } catch (error) {
                console.log('ThunderFox: Unable to access media element audio:', error);
                return;
            }

            // Pre-boost sits ahead of the bands, so raising it drives the
            // compressors harder and adds density as well as level.
            const preGain = ctx.createGain();
            preGain.gain.value = dbToGain(effectiveDynamics().preBoostDb);

            const low = createBand(ctx, 20, 200, BAND_TRIM_DB.low);
            const mid = createBand(ctx, 200, 2500, BAND_TRIM_DB.mid);
            const high = createBand(ctx, 2500, 20000, BAND_TRIM_DB.high);

            source.connect(preGain);
            preGain.connect(low.input);
            preGain.connect(mid.input);
            preGain.connect(high.input);

            low.output.connect(STATE.masterGain);
            mid.output.connect(STATE.masterGain);
            high.output.connect(STATE.masterGain);

            STATE.mediaElToNodes.set(mediaEl, { source, preGain, low, mid, high });
            applyEnabledState(mediaEl);

            console.log('ThunderFox: Media element wired successfully', {
                enabled: STATE.enabled,
                brickwall: STATE.limiter ? STATE.limiter.brickwall : false
            });
        } finally {
            STATE.pendingElements.delete(mediaEl);
        }
    }

    function unwireMediaElement(mediaEl) {
        const nodes = STATE.mediaElToNodes.get(mediaEl);
        if (!nodes) return;
        try {
            nodes.source.disconnect();
            nodes.low.output.disconnect();
            nodes.mid.output.disconnect();
            nodes.high.output.disconnect();
        } catch (_) {}
        STATE.mediaElToNodes.delete(mediaEl);
    }

    function applyEnabledState(mediaEl) {
        const nodes = STATE.mediaElToNodes.get(mediaEl);
        if (!nodes) return;
        // When enabled, route through our graph; when disabled, bypass to destination
        try {
            nodes.source.disconnect();
        } catch (_) {}

        if (STATE.enabled) {
            nodes.source.connect(nodes.preGain);
            nodes.preGain.connect(nodes.low.input);
            nodes.preGain.connect(nodes.mid.input);
            nodes.preGain.connect(nodes.high.input);
        } else {
            // Bypass: connect straight to destination
            nodes.source.connect(STATE.audioContext.destination);
        }
    }

    function applyEnabledStateAll() {
        STATE.mediaElToNodes.forEach((_, el) => applyEnabledState(el));
    }

    // A subframe cannot read the top-level URL cross-origin and Firefox has no
    // location.ancestorOrigins, so the background page resolves it.
    async function getTopLevelHostname() {
        try {
            const response = await browser.runtime.sendMessage({ type: 'THUNDERFOX_GET_TOP_URL' });
            if (!response || !response.url) return '';
            return new URL(response.url).hostname;
        } catch (_) {
            return '';
        }
    }

    async function isPageExempted(exemptedSites) {
        if (ThunderFoxSites.isHostnameExempted(window.location.hostname, exemptedSites)) return true;
        if (window.top === window.self) return false;

        // An exempted page must stay exempted for every frame it embeds.
        const topHostname = await getTopLevelHostname();
        return ThunderFoxSites.isHostnameExempted(topHostname, exemptedSites);
    }

    async function init() {
        const stored = await browser.storage.local.get({
            enabled: true,
            limiterThreshold: DEFAULT_LIMITER_THRESHOLD,
            eqGains: [0, 0, 0, 0, 0, 0, 0, 0],
            eqEnabled: true,
            hpEnabled: false,
            exemptedSites: null,
            advancedEnabled: false,
            preBoostDb: DEFAULT_DYNAMICS.preBoostDb,
            compAttackMs: DEFAULT_DYNAMICS.compAttackMs,
            compReleaseMs: DEFAULT_DYNAMICS.compReleaseMs,
            limiterAttackMs: DEFAULT_DYNAMICS.limiterAttackMs,
            limiterReleaseMs: DEFAULT_DYNAMICS.limiterReleaseMs
        });

        const exemptedSites = ThunderFoxSites.getStoredExemptedSites(
            stored.exemptedSites === null ? undefined : stored.exemptedSites
        );

        // Bail out before creating an AudioContext, observing the DOM or
        // registering any listener. Once createMediaElementSource() has been
        // called on an element there is no way back, so an exempted page has to
        // stay completely untouched; the popup reloads the tab when the
        // exemption list changes.
        if (await isPageExempted(exemptedSites)) {
            console.info('ThunderFox: site is exempted, staying inert', {
                hostname: window.location.hostname
            });
            return;
        }

        STATE.enabled = !!stored.enabled;
        STATE.eqEnabled = stored.eqEnabled !== undefined ? !!stored.eqEnabled : true;
        STATE.hpEnabled = !!stored.hpEnabled;
        STATE.limiterThresholdDb = typeof stored.limiterThreshold === 'number'
            ? stored.limiterThreshold
            : DEFAULT_LIMITER_THRESHOLD;
        STATE.eqGains = Array.isArray(stored.eqGains) && stored.eqGains.length === 8
            ? stored.eqGains.map(g => clamp(typeof g === 'number' ? g : 0, -18, 18))
            : [0, 0, 0, 0, 0, 0, 0, 0];
        STATE.advancedEnabled = !!stored.advancedEnabled;
        STATE.dynamics = sanitizeDynamics(stored);

        // Wire existing media elements
        document.querySelectorAll('audio, video').forEach(wireMediaElement);

        // Observe future media elements
        STATE.observer = new MutationObserver(muts => {
            for (const m of muts) {
                m.addedNodes && m.addedNodes.forEach(node => {
                    if (node && (node.tagName === 'AUDIO' || node.tagName === 'VIDEO')) {
                        wireMediaElement(node);
                    } else if (node && node.querySelectorAll) {
                        node.querySelectorAll('audio, video').forEach(wireMediaElement);
                    }
                });
                m.removedNodes && m.removedNodes.forEach(node => {
                    if (node && (node.tagName === 'AUDIO' || node.tagName === 'VIDEO')) {
                        unwireMediaElement(node);
                    } else if (node && node.querySelectorAll) {
                        node.querySelectorAll('audio, video').forEach(unwireMediaElement);
                    }
                });
            }
        });
        STATE.observer.observe(document.documentElement || document.body, { childList: true, subtree: true });

        // Listen for control messages
        browser.runtime.onMessage.addListener((msg) => {
            if (msg && msg.type === 'THUNDERFOX_TOGGLE') {
                STATE.enabled = !!msg.enabled;
                applyEnabledStateAll();
                return;
            }
            if (msg && msg.type === 'THUNDERFOX_HP_TOGGLE') {
                STATE.hpEnabled = !!msg.enabled;
                updateDSPChain();
                return;
            }
            if (msg && msg.type === 'THUNDERFOX_EQ_TOGGLE') {
                STATE.eqEnabled = !!msg.enabled;
                updateDSPChain();
                return;
            }
            if (msg && msg.type === 'THUNDERFOX_LIMITER_THRESHOLD') {
                const th = typeof msg.threshold === 'number' ? msg.threshold : DEFAULT_LIMITER_THRESHOLD;
                STATE.limiterThresholdDb = th;
                applyLoudness(th);
                return;
            }
            if (msg && msg.type === 'THUNDERFOX_EQ_GAIN') {
                if (typeof msg.bandIndex === 'number' && typeof msg.gainDb === 'number') {
                    const bandIndex = clamp(Math.floor(msg.bandIndex), 0, 7);
                    const gainDb = clamp(msg.gainDb, -18, 18);
                    STATE.eqGains[bandIndex] = gainDb;
                    if (STATE.eq && STATE.eq.setGain) {
                        STATE.eq.setGain(bandIndex, gainDb);
                    }
                }
                return;
            }
            if (msg && msg.type === 'THUNDERFOX_EQ_GAINS') {
                if (Array.isArray(msg.gainsDb) && msg.gainsDb.length === 8) {
                    STATE.eqGains = msg.gainsDb.map(g => clamp(typeof g === 'number' ? g : 0, -18, 18));
                    if (STATE.eq && STATE.eq.setGains) {
                        STATE.eq.setGains(STATE.eqGains);
                    }
                }
                return;
            }
            if (msg && msg.type === 'THUNDERFOX_DYNAMICS') {
                if (typeof msg.advancedEnabled === 'boolean') {
                    STATE.advancedEnabled = msg.advancedEnabled;
                }
                STATE.dynamics = sanitizeDynamics(msg);
                applyDynamics();
                return;
            }
        });

        // Listen for storage changes so toggles take effect even if
        // Popup messaging to the active tab fails (e.g. different window/tab)
        browser.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            try {
                if (changes.enabled) {
                    STATE.enabled = !!changes.enabled.newValue;
                    applyEnabledStateAll();
                }
                if (changes.hpEnabled) {
                    STATE.hpEnabled = !!changes.hpEnabled.newValue;
                    updateDSPChain();
                }
                if (changes.eqEnabled) {
                    STATE.eqEnabled = !!changes.eqEnabled.newValue;
                    updateDSPChain();
                }
                if (changes.limiterThreshold) {
                    const th = typeof changes.limiterThreshold.newValue === 'number'
                        ? changes.limiterThreshold.newValue
                        : DEFAULT_LIMITER_THRESHOLD;
                    STATE.limiterThresholdDb = th;
                    applyLoudness(th);
                }
                if (changes.eqGains) {
                    const gains = changes.eqGains.newValue;
                    if (Array.isArray(gains) && gains.length === 8) {
                        STATE.eqGains = gains.map(g => clamp(typeof g === 'number' ? g : 0, -18, 18));
                        if (STATE.eq && STATE.eq.setGains) {
                            STATE.eq.setGains(STATE.eqGains);
                        }
                    }
                }

                const dynamicsKeys = Object.keys(DEFAULT_DYNAMICS);
                const dynamicsChanged = dynamicsKeys.some(key => changes[key]);
                if (changes.advancedEnabled || dynamicsChanged) {
                    if (changes.advancedEnabled) {
                        STATE.advancedEnabled = !!changes.advancedEnabled.newValue;
                    }
                    const next = Object.assign({}, STATE.dynamics);
                    dynamicsKeys.forEach((key) => {
                        if (changes[key]) next[key] = changes[key].newValue;
                    });
                    STATE.dynamics = sanitizeDynamics(next);
                    applyDynamics();
                }
            } catch (e) {
                console.error('ThunderFox: error handling storage.onChanged', e, changes);
            }
        });

        // Loudness, dynamics, EQ gains and routing are all applied by
        // buildAudioContext(), which does not run until the first media
        // element is wired.
    }

    // Fire up the bass cannon
    init().catch(() => {});
})();
