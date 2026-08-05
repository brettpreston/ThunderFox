// Subframes cannot see the top-level page URL cross-origin, and Firefox does
// not implement location.ancestorOrigins. The background page is the only
// place that knows which tab a frame belongs to.
browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === 'THUNDERFOX_GET_TOP_URL') {
        return Promise.resolve({ url: (sender && sender.tab && sender.tab.url) || '' });
    }
});
