const toggle = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const hpToggle = document.getElementById('hpToggle');
const limiterThreshold = document.getElementById('limiterThreshold');

function setStatus(enabled) {
    statusEl.textContent = enabled ? 'Enabled' : 'Disabled';
}

async function init() {
    const { enabled, hpEnabled, limiterThreshold: limiterThDb } = await browser.storage.local.get({ enabled: true, hpEnabled: true, limiterThreshold: -3 });
    toggle.checked = !!enabled;
    setStatus(!!enabled);
    hpToggle.checked = !!hpEnabled;
    limiterThreshold.value = String(-limiterThDb);
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

init();


