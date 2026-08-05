const exemptionForm = document.getElementById('exemptionForm');
const siteInput = document.getElementById('siteInput');
const siteList = document.getElementById('siteList');
const emptyState = document.getElementById('emptyState');
const formMessage = document.getElementById('formMessage');
const resetDefaultsBtn = document.getElementById('resetDefaults');

let exemptedSites = [];

function setFormMessage(message, state = '') {
    formMessage.textContent = message;
    if (state) {
        formMessage.dataset.state = state;
    } else {
        delete formMessage.dataset.state;
    }
}

function renderList() {
    siteList.textContent = '';
    emptyState.hidden = exemptedSites.length > 0;

    exemptedSites.forEach((site) => {
        const item = document.createElement('li');
        item.className = 'site-item';

        const value = document.createElement('span');
        value.className = 'site-value';
        value.textContent = site;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-btn';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', async () => {
            exemptedSites = exemptedSites.filter((entry) => entry !== site);
            await saveExemptedSites();
            setFormMessage(`Removed ${site}. Reload open pages on that site to re-enable ThunderFox.`, 'success');
        });

        item.append(value, removeBtn);
        siteList.appendChild(item);
    });
}

async function saveExemptedSites() {
    await browser.storage.local.set({ exemptedSites });
    renderList();
}

async function loadExemptedSites() {
    const stored = await browser.storage.local.get({ exemptedSites: null });
    exemptedSites = ThunderFoxSites.getStoredExemptedSites(
        stored.exemptedSites === null ? undefined : stored.exemptedSites
    );
    renderList();
}

exemptionForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const normalized = ThunderFoxSites.normalizeHostname(siteInput.value);
    if (!normalized) {
        setFormMessage('Enter a valid domain or URL.', 'error');
        siteInput.focus();
        return;
    }

    if (exemptedSites.includes(normalized)) {
        setFormMessage(`${normalized} is already exempted.`, 'error');
        siteInput.select();
        return;
    }

    // A new entry is redundant if an existing rule already covers it.
    const covering = ThunderFoxSites.matchingRules(normalized, exemptedSites);
    if (covering.length > 0) {
        setFormMessage(`${normalized} is already covered by "${covering[0]}".`, 'error');
        siteInput.select();
        return;
    }

    // Conversely, adding a parent domain makes its subdomain entries redundant.
    const shadowed = exemptedSites.filter(
        (site) => ThunderFoxSites.matchingRules(site, [normalized]).length > 0
    );

    exemptedSites = ThunderFoxSites.sanitizeExemptedSites(
        [...exemptedSites.filter((site) => !shadowed.includes(site)), normalized]
    );
    await saveExemptedSites();
    siteInput.value = '';

    const shadowNote = shadowed.length > 0
        ? ` Replaced the now-redundant ${shadowed.join(', ')}.`
        : '';
    setFormMessage(
        `Added ${normalized}. Reload open pages on that site for a full bypass.${shadowNote}`,
        'success'
    );
    siteInput.focus();
});

resetDefaultsBtn.addEventListener('click', async () => {
    exemptedSites = ThunderFoxSites.DEFAULT_EXEMPTED_SITES.slice();
    await saveExemptedSites();
    setFormMessage('Restored the default exemption list.', 'success');
});

browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.exemptedSites) return;

    exemptedSites = ThunderFoxSites.getStoredExemptedSites(changes.exemptedSites.newValue);
    renderList();
});

loadExemptedSites().catch((error) => {
    console.error('ThunderFox: failed to load exempted sites', error);
    setFormMessage('Failed to load exemptions from storage.', 'error');
});
