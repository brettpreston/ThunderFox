const toggle = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const hpToggle = document.getElementById('hpToggle');
const limiterThreshold = document.getElementById('limiterThreshold');
const loudnessValue = document.getElementById('loudness-value');
const eqSliders = Array.from({ length: 8 }, (_, i) => document.getElementById(`eq${i}`));
const eqValues = Array.from({ length: 8 }, (_, i) => document.getElementById(`eq${i}-value`));
const eqResetBtn = document.getElementById('eqReset');
const eqSection = document.querySelector('.eq-section');
const eqBands = document.querySelector('.eq-bands');
const manageExemptionsBtn = document.getElementById('manageExemptions');

const advancedSection = document.getElementById('advancedSection');
const advancedToggle = document.getElementById('advancedToggle');
const advancedResetBtn = document.getElementById('advancedReset');

const exemptSection = document.querySelector('.exempt-section');
const exemptToggle = document.getElementById('exemptToggle');
const exemptLabel = document.getElementById('exemptLabel');
const exemptHint = document.getElementById('exemptHint');

// Ranges mirror DYNAMICS_LIMITS/DEFAULT_DYNAMICS in content/content.js.
// unit 'db' uses a linear slider; 'ms' uses a logarithmic one.
const DYNAMICS = {
    preBoostDb: { min: 0, max: 24, default: 6, unit: 'db' },
    compAttackMs: { min: 0.1, max: 100, default: 10, unit: 'ms' },
    compReleaseMs: { min: 20, max: 1000, default: 300, unit: 'ms' },
    limiterAttackMs: { min: 0.2, max: 5, default: 3, unit: 'ms' },
    limiterReleaseMs: { min: 10, max: 500, default: 100, unit: 'ms' }
};

// Matches MAX_DRIVE_DB in content/content.js.
const MAX_LOUDNESS_DB = 30;

const DYNAMICS_CONTROLS = {
    preBoostDb: 'preBoost',
    compAttackMs: 'compAttack',
    compReleaseMs: 'compRelease',
    limiterAttackMs: 'limiterAttack',
    limiterReleaseMs: 'limiterRelease'
};

let currentTab = null;
let currentHostname = '';
let exemptedSites = [];

const canvas = document.createElement('canvas');
canvas.className = 'eq-curve-canvas';
if (eqBands) {
    eqBands.appendChild(canvas);
}

const eqLabels = document.querySelectorAll('.eq-label');
const freqLabels = ['68', '150', '315', '680', '1.5k', '3k', '7k', '15k'];
eqLabels.forEach((el, i) => {
    if (freqLabels[i]) el.textContent = freqLabels[i];
});

async function sendToActiveTab(message) {
    if (!currentTab) return;
    try {
        await browser.tabs.sendMessage(currentTab.id, message);
    } catch (_) {
        // The content script may not be present (exempted site, privileged page,
        // or a tab loaded before install). storage.onChanged covers those cases.
    }
}

function setStatus(enabled) {
    statusEl.textContent = enabled ? 'Enabled' : 'Disabled';
}

function setEQVisibility(visible) {
    if (eqSection) {
        eqSection.classList.toggle('disabled', !visible);
        if (visible) requestAnimationFrame(drawEQCurve);
    }
}

// EQ Toggle
const eqHeader = document.querySelector('.eq-header');

const eqSwitchLabel = document.createElement('label');
eqSwitchLabel.className = 'switch switch-sm';

const eqCheckbox = document.createElement('input');
eqCheckbox.type = 'checkbox';
eqCheckbox.id = 'eqToggle';

const eqSliderSpan = document.createElement('span');
eqSliderSpan.className = 'slider';

eqSwitchLabel.appendChild(eqCheckbox);
eqSwitchLabel.appendChild(eqSliderSpan);

// Append to header so it sits on the right (Title -> Reset -> Toggle)
eqHeader.appendChild(eqSwitchLabel);

const eqToggle = document.getElementById('eqToggle');

/* Advanced attack/release controls */

// Attack ranges span three orders of magnitude, so a linear slider would bunch
// everything useful into the first few pixels. Decibels are already
// logarithmic, so those map linearly.
function sliderToValue(position, range) {
    const t = Number(position) / 100;
    if (range.unit === 'db') return range.min + t * (range.max - range.min);
    return range.min * Math.pow(range.max / range.min, t);
}

function valueToSlider(value, range) {
    const clamped = Math.max(range.min, Math.min(range.max, value));
    if (range.unit === 'db') {
        return Math.round(100 * (clamped - range.min) / (range.max - range.min));
    }
    return Math.round(100 * Math.log(clamped / range.min) / Math.log(range.max / range.min));
}

