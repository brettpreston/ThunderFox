const toggle = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const hpToggle = document.getElementById('hpToggle');
const limiterThreshold = document.getElementById('limiterThreshold');
const eqSliders = Array.from({ length: 8 }, (_, i) => document.getElementById(`eq${i}`));
const eqValues = Array.from({ length: 8 }, (_, i) => document.getElementById(`eq${i}-value`));
const eqResetBtn = document.getElementById('eqReset');

function setStatus(enabled) {
    statusEl.textContent = enabled ? 'Enabled' : 'Disabled';
}

async function init() {
    const { enabled, hpEnabled, limiterThreshold: limiterThDb, eqGains } = await browser.storage.local.get({ 
        enabled: true, 
        hpEnabled: false, 
        limiterThreshold: -6,
        eqGains: [0, 0, 0, 0, 0, 0, 0, 0]
    });
    
    // Ensure hpEnabled defaults to false if not set
    const hpEnabledValue = hpEnabled !== undefined ? hpEnabled : false;
    toggle.checked = !!enabled;
    setStatus(!!enabled);
    hpToggle.checked = !!hpEnabledValue;
    limiterThreshold.value = String(-limiterThDb);
    
    // Initialize EQ sliders
    const gains = Array.isArray(eqGains) && eqGains.length === 8 ? eqGains : [0, 0, 0, 0, 0, 0, 0, 0];
    gains.forEach((gain, index) => {
        if (eqSliders[index]) {
            eqSliders[index].value = String(gain);
            updateEQValue(index, gain);
        }
    });
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

init();


