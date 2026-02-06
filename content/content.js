(function() {
    const STATE = {
        audioContext: null,
        mediaElToNodes: new Map(),
        masterGain: null,
        limiter: null,
        enabled: true,
        observer: null,
        limiterThresholdDb: 0,
        hpEnabled: false,
        eqEnabled: true,
        eq: null,
        eqGains: [0, 0, 0, 0, 0, 0, 0, 0] // 8 bands, default 0 dB
    };

    function ensureAudioContext() {
        if (!STATE.audioContext) {
            STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            STATE.masterGain = STATE.audioContext.createGain();
            STATE.masterGain.gain.value = 5.0; // it's loud AF
            // Final limiter
            STATE.limiter = createLimiter(STATE.audioContext);
            // Highpass filter placed after multiband output but before limiter (biquad, 200Hz)
            STATE.hpFilter = createBiquadHighpass(STATE.audioContext, 200);
            // 8-band equalizer before limiter
            STATE.eq = create8BandEQ(STATE.audioContext);

            // Wire DSP chain
            updateDSPChain();
            STATE.limiter.output.connect(STATE.audioContext.destination);
        }
    }

    function create8BandEQ(ctx) {
        // Standard 8-band EQ frequencies (Hz)
        const frequencies = [68, 147, 315, 678, 1464, 3153, 6787, 14635];
        const Q = 1.0; // Quality factor for reasonable bandwidth
        
        const input = ctx.createGain();
        const filters = [];
        
        // Create 8 peaking filters in series
        let currentNode = input;
        frequencies.forEach((freq, index) => {
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
                    filters[bandIndex].gain.value = gainDb;
                }
            },
            setGains: (gainsDb) => {
                gainsDb.forEach((gainDb, index) => {
                    if (index < filters.length) {
                        filters[index].gain.value = gainDb;
                    }
                });
            }
        };
    }

    function createLimiter(ctx) {
        const input = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = 0; // aim for peak output near 0 dB
        comp.knee.value = 0;
        comp.ratio.value = 20; // brickwall-ish
        comp.attack.value = 0.001; // Faster attack for better limiting
        comp.release.value = 0.1; // Faster release for aggressive limiting

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
                STATE.hpFilter = createBiquadHighpass(STATE.audioContext, 100);
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

    function createBiquadHighpass(ctx, cutoffHz) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = cutoffHz;
        filter.Q.value = 1.0; // Quality factor
        
        return filter;
    }

    function createLinearPhaseBandpass(ctx, lowHz, highHz) {
        const sampleRate = ctx.sampleRate;
        
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
        const { enabled, limiterThreshold, eqGains, eqEnabled, hpEnabled } = await browser.storage.local.get({ 
            enabled: true, 
            limiterThreshold: 0,
            eqGains: [0, 0, 0, 0, 0, 0, 0, 0],
            eqEnabled: true,
            hpEnabled: false
        });
        STATE.enabled = !!enabled;
        STATE.eqEnabled = eqEnabled !== undefined ? !!eqEnabled : true;
        STATE.hpEnabled = !!hpEnabled;
        STATE.limiterThresholdDb = typeof limiterThreshold === 'number' ? limiterThreshold : -6; // default threshold
        STATE.eqGains = Array.isArray(eqGains) && eqGains.length === 8 
            ? eqGains.map(g => Math.max(-18, Math.min(18, typeof g === 'number' ? g : 0)))
            : [0, 0, 0, 0, 0, 0, 0, 0];

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
                    console.debug('ThunderFox: received THUNDERFOX_TOGGLE', msg);
                    STATE.enabled = !!msg.enabled;
                    applyEnabledStateAll();
                    return;
            }
            if (msg && msg.type === 'THUNDERFOX_HP_TOGGLE') {
                    console.debug('ThunderFox: received THUNDERFOX_HP_TOGGLE', msg);
                    const en = !!msg.enabled;
                    STATE.hpEnabled = en;
                    updateDSPChain();
                    return;
            }
            if (msg && msg.type === 'THUNDERFOX_EQ_TOGGLE') {
                    console.debug('ThunderFox: received THUNDERFOX_EQ_TOGGLE', msg);
                    const en = !!msg.enabled;
                    STATE.eqEnabled = en;
                    updateDSPChain();
                    return;
            }
            if (msg && msg.type === 'THUNDERFOX_LIMITER_THRESHOLD') {
                    console.debug('ThunderFox: received THUNDERFOX_LIMITER_THRESHOLD', msg);
                    const th = typeof msg.threshold === 'number' ? msg.threshold : -3;
                    STATE.limiterThresholdDb = th;
                    if (STATE.limiter && STATE.limiter.comp) {
                        STATE.limiter.comp.threshold.value = th;
                    }
                    updateLimiterCompensation(th);
                    return;
            }
            if (msg && msg.type === 'THUNDERFOX_EQ_GAIN') {
                    console.debug('ThunderFox: received THUNDERFOX_EQ_GAIN', msg);
                    if (typeof msg.bandIndex === 'number' && typeof msg.gainDb === 'number') {
                        const bandIndex = Math.max(0, Math.min(7, Math.floor(msg.bandIndex)));
                        const gainDb = Math.max(-18, Math.min(18, msg.gainDb));
                        STATE.eqGains[bandIndex] = gainDb;
                        if (STATE.eq && STATE.eq.setGain) {
                            STATE.eq.setGain(bandIndex, gainDb);
                        }
                    }
                    return;
            }
            if (msg && msg.type === 'THUNDERFOX_EQ_GAINS') {
                    console.debug('ThunderFox: received THUNDERFOX_EQ_GAINS', msg);
                    if (Array.isArray(msg.gainsDb) && msg.gainsDb.length === 8) {
                        STATE.eqGains = msg.gainsDb.map(g => Math.max(-18, Math.min(18, typeof g === 'number' ? g : 0)));
                        if (STATE.eq && STATE.eq.setGains) {
                            STATE.eq.setGains(STATE.eqGains);
                        }
                    }
                    return;
            }
        });

            // Listen for storage changes so toggles take effect even if
            // Popup messaging to the active tab fails (e.g. different window/tab)
            browser.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;
                try {
                    if (changes.enabled) {
                        console.debug('ThunderFox: storage changed enabled ->', changes.enabled.newValue);
                        STATE.enabled = !!changes.enabled.newValue;
                        applyEnabledStateAll();
                    }
                    if (changes.hpEnabled) {
                        console.debug('ThunderFox: storage changed hpEnabled ->', changes.hpEnabled.newValue);
                        STATE.hpEnabled = !!changes.hpEnabled.newValue;
                        updateDSPChain();
                    }
                    if (changes.eqEnabled) {
                        console.debug('ThunderFox: storage changed eqEnabled ->', changes.eqEnabled.newValue);
                        STATE.eqEnabled = !!changes.eqEnabled.newValue;
                        updateDSPChain();
                    }
                    if (changes.limiterThreshold) {
                        console.debug('ThunderFox: storage changed limiterThreshold ->', changes.limiterThreshold.newValue);
                        const th = typeof changes.limiterThreshold.newValue === 'number' ? changes.limiterThreshold.newValue : -3;
                        STATE.limiterThresholdDb = th;
                        if (STATE.limiter && STATE.limiter.comp) {
                            STATE.limiter.comp.threshold.value = th;
                        }
                        updateLimiterCompensation(th);
                    }
                    if (changes.eqGains) {
                        console.debug('ThunderFox: storage changed eqGains ->', changes.eqGains.newValue);
                        if (Array.isArray(changes.eqGains.newValue) && changes.eqGains.newValue.length === 8) {
                            STATE.eqGains = changes.eqGains.newValue.map(g => Math.max(-18, Math.min(18, typeof g === 'number' ? g : 0)));
                            if (STATE.eq && STATE.eq.setGains) {
                                STATE.eq.setGains(STATE.eqGains);
                            }
                        }
                    }
                } catch (e) {
                    console.error('ThunderFox: error handling storage.onChanged', e, changes);
                }
            });
        // Apply initial limiter threshold
        if (STATE.limiter && STATE.limiter.comp) {
            STATE.limiter.comp.threshold.value = STATE.limiterThresholdDb;
        }
        updateLimiterCompensation(STATE.limiterThresholdDb);

        // Apply initial EQ gains
        if (STATE.eq && STATE.eq.setGains) {
            STATE.eq.setGains(STATE.eqGains);
        }

        // Apply initial routing
        updateDSPChain();
    }

    // Fire up the bass cannon
    init().catch(() => {});
})();
