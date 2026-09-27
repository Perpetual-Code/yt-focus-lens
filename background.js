/* Background service worker: captures YouTube search queries for hybrid auto-detect + daily stats reset. */

const MAX_RECENT = 10;

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status !== 'complete' || !tab.url) return;
    if (!tab.url.includes('youtube.com/results')) return;
    const u = new URL(tab.url);
    const q = (u.searchParams.get('search_query') || '').trim();
    if (q.length < 2) return;

    const data = await chrome.storage.local.get({ recentQueries: [], stats: null });
    const recent = Array.isArray(data.recentQueries) ? data.recentQueries : [];
    // move to front, dedupe case-insensitive
    const lower = q.toLowerCase();
    const filtered = recent.filter((x) => String(x).toLowerCase() !== lower);
    filtered.unshift(q);
    await chrome.storage.local.set({ recentQueries: filtered.slice(0, MAX_RECENT) });
  } catch (e) {
    // ignore
  }
});

// Reset daily counter on startup / install
async function maybeResetDaily() {
  const today = new Date().toISOString().slice(0, 10);
  const data = await chrome.storage.local.get({ stats: null });
  const st = data.stats || {};
  if (st.date !== today) {
    await chrome.storage.local.set({
      stats: { hiddenTotal: st.hiddenTotal || 0, hiddenToday: 0, date: today }
    });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  // Sidebar: open side panel when toolbar icon is clicked (Chrome 114+).
  // Popup.html stays as fallback for older Chrome versions.
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
    if (chrome.sidePanel?.setOptions) {
      await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: true });
    }
  } catch (e) {
    // sidePanel API unavailable – popup fallback still works
  }

  const existing = await chrome.storage.local.get(null);
  if (typeof existing.enabled === 'undefined') {
    await chrome.storage.local.set({
      enabled: true,
      focusKeywords: [],
      autoDetect: true,
      recentQueries: [],
      filters: { hideShorts: true, filterHome: true, filterSearch: true, filterSidebar: true },
      stats: { hiddenTotal: 0, hiddenToday: 0, date: new Date().toISOString().slice(0, 10) }
    });
  }
  await maybeResetDaily();
  const state = await chrome.storage.local.get({ enabled: true });
  await updateActionIcon(state.enabled);
});

chrome.runtime.onStartup.addListener(async () => {
  await maybeResetDaily();
  const state = await chrome.storage.local.get({ enabled: true });
  await updateActionIcon(state.enabled);
});

// Grey out the toolbar icon when the master toggle is OFF.
async function updateActionIcon(enabled) {
  try {
    const suffix = enabled === false ? '-grey' : '';
    await chrome.action.setIcon({
      path: {
        16: `icons/icon16${suffix}.png`,
        32: `icons/icon32${suffix}.png`,
        48: `icons/icon48${suffix}.png`,
        128: `icons/icon128${suffix}.png`
      }
    });
    await chrome.action.setTitle({
      title: enabled === false
        ? 'YouTube Focus Filter (OFF – click to open sidebar)'
        : 'YouTube Focus Filter – click to open sidebar'
    });
  } catch (e) { /* action API unavailable */ }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) updateActionIcon(changes.enabled.newValue);
});

/* Fresh-start flush: called when user activates the filter (OFF -> ON).
 * Clears LOCAL state only:
 *  1. Extension storage (recentQueries + stats) -> rebuild allowlist from focusKeywords only
 *  2. Browser history entries for youtube.com (chrome.history, needs "history" permission)
 *  3. Notifies open YouTube tabs to wipe youtube.com local/session keys + re-filter
 * NOTE: Google server-side watch history (myactivity.google.com) CANNOT be deleted
 * by a local extension without YouTube API + OAuth. The sidebar links there for that step.
 */
