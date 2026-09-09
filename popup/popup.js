const S = ThunderFoxSettings;

const toggle = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const hpToggle = document.getElementById('hpToggle');
const loudnessSlider = document.getElementById('loudness');
const loudnessValue = document.getElementById('loudness-value');
const eqBands = document.getElementById('eqBands');
const eqResetBtn = document.getElementById('eqReset');
const eqSection = document.querySelector('.eq-section');
const eqToggle = document.getElementById('eqToggle');
const advancedSection = document.getElementById('advancedSection');
const advancedBody = document.getElementById('advancedBody');
const advancedToggle = document.getElementById('advancedToggle');
const advancedResetBtn = document.getElementById('advancedReset');
const blockedNotice = document.getElementById('blockedNotice');
const manageExemptionsBtn = document.getElementById('manageExemptions');

const exemptSection = document.querySelector('.exempt-section');
const exemptToggle = document.getElementById('exemptToggle');
const exemptLabel = document.getElementById('exemptLabel');
const exemptHint = document.getElementById('exemptHint');

// Which advanced controls appear, in which order, under which heading. Ranges
// and defaults come from ThunderFoxSettings so there is one definition of each.
const ADVANCED_LAYOUT = [
    {
        group: 'Global', rows: [
            { key: 'preBoostDb', label: 'Pre-boost' },
            { key: 'ottDepth', label: 'Depth' },
            { key: 'ottTime', label: 'Time' }
        ]
    },
    {
        group: 'Low band', rows: [
            { key: 'ottLowUp', label: 'Up' },
            { key: 'ottLowDown', label: 'Down' },
            { key: 'ottLowGainDb', label: 'Gain' }
        ]
    },
    {
        group: 'Mid band', rows: [
            { key: 'ottMidUp', label: 'Up' },
            { key: 'ottMidDown', label: 'Down' },
            { key: 'ottMidGainDb', label: 'Gain' }
        ]
    },
    {
        group: 'High band', rows: [
            { key: 'ottHighUp', label: 'Up' },
            { key: 'ottHighDown', label: 'Down' },
            { key: 'ottHighGainDb', label: 'Gain' }
        ]
    },
    {
        group: 'Limiter', rows: [
            { key: 'limiterAttackMs', label: 'Attack' },
            { key: 'limiterReleaseMs', label: 'Release' },
            { key: 'limiterHoldMs', label: 'Hold' },
            { key: 'limiterCeilingDb', label: 'Ceiling' }
        ]
    }
];

// Deepest reduction a gain-reduction meter shows, full scale.
const METER_RANGE_DB = 24;
const OUTPUT_FLOOR_DB = -60;

const STORAGE_DEBOUNCE_MS = 120;

// The popup's own copy of the settings. Reading storage back inside every input
// handler is what let two fast slider events interleave as get, get, set, set
// and lose one of the writes.
let settings = Object.assign({}, S.DEFAULTS);

let currentTab = null;
let currentHostname = '';
let exemptedSites = [];
let meterPort = null;

const eqSliders = [];
const eqValues = [];
const advancedControls = {};

let pendingWrites = {};
let writeTimer = null;

/* ------------------------------------------------------------- persistence */

// Messaging is immediate so the audio responds while the slider moves; the
// storage write is debounced because each one broadcasts storage.onChanged to
// every frame of every tab.
function commit(patch) {
    Object.assign(settings, patch);
    Object.assign(pendingWrites, patch);

    sendToActiveTab({ type: 'THUNDERFOX_SETTINGS', settings: patch });

    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
        writeTimer = null;
        const values = pendingWrites;
        pendingWrites = {};
        browser.storage.local.set(values).catch((error) => {
            console.error('ThunderFox: failed to save settings', error);
        });
    }, STORAGE_DEBOUNCE_MS);
}

function flushWrites() {
    if (!writeTimer) return;
    clearTimeout(writeTimer);
    writeTimer = null;
    const values = pendingWrites;
    pendingWrites = {};
    browser.storage.local.set(values).catch(() => {});
}

// The popup can be dismissed mid-drag, before the debounce fires.
window.addEventListener('pagehide', flushWrites);
window.addEventListener('blur', flushWrites);

