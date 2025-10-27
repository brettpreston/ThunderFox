(function() {
    const STATE = {
        audioContext: null,
        mediaElToNodes: new Map(),
        masterGain: null,
        limiter: null,
        enabled: true,
        observer: null,
        limiterThresholdDb: 0,
        hpEnabled: true
    };

    function ensureAudioContext() {
        if (!STATE.audioContext) {
            STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            STATE.masterGain = STATE.audioContext.createGain();
            STATE.masterGain.gain.value = 5.0; // it's loud AF
            // Final limiter
            STATE.limiter = createLimiter(STATE.audioContext);
            // Highpass filter placed after multiband output and before limiter
            const hp = STATE.audioContext.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = 200;
            hp.Q.value = 0.707;
            STATE.hpFilter = hp;

            // Wire master gain -> highpass -> limiter -> destination
            STATE.masterGain.connect(STATE.hpFilter);
            STATE.hpFilter.connect(STATE.limiter.input);
            STATE.limiter.output.connect(STATE.audioContext.destination);
        }
    }

    function createLimiter(ctx) {
        const input = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = 0; // aim for peak output near 0 dB
        comp.knee.value = 0;
        comp.ratio.value = 20; // brickwall-ish
        comp.attack.value = 0.001; // Faster attack for better limiting
        comp.release.value = 0.1; // Faster release for more aggressive limiting

        // Gain compensation node
        const compensation = ctx.createGain();
        compensation.gain.value = 1.0;

        const ceiling = ctx.createGain();
        ceiling.gain.value = 0.99;

        input.connect(comp);
        comp.connect(compensation);
        compensation.connect(ceiling);

        return { input, output: ceiling, comp, compensation };
    }

    function applyHighpassState(enabled) {
        if (!STATE.audioContext || !STATE.masterGain || !STATE.limiter) return;
        STATE.hpEnabled = !!enabled;
        try {
            // Disconnect existing masterGain outputs to avoid duplicate connections
            STATE.masterGain.disconnect();
        } catch (_) {}

        if (STATE.hpEnabled) {
            // Ensure hp filter exists
            if (!STATE.hpFilter) {
                const hp = STATE.audioContext.createBiquadFilter();
                hp.type = 'highpass';
                hp.frequency.value = 100;
                hp.Q.value = 0.707;
                STATE.hpFilter = hp;
            }
            STATE.masterGain.connect(STATE.hpFilter);
            try { STATE.hpFilter.disconnect(); } catch (_) {}
            STATE.hpFilter.connect(STATE.limiter.input);
        } else {
            // Bypass highpass: connect master gain directly into limiter input
            STATE.masterGain.connect(STATE.limiter.input);
        }
    }

    function generateFIRFilter(sampleRate, filterType, cutoffFreq, filterLength = 127) {
        // Generate FIR filter coefficients using windowed sinc method because math
        // This creates linear phase filters that avoid phase distortion
        // Reduced filter length to minimize latency and processing overhead
        const nyquist = sampleRate / 2; // yoy
        const normalizedFreq = Math.min(cutoffFreq / nyquist, 0.99); // Clamp to avoid issues
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
        
        // Normalize coefficients in a filter-type-aware way:
        // - For lowpass: normalize by the sum of coefficients to preserve DC (unity) gain.
        // - For highpass: sum(coeffs) is ~0, so normalize by peak magnitude to keep passband level intact.
        if (filterType === 'lowpass') {
            const sum = coefficients.reduce((acc, val) => acc + val, 0);
            if (Math.abs(sum) > 1e-12) {
                const factor = 1.0 / sum;
                for (let i = 0; i < filterLength; i++) coefficients[i] *= factor;
            }
        } else if (filterType === 'highpass') {
            let maxAbs = 0;
            for (let i = 0; i < filterLength; i++) maxAbs = Math.max(maxAbs, Math.abs(coefficients[i]));
            if (maxAbs > 1e-12) {
                const factor = 1.0 / maxAbs;
                for (let i = 0; i < filterLength; i++) coefficients[i] *= factor;
            }
        } else {
            // Generic fallback: normalize by peak magnitude
            let maxAbs = 0;
            for (let i = 0; i < filterLength; i++) maxAbs = Math.max(maxAbs, Math.abs(coefficients[i]));
            if (maxAbs > 1e-12) {
                const factor = 1.0 / maxAbs;
                for (let i = 0; i < filterLength; i++) coefficients[i] *= factor;
            }
        }
        
        return coefficients;
    }

    function createLinearPhaseBandpass(ctx, lowHz, highHz) {
        const sampleRate = ctx.sampleRate;
        
        try {
            // Generate lowpass filter for high frequency cutoff
            const lowpassCoeffs = generateFIRFilter(sampleRate, 'lowpass', highHz);
            const lowpassConvolver = ctx.createConvolver();
            const lowpassBuffer = ctx.createBuffer(1, lowpassCoeffs.length, sampleRate);
            lowpassBuffer.copyToChannel(lowpassCoeffs, 0);
            lowpassConvolver.buffer = lowpassBuffer;
            
            // Generate highpass filter for low frequency cutoff
            const highpassCoeffs = generateFIRFilter(sampleRate, 'highpass', lowHz);
            const highpassConvolver = ctx.createConvolver();
            const highpassBuffer = ctx.createBuffer(1, highpassCoeffs.length, sampleRate);
            highpassBuffer.copyToChannel(highpassCoeffs, 0);
            highpassConvolver.buffer = highpassBuffer;
            
            // Chain highpass into lowpass to create a band-pass
            highpassConvolver.connect(lowpassConvolver);
            
            return { 
                input: highpassConvolver, 
                output: lowpassConvolver, 
                first: highpassConvolver, 
                last: lowpassConvolver 
            };
        } catch (error) {
            console.error('Error creating linear phase bandpass:', error);
            // Fallback to simple biquad filters if FIR fails
            return createFallbackBandpass(ctx, lowHz, highHz);
        }
    }

    function createFallbackBandpass(ctx, lowHz, highHz) {
        // Fallback to biquad filters if FIR implementation fails
        const lowpass = ctx.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = highHz;
        lowpass.Q.value = 0.707;

        const highpass = ctx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = lowHz;
        highpass.Q.value = 0.707;

        // Chain highpass into lowpass to create a band-pass
        highpass.connect(lowpass);

        return { input: highpass, output: lowpass, first: highpass, last: lowpass };
    }

    function createBand(ctx, lowHz, highHz, makeupDb) {
        // Split band using linear phase filters
        const filters = createLinearPhaseBandpass(ctx, lowHz, highHz);

        // Create parallel paths for upward and downward compression
        const splitter = ctx.createGain();
        
        // Downward compression path
        const downComp = ctx.createDynamicsCompressor();
        downComp.threshold.value = -12; // Higher threshold for downward compression
        downComp.knee.value = 6;
        downComp.ratio.value = 4; // Gentler ratio for more natural sound
        downComp.attack.value = 0.003;
        downComp.release.value = 0.1;

        // Upward compression path
        const upComp = ctx.createDynamicsCompressor();
        upComp.threshold.value = -40; // Lower threshold for upward compression
        upComp.knee.value = 6;
        upComp.ratio.value = 0.5; // Ratio < 1 creates upward compression
        upComp.attack.value = 0.005;
        upComp.release.value = 0.15;

        // Gains for parallel processing
        const downGain = ctx.createGain();
        downGain.gain.value = 0.7; // 70% downward compressed signal

        const upGain = ctx.createGain();
        upGain.gain.value = 0.5; // 50% upward compressed signal

        // Makeup gain and final boost
        const makeupGain = ctx.createGain();
        // Clamp excessive makeup gains to avoid pushing limiter into constant engagement
        // Allow more makeup so bands can reach 0 dB if needed
        const clampedMakeupDb = Math.min(makeupDb, 48);
        makeupGain.gain.value = dbToGain(clampedMakeupDb);
        
        const boostGain = ctx.createGain();
        boostGain.gain.value = 10.0; // Boooooooost

        // Wire everything together
        filters.last.connect(splitter);
        
        // Downward compression path
        splitter.connect(downComp);
        downComp.connect(downGain);
        
        // Upward compression path
        splitter.connect(upComp);
        upComp.connect(upGain);
        
        // Sum compressed signals
        downGain.connect(makeupGain);
        upGain.connect(makeupGain);
        
        makeupGain.connect(boostGain);

        return { input: filters.first, output: boostGain };
    }

    function dbToGain(db) {
        return Math.pow(10, db / 20);
    }

    function wireMediaElement(mediaEl) {
        if (STATE.mediaElToNodes.has(mediaEl)) return;
        ensureAudioContext();

        // Check for encrypted media
        if (mediaEl.mediaKeys || mediaEl.mediaKeys !== null || mediaEl.encrypted || mediaEl.hasAttribute('data-eme')) {
            console.log('ThunderFox: DRM protected content detected, bypassing audio processing');
            return; // Skip processing for DRM content
        }

        let source;
        try {
            source = STATE.audioContext.createMediaElementSource(mediaEl);
        } catch (error) {
            console.log('ThunderFox: Unable to access media element audio:', error);
            return;
        }
            
        // Pre-gain boost to ensure sufficient signal level
        const preGain = STATE.audioContext.createGain();
        preGain.gain.value = 1.0; // no extra pre-boost to avoid forcing limiter

        // Bands: Low (20-250), Mid (250-4k), High (4k-20k)
        // Dramatically increased makeup gain to compensate for volume loss
        const low = createBand(STATE.audioContext, 20, 200, 20);
        const mid = createBand(STATE.audioContext, 200, 2500, 35);
        const high = createBand(STATE.audioContext, 2500, 20000, 40);

        console.log('ThunderFox: Created bands for media element', { low, mid, high });

        // Splitter wiring with pre-gain
        source.connect(preGain);
        preGain.connect(low.input);
        preGain.connect(mid.input);
        preGain.connect(high.input);

        // Sum
        low.output.connect(STATE.masterGain);
        mid.output.connect(STATE.masterGain);
        high.output.connect(STATE.masterGain);
    STATE.mediaElToNodes.set(mediaEl, { source, preGain, low, mid, high });
    applyEnabledState(mediaEl);
        
        console.log('ThunderFox: Media element wired successfully', { enabled: STATE.enabled });
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

        console.log('ThunderFox: Applying enabled state', { enabled: STATE.enabled });

        if (STATE.enabled) {
            nodes.source.connect(nodes.preGain);
            nodes.preGain.connect(nodes.low.input);
            nodes.preGain.connect(nodes.mid.input);
            nodes.preGain.connect(nodes.high.input);
            console.log('ThunderFox: Connected to processing bands');
        } else {
            // Bypass: connect straight to destination
            nodes.source.connect(STATE.audioContext.destination);
            console.log('ThunderFox: Connected to destination (bypass)');
        }
    }


    function applyEnabledStateAll() {
        STATE.mediaElToNodes.forEach((_, el) => applyEnabledState(el));
    }

    function updateLimiterCompensation(thresholdDb) {
        // As threshold is reduced, increase gain so output peaks approach 0 dB
        // Formula: compensationDb = -thresholdDb
        // Clamp to max +24 dB for safety
        const compensationDb = Math.max(0, Math.min(-thresholdDb, 24));
        const compensationGain = Math.pow(10, compensationDb / 20);
        if (STATE.limiter && STATE.limiter.compensation) {
            STATE.limiter.compensation.gain.value = compensationGain;
        }
    }

    async function init() {
        const { enabled, limiterThreshold } = await browser.storage.local.get({ enabled: true, limiterThreshold: 0 });
        STATE.enabled = !!enabled;
        STATE.limiterThresholdDb = typeof limiterThreshold === 'number' ? limiterThreshold : -6; // default threshold

        // Wire existing media elements
        document.querySelectorAll('audio, video').forEach(wireMediaElement);

        // Observe future media elements
        STATE.observer = new MutationObserver(muts => {
            for (const m of muts) {
                m.addedNodes && m.addedNodes.forEach(node => {
                    if (node && (node.tagName === 'AUDIO' || node.tagName === 'VIDEO')) {
                        wireMediaElement(node);
                    } else if (node && node.querySelectorAll) {
                        node.querySelectorAll && node.querySelectorAll('audio, video').forEach(wireMediaElement);
                    }
                });
                m.removedNodes && m.removedNodes.forEach(node => {
                    if (node && (node.tagName === 'AUDIO' || node.tagName === 'VIDEO')) {
                        unwireMediaElement(node);
                    } else if (node && node.querySelectorAll) {
                        node.querySelectorAll && node.querySelectorAll('audio, video').forEach(unwireMediaElement);
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
                const en = !!msg.enabled;
                applyHighpassState(en);
                return;
            }
            if (msg && msg.type === 'THUNDERFOX_LIMITER_THRESHOLD') {
                const th = typeof msg.threshold === 'number' ? msg.threshold : -3;
                STATE.limiterThresholdDb = th;
                if (STATE.limiter && STATE.limiter.comp) {
                    STATE.limiter.comp.threshold.value = th;
                }
                updateLimiterCompensation(th);
                return;
            }
        });

        // Apply initial limiter threshold
        if (STATE.limiter && STATE.limiter.comp) {
            STATE.limiter.comp.threshold.value = STATE.limiterThresholdDb;
        }
        updateLimiterCompensation(STATE.limiterThresholdDb);

        // Apply initial highpass state (from storage) and ensure wiring
        const { hpEnabled } = await browser.storage.local.get({ hpEnabled: true });
        applyHighpassState(!!hpEnabled);
    }

    // Kickoff
    init().catch(() => {});
})();


