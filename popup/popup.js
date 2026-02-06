const toggle = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const hpToggle = document.getElementById('hpToggle');
const limiterThreshold = document.getElementById('limiterThreshold');
const eqSliders = Array.from({ length: 8 }, (_, i) => document.getElementById(`eq${i}`));
const eqValues = Array.from({ length: 8 }, (_, i) => document.getElementById(`eq${i}-value`));
const eqResetBtn = document.getElementById('eqReset');
const eqSection = document.querySelector('.eq-section');
const eqBands = document.querySelector('.eq-bands');

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
const eqTitle = eqHeader.querySelector('.eq-title');

const eqSwitchLabel = document.createElement('label');
eqSwitchLabel.className = 'switch';
eqSwitchLabel.style.transform = 'scale(0.8)';

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

async function init() {
    const { enabled, hpEnabled, limiterThreshold: limiterThDb, eqGains, eqEnabled } = await browser.storage.local.get({ 
        enabled: true, 
        hpEnabled: false, 
        limiterThreshold: -6,
        eqGains: [0, 0, 0, 0, 0, 0, 0, 0],
        eqEnabled: true
    });
    
    // Ensure hpEnabled defaults to false if not set
    const hpEnabledValue = hpEnabled !== undefined ? hpEnabled : false;
    toggle.checked = !!enabled;
    setStatus(!!enabled);
    hpToggle.checked = !!hpEnabledValue;
    const initialEqEnabled = eqEnabled !== undefined ? !!eqEnabled : true;
    if (eqToggle) eqToggle.checked = initialEqEnabled;
    setEQVisibility(initialEqEnabled);
    limiterThreshold.value = String(-limiterThDb);
    
    // Initialize EQ sliders
    const gains = Array.isArray(eqGains) && eqGains.length === 8 ? eqGains : [0, 0, 0, 0, 0, 0, 0, 0];
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
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
        try {
            await browser.tabs.sendMessage(tabs[0].id, { type: 'THUNDERFOX_TOGGLE', enabled });
        } catch (e) {
            // Blarg, a thousand times BLARG!
        }
    }
});

hpToggle.addEventListener('change', async () => {
    const enabled = hpToggle.checked;
    await browser.storage.local.set({ hpEnabled: enabled });
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
        try {
            await browser.tabs.sendMessage(tabs[0].id, { type: 'THUNDERFOX_HP_TOGGLE', enabled });
        } catch (_) {}
    }
});

if (eqToggle) {
    eqToggle.addEventListener('change', async () => {
        const enabled = eqToggle.checked;
        setEQVisibility(enabled);
        await browser.storage.local.set({ eqEnabled: enabled });
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
            try {
                await browser.tabs.sendMessage(tabs[0].id, { type: 'THUNDERFOX_EQ_TOGGLE', enabled });
            } catch (_) {}
        }
    });
}

limiterThreshold.addEventListener('input', async () => {
    const th = -Number(limiterThreshold.value);
    await browser.storage.local.set({ limiterThreshold: th });
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
        try {
            await browser.tabs.sendMessage(tabs[0].id, { type: 'THUNDERFOX_LIMITER_THRESHOLD', threshold: th });
        } catch (_) {}
    }
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
    
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
        try {
            await browser.tabs.sendMessage(tabs[0].id, { 
                type: 'THUNDERFOX_EQ_GAIN', 
                bandIndex, 
                gainDb 
            });
        } catch (_) {}
    }
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
    
    // Update UI
    resetGains.forEach((gain, index) => {
        if (eqSliders[index]) {
            eqSliders[index].value = String(gain);
            updateEQValue(index, gain);
        }
    });
    requestAnimationFrame(drawEQCurve);
    
    // Save to storage
    await browser.storage.local.set({ eqGains: resetGains });
    
    // Send message to content script
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
        try {
            await browser.tabs.sendMessage(tabs[0].id, { 
                type: 'THUNDERFOX_EQ_GAINS', 
                gainsDb: resetGains 
            });
        } catch (_) {}
    }
}

if (eqResetBtn) {
    eqResetBtn.addEventListener('click', resetEQ);
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
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

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
        
        // Visual travel distance of the thumb (90px track - 18px thumb)
        const trackLength = 72; 
        
        // Normalize value (-1 to 1)
        const norm = (val - (min + max)/2) / ((max - min)/2);
        // Invert Y because screen Y grows downwards, but we want max value at top
        const y = centerY - (norm * (trackLength / 2));
        
        return { x, y };
    }).filter(p => p !== null);

    if (points.length < 2) return;

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    // Draw smooth curve through points
    for (let i = 0; i < points.length - 1; i++) {
        const midX = (points[i].x + points[i+1].x) / 2;
        const midY = (points[i].y + points[i+1].y) / 2;
        const cp1x = (points[i].x + midX) / 2;
        const cp1y = points[i].y; 

        // tension spline logic
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];

        const cp1x_t = p1.x + (p2.x - p0.x) / 6;
        const cp1y_t = p1.y + (p2.y - p0.y) / 6;
        const cp2x_t = p2.x - (p3.x - p1.x) / 6;
        const cp2y_t = p2.y - (p3.y - p1.y) / 6;

        ctx.bezierCurveTo(cp1x_t, cp1y_t, cp2x_t, cp2y_t, p2.x, p2.y);
    }
    ctx.stroke();
}

window.addEventListener('resize', drawEQCurve);

init();