async function sendToActiveTab(message) {
    if (!currentTab) return;
    try {
        await browser.tabs.sendMessage(currentTab.id, message);
    } catch (_) {
        // The content script may not be present (exempted site, privileged page,
        // or a tab loaded before install). storage.onChanged covers those cases.
    }
}

/* ----------------------------------------------------------- slider mapping */

// Attack ranges span three orders of magnitude, so a linear slider would bunch
// everything useful into the first few pixels. Decibels and percentages are
// already perceptually even, so those map linearly.
function sliderToValue(position, range) {
    const t = Number(position) / 100;
    if (range.unit === 'ms' && range.min > 0) {
        return range.min * Math.pow(range.max / range.min, t);
    }
    return range.min + t * (range.max - range.min);
}

function valueToSlider(value, range) {
    const clamped = S.clamp(value, range.min, range.max);
    if (range.unit === 'ms' && range.min > 0) {
        return Math.round(100 * Math.log(clamped / range.min) / Math.log(range.max / range.min));
    }
    return Math.round(100 * (clamped - range.min) / (range.max - range.min));
}

function formatValue(value, range) {
    if (range.unit === 'percent') return `${Math.round(value * 100)}%`;
    if (range.unit === 'db') {
        const sign = value > 0 ? '+' : '';
        return `${sign}${value.toFixed(1)} dB`;
    }
    if (value < 1) return `${value.toFixed(2)} ms`;
    if (value < 10) return `${value.toFixed(1)} ms`;
    return `${Math.round(value)} ms`;
}

/* --------------------------------------------------------------- rendering */

function setStatus(enabled) {
    statusEl.textContent = enabled ? 'Enabled' : 'Disabled';
}

function renderLoudness() {
    const amount = S.loudnessAmount(settings.limiterThreshold);
    loudnessSlider.value = String(Math.round(amount * 100));
    loudnessValue.textContent = `${Math.round(amount * 100)}%`;
}

function buildEq() {
    S.EQ_BANDS.forEach((band, index) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'eq-band';

        const value = document.createElement('span');
        value.className = 'eq-value';
        value.id = `eq${index}-value`;

        const container = document.createElement('div');
        container.className = 'eq-slider-container';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'eq-slider';
        slider.id = `eq${index}`;
        slider.min = String(-S.EQ_GAIN_LIMIT);
        slider.max = String(S.EQ_GAIN_LIMIT);
        slider.step = '0.5';
        slider.value = '0';
        slider.setAttribute('aria-label', `${band.label} equalizer band`);
        slider.setAttribute('aria-orientation', 'vertical');

        const label = document.createElement('span');
        label.className = 'eq-label';
        label.textContent = band.label;

        container.appendChild(slider);
        wrapper.append(value, container, label);
        eqBands.appendChild(wrapper);

        eqSliders.push(slider);
        eqValues.push(value);

        slider.addEventListener('input', () => {
            const gains = settings.eqGains.slice();
            gains[index] = Number(slider.value);
            renderEqValue(index, gains[index]);
            commit({ eqGains: gains });
            requestAnimationFrame(drawEQCurve);
        });
    });

    eqBands.appendChild(canvas);
}

function renderEqValue(index, gainDb) {
    eqValues[index].textContent = gainDb >= 0 ? `+${gainDb.toFixed(1)}` : gainDb.toFixed(1);
    eqSliders[index].setAttribute('aria-valuetext', `${gainDb.toFixed(1)} decibels`);
}

function renderEq() {
    settings.eqGains.forEach((gain, index) => {
        if (!eqSliders[index]) return;
        eqSliders[index].value = String(gain);
        renderEqValue(index, gain);
    });
    requestAnimationFrame(drawEQCurve);
}