function formatValue(value, range) {
    if (range.unit === 'db') return `+${value.toFixed(1)} dB`;
    if (value < 1) return `${value.toFixed(2)} ms`;
    if (value < 10) return `${value.toFixed(1)} ms`;
    return `${Math.round(value)} ms`;
}

function readDynamicsFromUI() {
    const values = {};
    Object.keys(DYNAMICS).forEach((key) => {
        const slider = document.getElementById(DYNAMICS_CONTROLS[key]);
        values[key] = sliderToValue(slider.value, DYNAMICS[key]);
    });
    return values;
}

function renderDynamics(values) {
    Object.keys(DYNAMICS).forEach((key) => {
        const range = DYNAMICS[key];
        const slider = document.getElementById(DYNAMICS_CONTROLS[key]);
        const readout = document.getElementById(`${DYNAMICS_CONTROLS[key]}-value`);
        slider.value = String(valueToSlider(values[key], range));
        readout.textContent = formatValue(values[key], range);
    });
}

function setAdvancedVisibility(visible) {
    advancedSection.classList.toggle('disabled', !visible);
}

async function saveDynamics(values) {
    await browser.storage.local.set(values);
    await sendToActiveTab(Object.assign({
        type: 'THUNDERFOX_DYNAMICS',
        advancedEnabled: advancedToggle.checked
    }, values));
}

Object.keys(DYNAMICS).forEach((key) => {
    const slider = document.getElementById(DYNAMICS_CONTROLS[key]);
    slider.addEventListener('input', async () => {
        const values = readDynamicsFromUI();
        renderDynamics(values);
        await saveDynamics(values);
    });
});

advancedToggle.addEventListener('change', async () => {
    const enabled = advancedToggle.checked;
    setAdvancedVisibility(enabled);
    await browser.storage.local.set({ advancedEnabled: enabled });
    await sendToActiveTab(Object.assign({
        type: 'THUNDERFOX_DYNAMICS',
        advancedEnabled: enabled
    }, readDynamicsFromUI()));
});

advancedResetBtn.addEventListener('click', async () => {
    const defaults = {};
    Object.keys(DYNAMICS).forEach((key) => {
        defaults[key] = DYNAMICS[key].default;
    });
    renderDynamics(defaults);
    await saveDynamics(defaults);
});

/* Site exemption */

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

    await browser.storage.local.set({ exemptedSites });

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

exemptToggle.addEventListener('change', () => {
    applyExemptChange().catch((error) => {
        console.error('ThunderFox: failed to update exemption', error);
        exemptHint.textContent = 'Could not update the exemption list.';
        exemptHint.hidden = false;
    });
});

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

async function init() {
    // Resolve the tab first so every later message has somewhere to go. A
    // failure here must not take the rest of the popup down with it.
    try {
        await initExemptState();
    } catch (error) {
        console.error('ThunderFox: failed to resolve the active tab', error);
        setExemptUnavailable('Could not read the current tab.');
    }

    const stored = await browser.storage.local.get({
        enabled: true,
        hpEnabled: false,
        limiterThreshold: -12,
        eqGains: [0, 0, 0, 0, 0, 0, 0, 0],
        eqEnabled: true,
        advancedEnabled: false,
        preBoostDb: DYNAMICS.preBoostDb.default,
        compAttackMs: DYNAMICS.compAttackMs.default,
        compReleaseMs: DYNAMICS.compReleaseMs.default,
        limiterAttackMs: DYNAMICS.limiterAttackMs.default,
        limiterReleaseMs: DYNAMICS.limiterReleaseMs.default
    });

    toggle.checked = !!stored.enabled;
    setStatus(!!stored.enabled);
    hpToggle.checked = !!stored.hpEnabled;

    const initialEqEnabled = stored.eqEnabled !== undefined ? !!stored.eqEnabled : true;
    if (eqToggle) eqToggle.checked = initialEqEnabled;
    setEQVisibility(initialEqEnabled);
    limiterThreshold.value = String(-stored.limiterThreshold);
    renderLoudness();

    advancedToggle.checked = !!stored.advancedEnabled;
    setAdvancedVisibility(!!stored.advancedEnabled);
    renderDynamics({
        preBoostDb: stored.preBoostDb,
        compAttackMs: stored.compAttackMs,
        compReleaseMs: stored.compReleaseMs,
        limiterAttackMs: stored.limiterAttackMs,
        limiterReleaseMs: stored.limiterReleaseMs
    });

    // Initialize EQ sliders
    const gains = Array.isArray(stored.eqGains) && stored.eqGains.length === 8
        ? stored.eqGains
        : [0, 0, 0, 0, 0, 0, 0, 0];
    gains.forEach((gain, index) => {
        if (eqSliders[index]) {
            eqSliders[index].min = "-18";
            eqSliders[index].max = "18";
            eqSliders[index].value = String(gain);
            updateEQValue(index, gain);
        }
    });
    requestAnimationFrame(drawEQCurve);
}

