// Shared site-exemption helpers. Loaded into the content script sandbox, the
// popup and the options page, so all three agree on what "exempted" means.
var ThunderFoxSites = (function() {
    const DEFAULT_EXEMPTED_SITES = ['bandcamp.com'];

    // Only pages served over these schemes can be exempted; about:, moz-extension:
    // and friends never run our processing in a way the user can act on.
    const EXEMPTABLE_PROTOCOLS = ['http:', 'https:'];

    function normalizeHostname(value) {
        if (typeof value !== 'string') return '';

        const trimmed = value.trim().toLowerCase();
        if (!trimmed) return '';

        const candidate = /^[a-z][a-z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;

        let parsed;
        try {
            parsed = new URL(candidate);
        } catch (_) {
            return '';
        }

        if (!EXEMPTABLE_PROTOCOLS.includes(parsed.protocol)) return '';

        const hostname = parsed.hostname.replace(/^\.+|\.+$/g, '');
        if (!hostname) return '';

        // URL() already punycodes unicode hosts, so anything left outside this
        // set (spaces, slashes, wildcards) came from malformed input.
        if (/[^a-z\d.\-\[\]:]/.test(hostname)) return '';

        return hostname;
    }

    function sanitizeExemptedSites(value) {
        const sites = Array.isArray(value) ? value : [];
        const uniqueSites = new Set();

        sites.forEach((site) => {
            const normalized = normalizeHostname(site);
            if (normalized) uniqueSites.add(normalized);
        });

        return Array.from(uniqueSites).sort((left, right) => left.localeCompare(right));
    }

    function getStoredExemptedSites(value) {
        return value === undefined ? DEFAULT_EXEMPTED_SITES.slice() : sanitizeExemptedSites(value);
    }

    // Every stored rule that covers this hostname, so callers can remove the
    // rule that is actually responsible rather than guessing at an exact match.
    function matchingRules(hostname, exemptedSites) {
        const normalizedHostname = normalizeHostname(hostname);
        if (!normalizedHostname) return [];

        const sites = Array.isArray(exemptedSites) ? exemptedSites : [];
        return sites.filter((site) => {
            const normalizedSite = normalizeHostname(site);
            if (!normalizedSite) return false;
            return normalizedHostname === normalizedSite || normalizedHostname.endsWith(`.${normalizedSite}`);
        });
    }

    function isHostnameExempted(hostname, exemptedSites) {
        return matchingRules(hostname, exemptedSites).length > 0;
    }

    function isExemptableUrl(url) {
        if (typeof url !== 'string' || !url) return false;
        try {
            return EXEMPTABLE_PROTOCOLS.includes(new URL(url).protocol);
        } catch (_) {
            return false;
        }
    }

    return {
        DEFAULT_EXEMPTED_SITES,
        normalizeHostname,
        sanitizeExemptedSites,
        getStoredExemptedSites,
        matchingRules,
        isHostnameExempted,
        isExemptableUrl
    };
})();
