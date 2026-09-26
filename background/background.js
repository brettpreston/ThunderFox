// Subframes cannot see the top-level page URL cross-origin, and Firefox does
// not implement location.ancestorOrigins. The background page is the only
// place that knows which tab a frame belongs to.
browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === 'THUNDERFOX_GET_TOP_URL') {
        return Promise.resolve({ url: (sender && sender.tab && sender.tab.url) || '' });
    }
});

// Bring stored settings up to the current schema. Runs on install and on
// every update, which is the only time a default can have changed underneath
// a stored value. Content scripts already running pick the result up through
// storage.onChanged, so nothing has to wait on this.
async function migrateSettings() {
    const stored = await browser.storage.local.get(null);
    const patch = ThunderFoxSettings.migrateStored(stored);
    if (Object.keys(patch).length === 0) return;
    await browser.storage.local.set(patch);
    console.info('ThunderFox: migrated settings to version', patch.settingsVersion);
}

browser.runtime.onInstalled.addListener(() => {
    migrateSettings().catch((error) => {
        console.error('ThunderFox: settings migration failed', error);
    });
});
