(function() {
    const S = ThunderFoxSettings;

    const OTT_WORKLET_PATH = 'content/ott-processor.js';
    const OTT_WORKLET_NAME = 'thunderfox-ott';
    const LIMITER_WORKLET_PATH = 'content/limiter-processor.js';
    const LIMITER_WORKLET_NAME = 'thunderfox-brickwall-limiter';

    const PARAM_SMOOTHING_SECONDS = 0.02;

    // How long the summed input may read as digital silence while something is
    // playing before we conclude the page's audio has been silenced rather than
    // merely quiet.
    const SILENCE_TIMEOUT_MS = 2000;
    const WATCHDOG_INTERVAL_MS = 500;

    const STATE = {
        audioContext: null,
        contextReady: null,
        contextFailed: false,

        inputGain: null,
        preGain: null,
        ott: null,
        hpFilter: null,
        eq: null,
        limiter: null,
        analyser: null,

        // Permanent. A MediaElementAudioSourceNode binds to its element for the
        // life of the document and cannot be recreated, so an entry here is
        // never deleted — only disconnected. Dropping it and letting the element
        // come back is what used to mute it forever.
        mediaNodes: new Map(),
        wiring: new Set(),
        skipped: new WeakSet(),
        watched: new WeakSet(),
        protectedElements: new WeakSet(),
        observedRoots: new WeakSet(),

        observer: null,
        pendingRoots: new Set(),
        scanTimer: null,
        inert: false,

        meterPorts: new Set(),
        watchdogTimer: null,
        silenceSince: 0,
        silenceReported: false,

        settings: Object.assign({}, S.DEFAULTS),
        applied: {}
    };

    function dbToGain(db) {
        return Math.pow(10, db / 20);
    }

    function msToSeconds(ms) {
        return S.clamp(ms / 1000, 0, 1);
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

    // Structural parameters — ones the worklet turns into a buffer length rather
    // than a coefficient — must step, not ramp. Ramping the limiter's smoothing
    // makes it a different integer on nearly every render quantum, which rebuilds
    // the boxcar sum on the audio thread over and over.
    function setParam(param, value) {
        if (!param) return;
        if (!STATE.audioContext) {
            param.value = value;
            return;
        }
        const now = STATE.audioContext.currentTime;
        param.cancelScheduledValues(now);
        param.setValueAtTime(value, now);
    }

    /* ---------------------------------------------------------------- graph */

    function ensureAudioContext() {
        if (STATE.contextFailed) return Promise.reject(new Error('audio context unavailable'));
        if (!STATE.contextReady) STATE.contextReady = buildAudioContext();
        return STATE.contextReady;
    }

    async function buildAudioContext() {
        const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

        try {
            // Both worklets or neither. A half-built chain — drive with no
            // limiter behind it, say — is worse than not processing at all.
            await ctx.audioWorklet.addModule(browser.runtime.getURL(OTT_WORKLET_PATH));
            await ctx.audioWorklet.addModule(browser.runtime.getURL(LIMITER_WORKLET_PATH));
        } catch (error) {
            STATE.contextFailed = true;
            try { await ctx.close(); } catch (_) {}
            console.warn('ThunderFox: audio worklets unavailable, leaving this page alone', error);
            throw error;
        }

        STATE.audioContext = ctx;

        STATE.inputGain = ctx.createGain();
        STATE.preGain = ctx.createGain();

        STATE.ott = createOtt(ctx);
        STATE.hpFilter = createHighpass(ctx);
        STATE.eq = createEqualizer(ctx);
        STATE.limiter = createLimiter(ctx);

        STATE.analyser = ctx.createAnalyser();
        STATE.analyser.fftSize = 2048;

        STATE.inputGain.connect(STATE.preGain);
        STATE.inputGain.connect(STATE.analyser);
        STATE.preGain.connect(STATE.ott.node);
        STATE.limiter.output.connect(ctx.destination);

        updateRouting();
        applySettingsToGraph(STATE.settings, true);

        ctx.onstatechange = () => {
            if (ctx.state === 'running') removeGestureListeners();
        };
        installGestureListeners();
        resumeContext();

        return ctx;
    }

    function createOtt(ctx) {
        const node = new AudioWorkletNode(ctx, OTT_WORKLET_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers'
        });

        node.port.onmessage = (event) => {
            if (event.data && event.data.type === 'meters') {
                broadcastMeters({ ott: event.data.reduction, peakDb: event.data.peakDb });
            }
        };

        return { node, parameters: node.parameters };
    }

    function createHighpass(ctx) {
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = S.HIGHPASS_HZ;
        filter.Q.value = S.HIGHPASS_Q;
        return filter;
    }

    function createEqualizer(ctx) {
        const input = ctx.createGain();
        const filters = [];

        let current = input;
        S.EQ_BANDS.forEach((band) => {
            const filter = ctx.createBiquadFilter();
            filter.type = band.type;
            filter.frequency.value = band.frequency;
            filter.Q.value = S.EQ_Q;
            filter.gain.value = 0;
            current.connect(filter);
            current = filter;
            filters.push(filter);
        });

        return {
            input,
            output: current,
            filters,
            setGains: (gainsDb) => {
                gainsDb.forEach((gainDb, index) => {
                    if (filters[index]) rampParam(filters[index].gain, gainDb);
                });
            }
        };
    }

    function createLimiter(ctx) {
        const input = ctx.createGain();

        // Drive sits ahead of the limiter, so raising Loudness pushes signal
        // into a fixed ceiling rather than adding gain after the only stage
        // protecting the output. This is the LoudMax threshold control: lowering
        // the threshold and making up the difference is the same operation.
        const drive = ctx.createGain();

        const node = new AudioWorkletNode(ctx, LIMITER_WORKLET_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 1
        });

        node.port.onmessage = (event) => {
            if (event.data && event.data.type === 'meters') {
                broadcastMeters({ limiterDb: event.data.reductionDb, outputDb: event.data.peakDb });
            }
        };

        input.connect(drive);
        drive.connect(node);

        return { input, output: node, drive, node, parameters: node.parameters };
    }

    // The optional stages sit between the OTT worklet and the limiter's drive.
    function updateRouting() {
        if (!STATE.audioContext || !STATE.ott || !STATE.limiter || !STATE.eq) return;

        [STATE.ott.node, STATE.hpFilter, STATE.eq.output].forEach((node) => {
            try { node.disconnect(); } catch (_) {}
        });

        let current = STATE.ott.node;
        if (STATE.settings.hpEnabled) {
            current.connect(STATE.hpFilter);
            current = STATE.hpFilter;
        }
        if (STATE.settings.eqEnabled) {
            current.connect(STATE.eq.input);
            current = STATE.eq.output;
        }
        current.connect(STATE.limiter.input);
    }

    /* ------------------------------------------------------------- autoplay */

    const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'play'];

    function onGesture() {
        resumeContext();
    }

    function installGestureListeners() {
        GESTURE_EVENTS.forEach((type) => {
            document.addEventListener(type, onGesture, { capture: true, passive: true });
        });
    }

    function removeGestureListeners() {
        GESTURE_EVENTS.forEach((type) => {
            document.removeEventListener(type, onGesture, { capture: true });
        });
    }

    // Autoplay policy starts the context suspended. Because
    // createMediaElementSource reroutes the element's audio into that context, a
    // suspended context is not "processing paused", it is total silence — and
    // bypass runs through the same context, so switching off does not restore it.
    function resumeContext() {
        const ctx = STATE.audioContext;
        if (!ctx || ctx.state !== 'suspended') return;
        ctx.resume().catch(() => {});
    }

    /* ------------------------------------------------------- media elements */

    /**
     * Whether taking this element's audio would silence it.
     *
     * createMediaElementSource on cross-origin media served without CORS headers
     * produces a node that outputs silence, per spec, and there is no way to give
     * the element back afterwards. So this has to be decided before we touch it,
     * not detected after.
     */
    function wireBlockReason(mediaEl) {
        if (STATE.protectedElements.has(mediaEl) || mediaEl.mediaKeys != null) return 'drm';

        const source = mediaEl.currentSrc || mediaEl.src || '';
        if (!source) return 'no-source';

        let url;
        try {
            url = new URL(source, document.baseURI);
        } catch (_) {
            return 'bad-source';
        }

        // MSE and in-page buffers are same-origin by construction. This is the
        // path YouTube, Twitch and essentially every adaptive player takes.
        if (url.protocol === 'blob:' || url.protocol === 'data:' || url.protocol === 'mediasource:') {
            return null;
        }

        if (url.origin === window.location.origin) return null;
        if (mediaEl.crossOrigin === 'anonymous' || mediaEl.crossOrigin === 'use-credentials') return null;

        return 'cross-origin';
    }

    function trackElement(mediaEl) {
        if (STATE.mediaNodes.has(mediaEl) || STATE.wiring.has(mediaEl)) {
            reconnectElement(mediaEl);
            return;
        }

        if (!STATE.watched.has(mediaEl)) {
            STATE.watched.add(mediaEl);
            // EME sites call setMediaKeys() well after document_idle, so the
            // only reliable signal is the event. Registering at discovery time
            // means it has fired before the first `playing`.
            mediaEl.addEventListener('encrypted', () => {
                STATE.protectedElements.add(mediaEl);
            }, { capture: true });
            mediaEl.addEventListener('playing', () => {
                wireMediaElement(mediaEl);
            }, { capture: true });
        }

        if (!mediaEl.paused && mediaEl.readyState >= 2) wireMediaElement(mediaEl);
    }

    async function wireMediaElement(mediaEl) {
        if (STATE.mediaNodes.has(mediaEl)) {
            reconnectElement(mediaEl);
            return;
        }
        if (STATE.wiring.has(mediaEl) || STATE.contextFailed) return;

        const reason = wireBlockReason(mediaEl);
        if (reason) {
            // 'no-source' is transient — the next `playing` retries — but the
            // others are permanent for this element.
            if (reason !== 'no-source' && !STATE.skipped.has(mediaEl)) {
                STATE.skipped.add(mediaEl);
                console.info(`ThunderFox: leaving this media alone (${reason})`, mediaEl.currentSrc || '');
            }
            return;
        }

        STATE.wiring.add(mediaEl);
        try {
            await ensureAudioContext();
        } catch (_) {
            STATE.wiring.delete(mediaEl);
            return;
        }

        try {
            if (STATE.mediaNodes.has(mediaEl)) return;

            const ctx = STATE.audioContext;
            let source;
            try {
                source = ctx.createMediaElementSource(mediaEl);
            } catch (error) {
                // Only reachable if something else already claimed the element.
                STATE.skipped.add(mediaEl);
                console.warn('ThunderFox: could not take this element\'s audio', error);
                return;
            }

            STATE.mediaNodes.set(mediaEl, { source });
            reconnectElement(mediaEl);
            resumeContext();
            startWatchdog();
        } finally {
            STATE.wiring.delete(mediaEl);
        }
    }

    // Bypass routes the source straight to the destination. It still runs
    // through the AudioContext — there is no way back to native playback once
    // createMediaElementSource has run — so the context must be resumed either
    // way for "off" to mean anything.
    function reconnectElement(mediaEl) {
        const nodes = STATE.mediaNodes.get(mediaEl);
        if (!nodes || !STATE.audioContext) return;

        // Rescans call this for every known element, so it has to be a no-op
        // when nothing changed. Disconnecting and reconnecting a live source
        // drops a sample and clicks.
        const target = STATE.settings.enabled ? 'graph' : 'bypass';
        if (nodes.target === target) return;

        try { nodes.source.disconnect(); } catch (_) {}

        if (target === 'graph') {
            nodes.source.connect(STATE.inputGain);
        } else {
            nodes.source.connect(STATE.audioContext.destination);
        }
        nodes.target = target;
    }

    function reconnectAll() {
        STATE.mediaNodes.forEach((_, mediaEl) => reconnectElement(mediaEl));
    }

    // Disconnect only. The map entry stays: the element is bound to its source
    // node permanently, so if it is re-added we must reuse that node rather than
    // try to build another one.
    function detachElement(mediaEl) {
        const nodes = STATE.mediaNodes.get(mediaEl);
        if (!nodes) return;
        try { nodes.source.disconnect(); } catch (_) {}
        nodes.target = null;
    }

    /* ---------------------------------------------------------- discovery */

    // Walking every element to find shadow roots is the only way to reach media
    // inside a web component, but it is far too expensive to run per mutation on
    // a page like YouTube. The budget caps one pass; anything past it is picked
    // up by the next coalesced scan.
    const SHADOW_WALK_BUDGET = 3000;

    function collectMedia(root, found, budget) {
        if (!root || !root.querySelectorAll) return budget;

        root.querySelectorAll('audio, video').forEach((el) => found.push(el));

        if (budget <= 0) return 0;
        const all = root.querySelectorAll('*');
        let remaining = budget - all.length;
        if (remaining < 0) return 0;

        for (const el of all) {
            if (el.shadowRoot) {
                observeRoot(el.shadowRoot);
                remaining = collectMedia(el.shadowRoot, found, remaining);
                if (remaining <= 0) return 0;
            }
        }

        return remaining;
    }

    function scan(root) {
        const found = [];
        if (root && (root.tagName === 'AUDIO' || root.tagName === 'VIDEO')) found.push(root);
        collectMedia(root, found, SHADOW_WALK_BUDGET);
        found.forEach(trackElement);
    }

    // Additions are coalesced: a single burst of DOM churn should cost one pass,
    // not one per record.
    function flushPendingScans() {
        STATE.scanTimer = null;
        const roots = Array.from(STATE.pendingRoots);
        STATE.pendingRoots.clear();
        roots.forEach((root) => {
            if (root.isConnected === false && !root.shadowRoot) return;
            scan(root);
        });
    }

    function handleMutations(records) {
        // Removals first: a remove-then-append in the same task produces two
        // records, and processing the addition first would leave the element
        // detached from the graph it was just reconnected to.
        for (const record of records) {
            record.removedNodes.forEach((node) => {
                if (!node || node.nodeType !== 1) return;
                if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') detachElement(node);
                else if (node.querySelectorAll) node.querySelectorAll('audio, video').forEach(detachElement);
            });
        }

        for (const record of records) {
            record.addedNodes.forEach((node) => {
                if (!node || node.nodeType !== 1) return;
                STATE.pendingRoots.add(node);
            });
        }

        if (STATE.pendingRoots.size > 0 && !STATE.scanTimer) {
            STATE.scanTimer = setTimeout(flushPendingScans, 200);
        }
    }

    function observeRoot(root) {
        if (!root || STATE.observedRoots.has(root)) return;
        STATE.observedRoots.add(root);
        STATE.observer.observe(root, { childList: true, subtree: true });
    }

    /* ---------------------------------------------------------- watchdog */

    // If the page is playing but the summed input is digital silence, something
    // upstream of us has been zeroed — almost always CORS tainting we failed to
    // predict. There is no in-page recovery, so the honest move is to say so and
    // point at the exemption, which does work (it reloads the tab).
    function startWatchdog() {
        if (STATE.watchdogTimer || STATE.silenceReported) return;
        const buffer = new Float32Array(STATE.analyser.fftSize);

        STATE.watchdogTimer = setInterval(() => {
            let playing = false;
            STATE.mediaNodes.forEach((_, el) => {
                if (!el.paused && !el.ended && !el.muted && el.volume > 0 && el.readyState >= 2) playing = true;
            });

            if (!playing) {
                STATE.silenceSince = 0;
                return;
            }

            STATE.analyser.getFloatTimeDomainData(buffer);
            let peak = 0;
            for (let i = 0; i < buffer.length; i++) {
                const magnitude = Math.abs(buffer[i]);
                if (magnitude > peak) peak = magnitude;
            }

            if (peak > 1e-7) {
                // Audio reaches the graph, so the path is not tainted. Nothing
                // later can change that for these elements, and polling forever
                // is not free.
                STATE.silenceSince = 0;
                clearInterval(STATE.watchdogTimer);
                STATE.watchdogTimer = null;
                STATE.silenceReported = true;
                return;
            }

            const now = Date.now();
            if (!STATE.silenceSince) {
                STATE.silenceSince = now;
                return;
            }

            if (now - STATE.silenceSince < SILENCE_TIMEOUT_MS) return;

            STATE.silenceReported = true;
            clearInterval(STATE.watchdogTimer);
            STATE.watchdogTimer = null;

            console.warn(
                'ThunderFox: this page is playing but its audio reads as silent. '
                + 'The media is most likely cross-origin without CORS headers. '
                + 'Exempt this site in the popup and reload to restore it.'
            );
            browser.storage.local.set({ audioBlockedHost: window.location.hostname }).catch(() => {});
        }, WATCHDOG_INTERVAL_MS);
    }

    /* ------------------------------------------------------------ settings */

    // While Advanced is off the tunables revert to defaults, but the user's own
    // values stay in storage and come back when it is switched on again.
    function effectiveAdvanced(settings) {
        if (settings.advancedEnabled) return settings;
        const base = Object.assign({}, settings);
        S.ADVANCED_KEYS.forEach((key) => { base[key] = S.DEFAULTS[key]; });
        base.limiterIsp = S.DEFAULTS.limiterIsp;
        return base;
    }

    /**
     * Apply settings to the graph, touching only what actually changed.
     *
     * The popup writes storage and messages the tab, and the content script
     * listens to both, so every change arrives twice. Comparing against the last
     * applied value makes the duplicate a no-op instead of a second
     * cancelScheduledValues that cuts the first ramp short.
     */
    function applySettingsToGraph(settings, force) {
        if (!STATE.audioContext) return;

        const applied = STATE.applied;
        const advanced = effectiveAdvanced(settings);
        const loudness = S.loudnessProfile(S.loudnessAmount(settings.limiterThreshold));

        // Advanced owns Depth when it is switched on; otherwise the Loudness
        // macro drives it. Drive always comes from Loudness.
        const depth = settings.advancedEnabled ? advanced.ottDepth : loudness.depth;

        const targets = {
            preGain: dbToGain(advanced.preBoostDb),
            drive: dbToGain(loudness.driveDb),
            depth,
            time: advanced.ottTime,
            lowUp: advanced.ottLowUp,
            lowDown: advanced.ottLowDown,
            lowGainDb: advanced.ottLowGainDb,
            midUp: advanced.ottMidUp,
            midDown: advanced.ottMidDown,
            midGainDb: advanced.ottMidGainDb,
            highUp: advanced.ottHighUp,
            highDown: advanced.ottHighDown,
            highGainDb: advanced.ottHighGainDb,
            ceiling: dbToGain(advanced.limiterCeilingDb),
            smoothing: msToSeconds(advanced.limiterAttackMs),
            release: msToSeconds(advanced.limiterReleaseMs),
            hold: msToSeconds(advanced.limiterHoldMs),
            isp: advanced.limiterIsp ? 1 : 0
        };

        const changed = (key) => force || applied[key] !== targets[key];

        if (changed('preGain')) rampParam(STATE.preGain.gain, targets.preGain);
        if (changed('drive')) rampParam(STATE.limiter.drive.gain, targets.drive);

        const ott = STATE.ott.parameters;
        ['depth', 'time', 'lowUp', 'lowDown', 'lowGainDb', 'midUp', 'midDown', 'midGainDb',
            'highUp', 'highDown', 'highGainDb'].forEach((key) => {
            if (changed(key)) rampParam(ott.get(key), targets[key]);
        });

        const limiter = STATE.limiter.parameters;
        if (changed('ceiling')) rampParam(limiter.get('ceiling'), targets.ceiling);
        if (changed('release')) rampParam(limiter.get('release'), targets.release);
        if (changed('hold')) rampParam(limiter.get('hold'), targets.hold);
        // Structural: these become buffer lengths inside the worklet.
        if (changed('smoothing')) setParam(limiter.get('smoothing'), targets.smoothing);
        if (changed('isp')) setParam(limiter.get('isp'), targets.isp);

        Object.assign(applied, targets);

        const gains = settings.eqGains;
        if (force || !applied.eqGains || gains.some((g, i) => applied.eqGains[i] !== g)) {
            STATE.eq.setGains(gains);
            applied.eqGains = gains.slice();
        }
    }

    // Merge a patch of raw values into STATE.settings and push the result at the
    // graph. Everything — messages, storage events, the initial read — funnels
    // through here, so there is one sanitising path rather than three.
    function updateSettings(patch) {
        const next = Object.assign({}, STATE.settings);
        let routingChanged = false;
        let enabledChanged = false;

        if (typeof patch.enabled === 'boolean' && patch.enabled !== next.enabled) {
            next.enabled = patch.enabled;
            enabledChanged = true;
        }
        if (typeof patch.hpEnabled === 'boolean' && patch.hpEnabled !== next.hpEnabled) {
            next.hpEnabled = patch.hpEnabled;
            routingChanged = true;
        }
        if (typeof patch.eqEnabled === 'boolean' && patch.eqEnabled !== next.eqEnabled) {
            next.eqEnabled = patch.eqEnabled;
            routingChanged = true;
        }
        if (typeof patch.limiterThreshold === 'number' && isFinite(patch.limiterThreshold)) {
            next.limiterThreshold = patch.limiterThreshold;
        }
        if (patch.eqGains !== undefined) {
            next.eqGains = S.sanitizeEqGains(patch.eqGains);
        }
        if (typeof patch.advancedEnabled === 'boolean') {
            next.advancedEnabled = patch.advancedEnabled;
        }

        const advancedPatch = {};
        let hasAdvanced = false;
        S.ADVANCED_KEYS.concat(['limiterIsp']).forEach((key) => {
            if (patch[key] !== undefined) {
                advancedPatch[key] = patch[key];
                hasAdvanced = true;
            }
        });
        if (hasAdvanced) {
            const merged = Object.assign({}, next, advancedPatch);
            Object.assign(next, S.sanitizeAdvanced(merged));
        }

        STATE.settings = next;

        if (enabledChanged) {
            reconnectAll();
            // Flush the look-ahead so the limiter does not replay stale audio
            // from before the switch.
            if (STATE.limiter) STATE.limiter.node.port.postMessage({ type: 'reset' });
            if (STATE.ott) STATE.ott.node.port.postMessage({ type: 'reset' });
        }
        if (routingChanged) updateRouting();
        applySettingsToGraph(next, false);
    }

    /* ------------------------------------------------------------- metering */

    function broadcastMeters(patch) {
        if (STATE.meterPorts.size === 0) return;
        STATE.meterPorts.forEach((port) => {
            try { port.postMessage(Object.assign({ type: 'meters' }, patch)); } catch (_) {}
        });
    }

    /* ---------------------------------------------------------------- init */

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
        const topHostname = await getTopLevelHostname();
        return ThunderFoxSites.isHostnameExempted(topHostname, exemptedSites);
    }

    function handleMessage(message) {
        if (!message || typeof message.type !== 'string') return;
        if (message.type !== 'THUNDERFOX_SETTINGS') return;
        if (STATE.inert) return;
        updateSettings(message.settings || {});
    }

    function handleStorageChange(changes, area) {
        if (area !== 'local' || STATE.inert) return;

        const patch = {};
        Object.keys(changes).forEach((key) => {
            if (key === 'exemptedSites' || key === 'audioBlockedHost') return;
            patch[key] = changes[key].newValue;
        });
        if (Object.keys(patch).length === 0) return;

        try {
            updateSettings(patch);
        } catch (error) {
            console.error('ThunderFox: error handling storage change', error);
        }
    }

    function handleConnect(port) {
        if (!port || port.name !== 'thunderfox-meters' || STATE.inert) return;
        STATE.meterPorts.add(port);
        port.onDisconnect.addListener(() => STATE.meterPorts.delete(port));
    }

    async function init() {
        // Registered before the first await. Previously both listeners landed
        // after a storage read and a round trip to the background page, so a
        // setting changed in that window was dropped for the tab with no error.
        browser.runtime.onMessage.addListener(handleMessage);
        browser.storage.onChanged.addListener(handleStorageChange);
        browser.runtime.onConnect.addListener(handleConnect);

        STATE.observer = new MutationObserver(handleMutations);

        const stored = await browser.storage.local.get(
            Object.assign({ exemptedSites: null, audioBlockedHost: '' }, S.DEFAULTS)
        );

        const exemptedSites = ThunderFoxSites.getStoredExemptedSites(
            stored.exemptedSites === null ? undefined : stored.exemptedSites
        );

        // Bail out before creating an AudioContext or touching any element. Once
        // createMediaElementSource() has run there is no way back, so an exempted
        // page has to stay completely untouched; the popup reloads the tab when
        // the exemption list changes.
        if (await isPageExempted(exemptedSites)) {
            STATE.inert = true;
            console.info('ThunderFox: site is exempted, staying inert', {
                hostname: window.location.hostname
            });
            return;
        }

        STATE.settings = Object.assign({}, S.DEFAULTS, S.sanitizeAdvanced(stored), {
            enabled: !!stored.enabled,
            hpEnabled: !!stored.hpEnabled,
            eqEnabled: stored.eqEnabled === undefined ? true : !!stored.eqEnabled,
            advancedEnabled: !!stored.advancedEnabled,
            limiterThreshold: typeof stored.limiterThreshold === 'number'
                ? stored.limiterThreshold
                : S.DEFAULTS.limiterThreshold,
            eqGains: S.sanitizeEqGains(stored.eqGains)
        });

        // Clear any stale "audio blocked" flag for this host. If the page is
        // still broken the watchdog re-raises it within a couple of seconds, so
        // the notice reflects this load rather than a previous one.
        if (stored.audioBlockedHost === window.location.hostname) {
            browser.storage.local.set({ audioBlockedHost: '' }).catch(() => {});
        }

        // document is observed rather than documentElement, which document.write
        // can replace and orphan.
        observeRoot(document);
        scan(document);
    }

    // Fire up the bass cannon
    init().catch((error) => {
        console.error('ThunderFox: failed to start', error);
    });
})();
