/* Side panel logic – same storage schema as popup, optimized for sidebar width. */
const $ = (id) => document.getElementById(id);
let saveTimer = null;
let wasEnabled = true;

async function requestFreshStart() {
  const msgEl = $('freshMsg');
  if (msgEl) msgEl.textContent = 'Flushing old history, rebuilding from your focus…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'FRESH_START' });
    const n = res?.historyRemoved ?? 0;
    const parts = [`cleared ${n} YouTube address-bar history entr${n === 1 ? 'y' : 'ies'} + old focus state`];
    if (typeof res?.siteKeysCleared === 'number') {
      parts.push(`wiped ${res.siteKeysCleared} Local/Session Storage keys`);
    }
    if (res?.tabsReloaded > 0) {
      parts.push(`reloaded ${res.tabsReloaded} YouTube tab${res.tabsReloaded === 1 ? '' : 's'} on clean storage`);
    }
    if (res?.historySkipped) {
      parts.push('⚠️ browser-history permission missing — go to chrome://extensions, Reload this extension, accept new permissions, and retry');
    }
    if (res?.reinjected > 0) {
      parts.push(`re-connected ${res.reinjected} already-open YouTube tab${res.reinjected === 1 ? '' : 's'}`);
    } else if (res?.notified === 0) {
      parts.push('no open YouTube tabs found — open youtube.com to see the clean feed');
    }
    parts.push('Now building only from your topics. NOTE: your YouTube History page (account) is server-side and unchanged — clear it at youtube.com/feed/history if you want that too.');
    if (msgEl) msgEl.textContent = 'Fresh start done — ' + parts.join('. ') + '.';
  } catch (e) {
    // service worker unreachable – do the storage half directly
    try {
      await chrome.storage.local.set({
        recentQueries: [],
        stats: { hiddenTotal: 0, hiddenToday: 0, date: new Date().toISOString().slice(0, 10) },
        freshStartId: Date.now()
      });
      if (msgEl) msgEl.textContent = 'Fresh start done — cleared extension history. Now building only from your topics.';
    } catch (e2) {
      if (msgEl) msgEl.textContent = 'Fresh start failed — storage unavailable.';
    }
  }
  const d = await chrome.storage.local.get({ recentQueries: [], stats: {} });
  renderRecent(d.recentQueries || []);
  renderStats(d.stats || {});
  renderStatus();
}

async function load() {
  const d = await chrome.storage.local.get({
    enabled: true,
    focusKeywords: [],
    autoDetect: true,
    recentQueries: [],
    filters: { hideShorts: true, filterHome: true, filterSearch: true, filterSidebar: true },
    stats: { hiddenTotal: 0, hiddenToday: 0, date: '' }
  });

  $('enabled').checked = d.enabled !== false;
  wasEnabled = $('enabled').checked;
  $('keywords').value = Array.isArray(d.focusKeywords) ? d.focusKeywords.join(', ') : String(d.focusKeywords || '');
  $('autoDetect').checked = d.autoDetect !== false;
  $('fShorts').checked = d.filters?.hideShorts !== false;
  $('fHome').checked = d.filters?.filterHome !== false;
  $('fSearch').checked = d.filters?.filterSearch !== false;
  $('fSidebar').checked = d.filters?.filterSidebar !== false;

  renderRecent(d.recentQueries || []);
  renderStats(d.stats || {});
  renderStatus();
}

function renderRecent(list) {
  const box = $('recentList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<span class="empty">No searches captured yet. Search on YouTube and it appears here.</span>';
    return;
  }
  list.slice(0, 10).forEach((q) => {
    const s = document.createElement('span');
    s.className = 'chip';
    const label = document.createElement('span');
    label.textContent = q;
    const x = document.createElement('button');
    x.className = 'chip-x';
    x.textContent = '×';
    x.title = `Remove "${q}"`;
    x.setAttribute('aria-label', `Remove ${q} from recent searches`);
    x.addEventListener('click', () => removeRecentTerm(q));
    s.appendChild(label);
    s.appendChild(x);
    box.appendChild(s);
  });
}

async function removeRecentTerm(term) {
  const d = await chrome.storage.local.get({ recentQueries: [] });
  const recent = Array.isArray(d.recentQueries) ? d.recentQueries : [];
  const idx = recent.findIndex((x) => x === term);
  if (idx !== -1) recent.splice(idx, 1);
  await chrome.storage.local.set({ recentQueries: recent });
  renderRecent(recent);
  renderStatus();
}

function renderStats(st) {
  $('statsLine').textContent = `Hidden today: ${st.hiddenToday || 0} • All time: ${st.hiddenTotal || 0}`;
}

function renderStatus() {
  const on = $('enabled').checked;
  const kw = parseKeywords($('keywords').value);
  $('statusLine').textContent = on
    ? (kw.length ? `ON • ${kw.length} focus keyword${kw.length > 1 ? 's' : ''}` : 'ON • no focus set → allowing all')
    : 'OFF • YouTube restored';
  $('offBanner').hidden = on;
  const allow = buildAllowlist($('keywords').value, [], $('autoDetect').checked);
  $('allowPreview').textContent = allow.length
    ? ($('autoDetect').checked
        ? 'Allowing (manual): ' + allow.slice(0, 8).join(', ') + ' + recent searches'
        : 'Allowing: ' + allow.slice(0, 8).join(', '))
    : 'No focus keywords yet — add some to start strict filtering.';
}

