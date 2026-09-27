/* Popup logic – vanilla, MV3-safe */
const $ = (id) => document.getElementById(id);
let saveTimer = null;
let wasEnabled = true;

async function requestFreshStart() {
  const msgEl = $('freshMsg');
  if (msgEl) msgEl.textContent = 'Flushing old history, rebuilding from your focus…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'FRESH_START' });
    const n = res?.historyRemoved ?? 0;
    let extra = '';
    if (typeof res?.siteKeysCleared === 'number') extra += ` Wiped ${res.siteKeysCleared} site-storage keys.`;
    if (res?.tabsReloaded > 0) extra += ` Reloaded ${res.tabsReloaded} YouTube tab(s).`;
    if (res?.historySkipped) extra += ' ⚠️ Reload the extension at chrome://extensions to grant history permission, then retry.';
    if (res?.reinjected > 0) extra += ` Re-connected ${res.reinjected} open YouTube tab(s).`;
    else if (res?.notified === 0) extra += ' No open YouTube tabs — open youtube.com to see the clean feed.';
    if (msgEl) msgEl.textContent = `Fresh start done — cleared ${n} YouTube history entr${n === 1 ? 'y' : 'ies'} + old focus state.${extra}`;
  } catch (e) {
    try {
      await chrome.storage.local.set({
        recentQueries: [],
        stats: { hiddenTotal: 0, hiddenToday: 0, date: new Date().toISOString().slice(0, 10) },
        freshStartId: Date.now()
      });
      if (msgEl) msgEl.textContent = 'Fresh start done — cleared extension history.';
    } catch (e2) {
      if (msgEl) msgEl.textContent = 'Fresh start failed — storage unavailable.';
    }
  }
  const d = await chrome.storage.local.get({ recentQueries: [] });
  renderRecent(d.recentQueries || []);
  const st = await chrome.storage.local.get({ stats: {} });
  renderStats(st.stats || {});
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
  const recent = $('autoDetect').checked ? parseKeywords([]) : [];
  $('statusLine').textContent = on
    ? (kw.length ? `ON • ${kw.length} focus keyword${kw.length > 1 ? 's' : ''}` : 'ON • no focus set → allowing all')
    : 'OFF • YouTube restored, no filtering';
  const allow = buildAllowlist($('keywords').value, [], $('autoDetect').checked);
  // show manual part + note about auto
  $('allowPreview').textContent =
    allow.length && !$('autoDetect').checked
      ? 'Allowing: ' + allow.slice(0, 8).join(', ')
      : allow.length
        ? 'Allowing (manual): ' + allow.slice(0, 8).join(', ') + ' + recent searches'
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
  // re-read recent for preview of hybrid (don't overwrite recent on save)
  const d = await chrome.storage.local.get({ recentQueries: [] });
  renderRecent(d.recentQueries || []);
  const st = await chrome.storage.local.get({ stats: {} });
  renderStats(st.stats || {});
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
        'Activate Focus Filter?\n\nThis clears old YouTube history in THIS browser and rebuilds only from your focus topics.\n\nGoogle server-side history is NOT touched.'
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
    await chrome.storage.local.set({
      stats: { hiddenTotal: 0, hiddenToday: 0, date: new Date().toISOString().slice(0, 10) }
    });
    renderStats({ hiddenTotal: 0, hiddenToday: 0 });
  });
  $('freshStart').addEventListener('click', async () => {
    const ok = confirm('Start fresh? Clears old YouTube history in THIS browser and rebuilds only from your focus topics.');
    if (ok) await requestFreshStart();
  });
});