function buildAdvanced() {
    ADVANCED_LAYOUT.forEach((section) => {
        const heading = document.createElement('div');
        heading.className = 'adv-group';
        heading.textContent = section.group;
        advancedBody.appendChild(heading);

        section.rows.forEach((row) => {
            const range = S.LIMITS[row.key];

            const wrapper = document.createElement('div');
            wrapper.className = 'row adv-row';

            const label = document.createElement('label');
            label.textContent = row.label;
            label.htmlFor = `adv-${row.key}`;

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.id = `adv-${row.key}`;
            slider.min = '0';
            slider.max = '100';
            slider.step = '1';

            const readout = document.createElement('span');
            readout.className = 'adv-value';
            readout.id = `adv-${row.key}-value`;
            slider.setAttribute('aria-describedby', readout.id);

            wrapper.append(label, slider, readout);
            advancedBody.appendChild(wrapper);

            advancedControls[row.key] = { slider, readout, range };

            slider.addEventListener('input', () => {
                const value = sliderToValue(slider.value, range);
                renderAdvancedRow(row.key, value);
                commit({ [row.key]: value });
            });
        });
    });

    // ISP is a switch rather than a slider, so it sits outside the layout table.
    const ispRow = document.createElement('div');
    ispRow.className = 'row adv-row';
    const ispLabel = document.createElement('label');
    ispLabel.textContent = 'True peak';
    ispLabel.htmlFor = 'adv-limiterIsp';
    const ispInput = document.createElement('input');
    ispInput.type = 'checkbox';
    ispInput.id = 'adv-limiterIsp';
    ispRow.append(ispLabel, ispInput);
    advancedBody.appendChild(ispRow);

    advancedControls.limiterIsp = { input: ispInput };
    ispInput.addEventListener('change', () => {
        commit({ limiterIsp: ispInput.checked });
    });
}

function renderAdvancedRow(key, value) {
    const control = advancedControls[key];
    if (!control || !control.slider) return;
    control.readout.textContent = formatValue(value, control.range);
    control.slider.setAttribute('aria-valuetext', control.readout.textContent);
}

function renderAdvanced() {
    Object.keys(advancedControls).forEach((key) => {
        const control = advancedControls[key];
        if (control.input) {
            control.input.checked = !!settings[key];
            return;
        }
        control.slider.value = String(valueToSlider(settings[key], control.range));
        renderAdvancedRow(key, settings[key]);
    });
}

function renderMeter(element, reductionDb) {
    if (!element) return;
    const magnitude = Math.min(Math.abs(reductionDb || 0), METER_RANGE_DB);
    element.style.width = `${(magnitude / METER_RANGE_DB) * 100}%`;
}

function renderOutputMeter(peakDb) {
    const element = document.getElementById('meterOutput');
    if (!element) return;
    const clamped = Math.max(OUTPUT_FLOOR_DB, Math.min(0, peakDb || OUTPUT_FLOOR_DB));
    element.style.width = `${((clamped - OUTPUT_FLOOR_DB) / -OUTPUT_FLOOR_DB) * 100}%`;
}

/* ------------------------------------------------------------------ meters */

function connectMeters() {
    if (!currentTab) return;
    try {
        meterPort = browser.tabs.connect(currentTab.id, { name: 'thunderfox-meters' });
    } catch (_) {
        return;
    }

    meterPort.onMessage.addListener((message) => {
        if (!message || message.type !== 'meters') return;
        if (Array.isArray(message.ott)) {
            renderMeter(document.getElementById('meterLow'), message.ott[0]);
            renderMeter(document.getElementById('meterMid'), message.ott[1]);
            renderMeter(document.getElementById('meterHigh'), message.ott[2]);
        }
        if (typeof message.limiterDb === 'number') {
            renderMeter(document.getElementById('meterLimiter'), message.limiterDb);
        }
        if (typeof message.outputDb === 'number') {
            renderOutputMeter(message.outputDb);
        }
    });

    meterPort.onDisconnect.addListener(() => { meterPort = null; });
}

/* ------------------------------------------------------------- exemptions */

function setExemptUnavailable(reason) {
    exemptToggle.disabled = true;
    exemptToggle.checked = false;
    exemptSection.classList.add('unavailable');
    exemptLabel.textContent = 'Exempt this site';
    exemptHint.textContent = reason;
    exemptHint.hidden = false;
}