async function purgeYouTubeBrowserHistory() {
  let removed = 0;
  try {
    if (!chrome.history?.search || !chrome.history?.deleteUrl) return { removed: 0, skipped: true };
    const results = await chrome.history.search({ text: 'youtube.com', maxResults: 500, startTime: 0 });
    const ytUrls = results
      .map((r) => r.url)
      .filter((u) => u && u.includes('youtube.com/'));
    // delete in small batches to avoid hammering the API
    for (const url of ytUrls.slice(0, 300)) {
      try {
        await chrome.history.deleteUrl({ url });
        removed++;
      } catch (e) { /* keep going */ }
    }
  } catch (e) { /* history API unavailable/blocked */ }
  return { removed, skipped: false };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'DIAGNOSE') {
    (async () => {
      const out = { tabs: [] };
      try {
        const ytTabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
        for (const t of ytTabs.slice(0, 5)) {
          const row = { tabId: t.id, url: (t.url || '').slice(0, 80) };
          try {
            row.diag = await chrome.tabs.sendMessage(t.id, { type: 'DIAG' });
          } catch (e) {
            // stale content script – re-inject current files, then retry once
            try {
              if (chrome.scripting?.executeScript) {
                await chrome.scripting.executeScript({
                  target: { tabId: t.id },
                  files: ['utils.js', 'content.js']
                });
                row.reinjected = true;
                row.diag = await chrome.tabs.sendMessage(t.id, { type: 'DIAG' }).catch(() => ({ ok: false, error: 'no-answer-after-inject' }));
              } else {
                row.diag = { ok: false, error: 'stale-tab-reload-manually' };
              }
            } catch (e2) {
              row.diag = { ok: false, error: String(e2).slice(0, 120) };
            }
          }
          out.tabs.push(row);
        }
      } catch (e) {
        out.error = String(e).slice(0, 200);
      }
      try {
        out.storage = await chrome.storage.local.get({
          enabled: true, focusKeywords: [], autoDetect: true, recentQueries: []
        });
      } catch (e) { /* ignore */ }
      sendResponse(out);
    })();
    return true;
  }
  if (!msg || msg.type !== 'FRESH_START') return false;
  (async () => {
    const { removed, skipped } = await purgeYouTubeBrowserHistory();
    const today = new Date().toISOString().slice(0, 10);
    await chrome.storage.local.set({
      recentQueries: [],
      stats: { hiddenTotal: 0, hiddenToday: 0, date: today },
      freshStartId: Date.now()
    });
    // Tell every open YouTube tab to wipe site storage (DevTools → Application →
    // Local/Session Storage) + re-filter from new allowlist, then reload the tab
    // so YouTube reboots on clean storage.
    let notified = 0;
    let reinjected = 0;
    let siteKeysCleared = 0;
    let tabsReloaded = 0;
    async function flushOneTab(t) {
      let report = null;
      try {
        report = await chrome.tabs.sendMessage(t.id, { type: 'FRESH_START_APPLIED' });
        notified++;
      } catch (e) {
        // stale content script – re-inject current utils.js + content.js, then retry
        try {
          if (chrome.scripting?.executeScript) {
            await chrome.scripting.executeScript({
              target: { tabId: t.id },
              files: ['utils.js', 'content.js']
            });
            reinjected++;
            report = await chrome.tabs.sendMessage(t.id, { type: 'FRESH_START_APPLIED' }).catch(() => null);
            if (report) notified++;
          }
        } catch (e2) { /* tab gone or injection blocked */ }
      }
      if (report && report.ok) {
        siteKeysCleared += (report.localCleared || 0) + (report.sessionCleared || 0);
      }
      try {
        await chrome.tabs.reload(t.id);
        tabsReloaded++;
      } catch (e) { /* tab gone */ }
    }
    try {
      const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
      for (const t of tabs) await flushOneTab(t);
    } catch (e) { /* no tabs or messaging failed */ }
    sendResponse({ ok: true, historyRemoved: removed, historySkipped: skipped, notified, reinjected, siteKeysCleared, tabsReloaded });
  })();
  return true; // async response
});