async function save() {
  const focusKeywords = parseKeywords($('keywords').value);
  const enabled = $('enabled').checked;
  await chrome.storage.local.set({
    enabled,
    focusKeywords,
    autoDetect: $('autoDetect').checked,
    filters: {
      hideShorts: $('fShorts').checked,
      filterHome: $('fHome').checked,
      filterSearch: $('fSearch').checked,
      filterSidebar: $('fSidebar').checked
    }
  });
  // instant toolbar feedback (background storage listener is the backstop)
  try {
    const suffix = enabled ? '' : '-grey';
    await chrome.action.setIcon({
      path: {
        16: `icons/icon16${suffix}.png`,
        32: `icons/icon32${suffix}.png`,
        48: `icons/icon48${suffix}.png`,
        128: `icons/icon128${suffix}.png`
      }
    });
  } catch (e) {}
  const d = await chrome.storage.local.get({ recentQueries: [], stats: {} });
  renderRecent(d.recentQueries || []);
  renderStats(d.stats || {});
  renderStatus();
}

function scheduleSave() {
  renderStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  ['autoDetect', 'fShorts', 'fHome', 'fSearch', 'fSidebar'].forEach((id) => {
    $(id).addEventListener('change', save);
  });
  $('enabled').addEventListener('change', async () => {
    const turningOn = $('enabled').checked && !wasEnabled;
    if (turningOn) {
      const ok = confirm(
        'Activate Focus Filter?\n\nThis clears old YouTube history in THIS browser (extension state + youtube.com browser-history entries + YouTube site keys) and rebuilds only from your focus topics.\n\nGoogle server-side history is NOT touched — clear that at myactivity.google.com if you want recommendations reset there too.'
      );
      if (!ok) {
        $('enabled').checked = false;
        renderStatus();
        return;
      }
      await save();
      wasEnabled = true;
      await requestFreshStart();
      return;
    }
    wasEnabled = $('enabled').checked;
    await save();
  });
  $('keywords').addEventListener('input', scheduleSave);
  $('clearRecent').addEventListener('click', async () => {
    await chrome.storage.local.set({ recentQueries: [] });
    renderRecent([]);
  });
  $('resetStats').addEventListener('click', async () => {
    const fresh = { hiddenTotal: 0, hiddenToday: 0, date: new Date().toISOString().slice(0, 10) };
    await chrome.storage.local.set({ stats: fresh });
    renderStats(fresh);
  });
  $('openYouTube').addEventListener('click', async () => {
    await chrome.tabs.create({ url: 'https://www.youtube.com/' });
  });
  $('freshStart').addEventListener('click', async () => {
    const ok = confirm(
      'Start fresh?\n\nClears old YouTube history in THIS browser (extension state + youtube.com browser-history entries + YouTube site keys) and rebuilds only from your focus topics.'
    );
    if (ok) await requestFreshStart();
  });
  $('clearAccountHistory').addEventListener('click', async () => {
    // Server-side history can only be cleared by the signed-in user on YouTube itself.
    await chrome.tabs.create({ url: 'https://www.youtube.com/feed/history' });
    if ($('freshMsg')) $('freshMsg').textContent = 'Opened your YouTube History page — click “Clear all watch history” there (right side), then come back and hit 🧹 Start fresh.';
  });
  $('diagBtn').addEventListener('click', async () => {
    const out = $('diagOut');
    out.hidden = false;
    out.textContent = 'Diagnosing…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'DIAGNOSE' });
      const lines = [];
      const st = res?.storage || {};
      lines.push(`stored: enabled=${st.enabled} focus=${JSON.stringify(st.focusKeywords)} autoDetect=${st.autoDetect} recent=${JSON.stringify((st.recentQueries || []).slice(0, 3))}`);
      if (!res?.tabs?.length) {
        lines.push('No open YouTube tabs. Open youtube.com, then Diagnose again.');
      }
      for (const t of res?.tabs || []) {
        const d = t.diag || {};
        lines.push(`— tab ${t.tabId} [${t.url}]`);
        if (d.ok) {
          lines.push(`  page=${d.pageType} enabled=${d.enabled} allowlist=${d.allowlistSize} (${(d.allowlistPreview || []).join(', ') || 'EMPTY → allows all'}) videos=${d.videoCount} hidden=${d.hiddenCount} badge=${d.badgePresent}`);
          if (d.storageKeys) lines.push(`  site storage keys: local=${d.storageKeys.local} session=${d.storageKeys.session} (DevTools → Application → Storage)`);
          (d.sample || []).forEach((s) => lines.push(`  • ${s}`));
          if (d.videoCount === 0) lines.push('  ⚠️ no video elements found — page may still be loading, or YouTube changed its DOM');
          if (!d.allowlistSize) lines.push('  ⚠️ allowlist EMPTY — add focus keywords, otherwise everything is allowed');
          if (d.videoCount > 0 && d.hiddenCount === 0 && d.allowlistSize > 0) lines.push('  ⚠️ nothing hidden despite non-empty allowlist — titles may genuinely all match, or matching is too loose');
        } else {
          lines.push(`  ⚠️ tab not responding (${d.error || 'unknown'}) — reload that YouTube tab and retry`);
        }
        if (t.reinjected) lines.push('  (re-injected current content script into this stale tab)');
      }
      out.textContent = lines.join('\n');
    } catch (e) {
      out.textContent = 'Diagnose failed: ' + String(e).slice(0, 200);
    }
  });
});

// live-update when content script / background changes stats
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.stats) renderStats(changes.stats.newValue || {});
  if (changes.recentQueries) renderRecent(changes.recentQueries.newValue || []);
});