function renderExemptState() {
    const rules = ThunderFoxSites.matchingRules(currentHostname, exemptedSites);
    exemptToggle.checked = rules.length > 0;
    exemptLabel.textContent = 'Exempt this site';

    if (rules.length > 0 && !rules.includes(currentHostname)) {
        // Turning this off has to remove the parent rule, which affects more
        // than the current host, so say so before the user clicks.
        exemptHint.textContent = `${currentHostname} is covered by the rule "${rules[0]}".`;
    } else if (rules.length > 0) {
        exemptHint.textContent = `${currentHostname} and its subdomains are ignored.`;
    } else {
        exemptHint.textContent = `Ignore ${currentHostname} and its subdomains.`;
    }
    exemptHint.hidden = false;
}

async function applyExemptChange() {
    const wantExempt = exemptToggle.checked;
    const rules = ThunderFoxSites.matchingRules(currentHostname, exemptedSites);

    if (wantExempt) {
        if (rules.length === 0) {
            exemptedSites = ThunderFoxSites.sanitizeExemptedSites([...exemptedSites, currentHostname]);
        }
    } else {
        // Remove every rule responsible for the match, not just an exact
        // hostname entry, or the site would stay exempted via a parent domain.
        exemptedSites = exemptedSites.filter((site) => !rules.includes(site));
    }

    await browser.storage.local.set({ exemptedSites, audioBlockedHost: '' });

    // Once createMediaElementSource() has run on an element there is no way to
    // hand it back to the browser, so a reload is the only honest bypass.
    exemptHint.textContent = wantExempt
        ? 'Exempted. Reloading the tab to release its audio.'
        : 'Exemption removed. Reloading the tab.';
    exemptHint.hidden = false;

    try {
        await browser.tabs.reload(currentTab.id);
    } catch (_) {
        exemptHint.textContent = 'Saved. Reload the tab to apply.';
    }
}

async function initExemptState() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    currentTab = tabs[0] || null;

    if (!currentTab || !ThunderFoxSites.isExemptableUrl(currentTab.url)) {
        setExemptUnavailable('This page is not a website ThunderFox can process.');
        return;
    }

    currentHostname = ThunderFoxSites.normalizeHostname(currentTab.url);
    if (!currentHostname) {
        setExemptUnavailable('This page has no host to exempt.');
        return;
    }

    const stored = await browser.storage.local.get({ exemptedSites: null });
    exemptedSites = ThunderFoxSites.getStoredExemptedSites(
        stored.exemptedSites === null ? undefined : stored.exemptedSites
    );
    renderExemptState();
}

/* ------------------------------------------------------------------- wiring */

toggle.addEventListener('change', () => {
    setStatus(toggle.checked);
    commit({ enabled: toggle.checked });
});

hpToggle.addEventListener('change', () => {
    commit({ hpEnabled: hpToggle.checked });
});

eqToggle.addEventListener('change', () => {
    setEQVisibility(eqToggle.checked);
    commit({ eqEnabled: eqToggle.checked });
});

loudnessSlider.addEventListener('input', () => {
    const amount = Number(loudnessSlider.value) / 100;
    loudnessValue.textContent = `${Math.round(amount * 100)}%`;
    commit({ limiterThreshold: -(amount * S.MAX_LOUDNESS_DB) });
});

advancedToggle.addEventListener('change', () => {
    setAdvancedVisibility(advancedToggle.checked);
    commit({ advancedEnabled: advancedToggle.checked });
});

advancedResetBtn.addEventListener('click', () => {
    const patch = {};
    S.ADVANCED_KEYS.forEach((key) => { patch[key] = S.DEFAULTS[key]; });
    patch.limiterIsp = S.DEFAULTS.limiterIsp;
    Object.assign(settings, patch);
    renderAdvanced();
    commit(patch);
});

eqResetBtn.addEventListener('click', () => {
    const gains = S.DEFAULTS.eqGains.slice();
    settings.eqGains = gains;
    renderEq();
    commit({ eqGains: gains });
});

exemptToggle.addEventListener('change', () => {
    applyExemptChange().catch((error) => {
        console.error('ThunderFox: failed to update exemption', error);
        exemptHint.textContent = 'Could not update the exemption list.';
        exemptHint.hidden = false;
    });
});

manageExemptionsBtn.addEventListener('click', async () => {
    flushWrites();
    await browser.runtime.openOptionsPage();
    window.close();
});