toggle.addEventListener('change', async () => {
    const enabled = toggle.checked;
    await browser.storage.local.set({ enabled });
    setStatus(enabled);
    await sendToActiveTab({ type: 'THUNDERFOX_TOGGLE', enabled });
});

hpToggle.addEventListener('change', async () => {
    const enabled = hpToggle.checked;
    await browser.storage.local.set({ hpEnabled: enabled });
    await sendToActiveTab({ type: 'THUNDERFOX_HP_TOGGLE', enabled });
});

if (eqToggle) {
    eqToggle.addEventListener('change', async () => {
        const enabled = eqToggle.checked;
        setEQVisibility(enabled);
        await browser.storage.local.set({ eqEnabled: enabled });
        await sendToActiveTab({ type: 'THUNDERFOX_EQ_TOGGLE', enabled });
    });
}

// One macro morphs compression strength and limiter drive together, so the
// readout is a percentage rather than either underlying value.
function renderLoudness() {
    if (!loudnessValue) return;
    const percent = Math.round((Number(limiterThreshold.value) / MAX_LOUDNESS_DB) * 100);
    loudnessValue.textContent = `${percent}%`;
}

limiterThreshold.addEventListener('input', async () => {
    const th = -Number(limiterThreshold.value);
    renderLoudness();
    await browser.storage.local.set({ limiterThreshold: th });
    await sendToActiveTab({ type: 'THUNDERFOX_LIMITER_THRESHOLD', threshold: th });
});

function updateEQValue(bandIndex, value) {
    if (eqValues[bandIndex]) {
        eqValues[bandIndex].textContent = value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
    }
}

async function updateEQBand(bandIndex) {
    const gainDb = Number(eqSliders[bandIndex].value);
    updateEQValue(bandIndex, gainDb);

    // Get current gains and update
    const { eqGains } = await browser.storage.local.get({ eqGains: [0, 0, 0, 0, 0, 0, 0, 0] });
    const gains = Array.isArray(eqGains) && eqGains.length === 8 ? eqGains : [0, 0, 0, 0, 0, 0, 0, 0];
    gains[bandIndex] = gainDb;

    await browser.storage.local.set({ eqGains: gains });
    await sendToActiveTab({ type: 'THUNDERFOX_EQ_GAIN', bandIndex, gainDb });
    requestAnimationFrame(drawEQCurve);
}

// Add event listeners for all EQ sliders
eqSliders.forEach((slider, index) => {
    if (slider) {
        slider.addEventListener('input', () => updateEQBand(index));
    }
});

// Reset EQ button handler
async function resetEQ() {
    const resetGains = [0, 0, 0, 0, 0, 0, 0, 0];

    resetGains.forEach((gain, index) => {
        if (eqSliders[index]) {
            eqSliders[index].value = String(gain);
            updateEQValue(index, gain);
        }
    });
    requestAnimationFrame(drawEQCurve);

    await browser.storage.local.set({ eqGains: resetGains });
    await sendToActiveTab({ type: 'THUNDERFOX_EQ_GAINS', gainsDb: resetGains });
}

if (eqResetBtn) {
    eqResetBtn.addEventListener('click', resetEQ);
}

if (manageExemptionsBtn) {
    manageExemptionsBtn.addEventListener('click', async () => {
        await browser.runtime.openOptionsPage();
        window.close();
    });
}

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

    const points = eqSliders.map(slider => {
        if (!slider) return null;
        const sRect = slider.getBoundingClientRect();
        // Calculate center X relative to the bands container
        const x = sRect.left + sRect.width / 2 - rect.left;

        // Calculate Y based on slider value
        // The slider is rotated -90deg, so "max" is visually at the top
        const centerY = sRect.top + sRect.height / 2 - rect.top;
        const val = parseFloat(slider.value);
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);

        // Visual travel distance of the thumb, measured rather than hardcoded
        // so the curve follows whatever dimensions the CSS specifies.
        const trackLength = Math.max(sRect.height - thumbSize, 1);

        // Normalize value (-1 to 1)
        const norm = (val - (min + max) / 2) / ((max - min) / 2);
        // Invert Y because screen Y grows downwards, but we want max value at top
        const y = centerY - (norm * (trackLength / 2));

        return { x, y };
    }).filter(p => p !== null);

    if (points.length < 2) return;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    // Draw smooth curve through points
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = p1.y + (p2.y - p0.y) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = p2.y - (p3.y - p1.y) / 6;

        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
    ctx.stroke();
}

window.addEventListener('resize', drawEQCurve);

init().catch((error) => {
    console.error('ThunderFox: popup failed to initialize', error);
});