function setEQVisibility(visible) {
    eqSection.classList.toggle('disabled', !visible);
    if (visible) requestAnimationFrame(drawEQCurve);
}

function setAdvancedVisibility(visible) {
    advancedSection.classList.toggle('disabled', !visible);
}

/* --------------------------------------------------------------- EQ curve */

const canvas = document.createElement('canvas');
canvas.className = 'eq-curve-canvas';

function drawEQCurve() {
    if (!canvas || !eqBands || eqSection.classList.contains('disabled')) return;

    const rect = eqBands.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // The thumb's own size is not observable from the rotated slider's
    // bounding rect, so the CSS publishes it as --eq-thumb.
    const thumbSize = eqSliders[0]
        ? parseFloat(getComputedStyle(eqSliders[0]).getPropertyValue('--eq-thumb')) || 0
        : 0;

    const points = eqSliders.map((slider) => {
        const sRect = slider.getBoundingClientRect();
        const x = sRect.left + sRect.width / 2 - rect.left;
        const centerY = sRect.top + sRect.height / 2 - rect.top;
        const val = parseFloat(slider.value);
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);

        // Visual travel distance of the thumb, measured rather than hardcoded
        // so the curve follows whatever dimensions the CSS specifies.
        const trackLength = Math.max(sRect.height - thumbSize, 1);
        const norm = (val - (min + max) / 2) / ((max - min) / 2);
        // Invert Y because screen Y grows downwards, but we want max at top.
        return { x, y: centerY - (norm * (trackLength / 2)) };
    });

    if (points.length < 2) return;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];
        ctx.bezierCurveTo(
            p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6,
            p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6,
            p2.x, p2.y
        );
    }
    ctx.stroke();
}

window.addEventListener('resize', drawEQCurve);

/* ------------------------------------------------------------------- init */

function renderBlockedNotice(blockedHost) {
    const blocked = !!blockedHost && blockedHost === currentHostname;
    blockedNotice.hidden = !blocked;
    if (blocked) {
        blockedNotice.textContent =
            'This site\'s audio reads as silent while ThunderFox is processing it, '
            + 'usually because the media is served cross-origin without CORS headers. '
            + 'Exempt the site below and reload to restore it.';
    }
}

async function init() {
    buildEq();
    buildAdvanced();

    // Resolve the tab first so every later message has somewhere to go. A
    // failure here must not take the rest of the popup down with it.
    try {
        await initExemptState();
    } catch (error) {
        console.error('ThunderFox: failed to resolve the active tab', error);
        setExemptUnavailable('Could not read the current tab.');
    }

    const stored = await browser.storage.local.get(
        Object.assign({ audioBlockedHost: '' }, S.DEFAULTS)
    );

    settings = Object.assign({}, S.DEFAULTS, S.sanitizeAdvanced(stored), {
        enabled: !!stored.enabled,
        hpEnabled: !!stored.hpEnabled,
        eqEnabled: stored.eqEnabled === undefined ? true : !!stored.eqEnabled,
        advancedEnabled: !!stored.advancedEnabled,
        limiterThreshold: typeof stored.limiterThreshold === 'number'
            ? stored.limiterThreshold
            : S.DEFAULTS.limiterThreshold,
        eqGains: S.sanitizeEqGains(stored.eqGains)
    });

    toggle.checked = settings.enabled;
    setStatus(settings.enabled);
    hpToggle.checked = settings.hpEnabled;
    eqToggle.checked = settings.eqEnabled;
    setEQVisibility(settings.eqEnabled);
    advancedToggle.checked = settings.advancedEnabled;
    setAdvancedVisibility(settings.advancedEnabled);

    renderLoudness();
    renderEq();
    renderAdvanced();
    renderBlockedNotice(stored.audioBlockedHost);

    // The watchdog needs two seconds of playback to decide, which is often
    // longer than it takes the user to open the popup.
    browser.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.audioBlockedHost) return;
        renderBlockedNotice(changes.audioBlockedHost.newValue);
    });

    connectMeters();
}

init().catch((error) => {
    console.error('ThunderFox: popup failed to initialize', error);
});
