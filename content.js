/* Content script: strict allowlist filtering for YouTube. 100% local. */
(() => {
  let settings = {
    enabled: true,
    focusKeywords: [],
    autoDetect: true,
    recentQueries: [],
    filters: { hideShorts: true, filterHome: true, filterSearch: true, filterSidebar: true }
  };
  let allowlist = [];
  let hiddenThisPage = 0;
  let debounceTimer = null;
  let statsFlushTimer = null;
  let sessionHidden = 0;
  let lastFreshStartId = 0;

  const VIDEO_SELECTORS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-playlist-panel-video-renderer',
    'ytd-compact-radio-renderer',
    'ytd-reel-item-renderer'
  ].join(',');

  const SHELF_SHORTS_SELECTORS = [
    'ytd-reel-shelf-renderer',
    'ytd-rich-shelf-renderer'
  ].join(',');

  async function loadSettings() {
    try {
      const d = await chrome.storage.local.get({
        enabled: true,
        focusKeywords: [],
        autoDetect: true,
        recentQueries: [],
        filters: { hideShorts: true, filterHome: true, filterSearch: true, filterSidebar: true },
        freshStartId: 0
      });
      settings = d;
      lastFreshStartId = d.freshStartId || 0;
      // buildAllowlist lives in utils.js (global)
      allowlist = buildAllowlist(d.focusKeywords, d.recentQueries, d.autoDetect);
    } catch (e) {
      // storage unavailable (shouldn't happen)
    }
  }

  // Full wipe of this origin's (youtube.com) DevTools → Application → Storage:
  // Local Storage + Session Storage. Auth lives in cookies, so this does NOT
  // log the user out – it drops player prefs, recent/continuation caches and
  // other site-side traces. Returns counts for the flush report.
  function clearYouTubeSiteKeys() {
    let localCleared = 0;
    let sessionCleared = 0;
    try {
      localCleared = localStorage.length;
      localStorage.clear();
    } catch (e) {}
    try {
      sessionCleared = sessionStorage.length;
      sessionStorage.clear();
    } catch (e) {}
    return { localCleared, sessionCleared };
  }

  async function applyFreshStart() {
    const wiped = clearYouTubeSiteKeys();
    restoreAll();
    sessionHidden = 0;
    flushStats._last = 0;
    await loadSettings();
    filterPass();
    // late-loading grids render after SPA transitions – sweep again
    // (skipped if background reloads the tab right after the report)
    setTimeout(filterPass, 1200);
    setTimeout(filterPass, 3000);
    return wiped;
  }

  function pageType() {
    const p = location.pathname;
    if (p.startsWith('/results')) return 'search';
    if (p.startsWith('/watch')) return 'watch';
    if (p.startsWith('/shorts')) return 'shortsPage';
    if (p === '/' || p.startsWith('/feed')) return 'home';
    return 'other';
  }

  function surfaceEnabled(type) {
    const f = settings.filters || {};
    if (type === 'home') return f.filterHome !== false;
    if (type === 'search') return f.filterSearch !== false;
    if (type === 'watch') return f.filterSidebar !== false;
    return true;
  }

  function extractMeta(el) {
    let title = '';
    let channel = '';

    const titleEl =
      el.querySelector('#video-title') ||
      el.querySelector('#video-title-link') ||
      el.querySelector('a#thumbnail') ||
      el.querySelector('h3 a') ||
      el.querySelector('a[title]');

    if (titleEl) {
      title =
        titleEl.getAttribute('title') ||
        titleEl.getAttribute('aria-label') ||
        titleEl.textContent ||
        '';
      // aria-label often like "Video Title by Channel X ..."
      // keep full string; matcher normalizes anyway
    }
    // fallback: element's own aria
    if (!title) title = el.getAttribute('aria-label') || el.textContent.slice(0, 200) || '';

    const chEl =
      el.querySelector('ytd-channel-name #text') ||
      el.querySelector('#channel-name #text') ||
      el.querySelector('#text.ytd-channel-name') ||
      el.querySelector('.ytd-channel-name');
    if (chEl) channel = chEl.textContent || '';

    const link = el.querySelector('a[href*="/shorts/"], a[href*="shorts"]');
    const href = (el.querySelector('a#thumbnail') || el.querySelector('a'))?.getAttribute('href') || '';
    const isShort = !!link || href.startsWith('/shorts/');

    return { title: title.trim(), channel: channel.trim(), isShort };
  }

  function hideEl(el) {
    if (el.dataset.yffHidden === '1') return false;
    el.dataset.yffHidden = '1';
    el.dataset.yffOrigDisplay = el.style.display || '';
    el.style.display = 'none';
    sessionHidden++;
    return true;
  }

  function showEl(el) {
    if (el.dataset.yffHidden !== '1') return;
    delete el.dataset.yffHidden;
    el.style.display = el.dataset.yffOrigDisplay || '';
    delete el.dataset.yffOrigDisplay;
    sessionHidden = Math.max(0, sessionHidden - 1);
  }

  function restoreAll() {
    document.querySelectorAll('[data-yff-hidden="1"]').forEach((el) => {
      el.style.display = el.dataset.yffOrigDisplay || '';
      el.removeAttribute('data-yff-hidden');
      if (el.id === 'yff-shorts-nav-hide') el.removeAttribute('id');
    });
    sessionHidden = 0;
    hiddenThisPage = 0;
    updateBadge();
  }

  function hideShortsChrome() {
    if (!settings.filters?.hideShorts) return;
    // Left nav / mini guide Shorts entries
    const navSelectors = [
      'ytd-guide-entry-renderer',
      'ytd-mini-guide-entry-renderer',
      'a[title="Shorts"]',
      'tp-yt-paper-tab'
    ];
    document.querySelectorAll(navSelectors.join(',')).forEach((el) => {
      const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().toLowerCase();
      const href = (el.querySelector('a')?.getAttribute('href') || el.getAttribute('href') || '').toLowerCase();
      if (t === 'shorts' || href.includes('/shorts')) hideEl(el);
    });
    // Shorts tab in rich grid header / chips
    document.querySelectorAll('yt-chip-cloud-chip-renderer, ytd-feed-filter-chip-bar-renderer *').forEach((el) => {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t === 'shorts') hideEl(el.closest('yt-chip-cloud-chip-renderer') || el);
    });
  }

  function filterPass() {
    if (!settings.enabled) {
      restoreAll();
      removeBadge();
      return;
    }

    const type = pageType();

    // If directly on a /shorts/ page and hideShorts is on -> redirect notice is handled by badge only;
    // we don't navigate away, just show badge. (Blocking navigation feels hostile for v1.)
    let countHiddenNow = 0;

    const shouldFilterVideos =
      (type === 'home' && surfaceEnabled('home')) ||
      (type === 'search' && surfaceEnabled('search')) ||
      (type === 'watch' && surfaceEnabled('watch')) ||
      (type === 'other' && true);

    // 1. Shorts shelves (always removed when hideShorts on, regardless of relevance)
    if (settings.filters?.hideShorts) {
      document.querySelectorAll(SHELF_SHORTS_SELECTORS).forEach((shelf) => {
        const text = (shelf.getAttribute('aria-label') || shelf.textContent || '').toLowerCase();
        const hasShortsLink = !!shelf.querySelector('a[href*="/shorts/"]');
        if (text.includes('short') || hasShortsLink || shelf.tagName.toLowerCase() === 'ytd-reel-shelf-renderer') {
          if (hideEl(shelf)) countHiddenNow++;
        }
      });
      hideShortsChrome();
    }

    // 2. Individual videos
    if (shouldFilterVideos) {
      document.querySelectorAll(VIDEO_SELECTORS).forEach((el) => {
        // skip nested duplicates: only handle outermost video renderer
        if (el.querySelector(':scope ' + 'ytd-rich-item-renderer')) return;
        const meta = extractMeta(el);

        // blanket shorts removal wins over relevance
        if (meta.isShort && settings.filters?.hideShorts) {
          if (hideEl(el)) countHiddenNow++;
          return;
        }

        const ok = isRelevant(meta.title, meta.channel, allowlist);
        if (!ok) {
          if (hideEl(el)) countHiddenNow++;
        } else {
          showEl(el);
        }
      });
    } else {
      // surface disabled -> unhide videos belonging to that surface
      document.querySelectorAll(VIDEO_SELECTORS).forEach(showEl);
    }

    hiddenThisPage = document.querySelectorAll('[data-yff-hidden="1"]').length;
    updateBadge();
    scheduleStatsFlush();
  }

  function scheduleFilter() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(filterPass, 250);
  }

  // --- Badge ---
  function ensureBadge() {
    let b = document.getElementById('yff-badge');
    if (b) return b;
    b = document.createElement('div');
    b.id = 'yff-badge';
    b.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:2147483647;' +
      'background:#0f0f0f;color:#fff;font:12px/1.4 system-ui,Arial;' +
      'padding:8px 12px;border-radius:999px;border:1px solid #3f3f3f;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.4);cursor:default;opacity:.95;';
    document.documentElement.appendChild(b);
    return b;
  }

  function updateBadge() {
    if (!settings.enabled) {
      removeBadge();
      return;
    }
    const topics = allowlist.slice(0, 3).join(', ') || 'no focus set (allowing all)';
    const text = `🎯 Focus ON • ${hiddenThisPage} hidden • ${topics}`;
    // Skip the write when nothing changed: assigning textContent ALWAYS mutates
    // the DOM, which would re-trigger our own MutationObserver and cause an
    // endless filter → badge → filter loop (feed flicker).
    if (text === updateBadge._last) return;
    updateBadge._last = text;
    const b = ensureBadge();
    b.textContent = text;
    b.title = 'YouTube Focus Filter is active. Click extension icon to pause or edit focus.';
  }

  function removeBadge() {
    document.getElementById('yff-badge')?.remove();
  }

  // --- Stats ---
  function scheduleStatsFlush() {
    clearTimeout(statsFlushTimer);
    statsFlushTimer = setTimeout(flushStats, 1500);
  }

  async function flushStats() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const d = await chrome.storage.local.get({ stats: null });
      const st = d.stats || { hiddenTotal: 0, hiddenToday: 0, date: today };
      if (st.date !== today) {
        st.hiddenToday = 0;
        st.date = today;
      }
      // sessionHidden is cumulative since load; attribute count is source of truth per pass.
      // We increment totals by delta since last flush.
      const totalNow = document.querySelectorAll('[data-yff-hidden="1"]').length;
      const last = flushStats._last || 0;
      const delta = Math.max(0, totalNow - last);
      flushStats._last = totalNow;
      if (delta > 0) {
        st.hiddenTotal = (st.hiddenTotal || 0) + delta;
        st.hiddenToday = (st.hiddenToday || 0) + delta;
        await chrome.storage.local.set({ stats: st });
      }
    } catch (e) {}
  }

  // --- Init ---
  async function init() {
    await loadSettings();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.freshStartId) {
        applyFreshStart();
        return;
      }
      let needsReload = false;
      for (const k of ['enabled', 'focusKeywords', 'autoDetect', 'recentQueries', 'filters']) {
        if (changes[k]) needsReload = true;
      }
      if (needsReload) {
        loadSettings().then(() => {
          if (!settings.enabled) {
            restoreAll();
            removeBadge();
          } else {
            flushStats._last = 0;
            filterPass();
          }
        });
      }
    });

    // Single-instance guard: background may re-inject this script into a tab
    // that already runs it (stale-tab recovery). Two live instances = two
    // observers + two badge writers fighting over the same feed (flicker).
    try {
      const prev = window.__yff;
      if (prev) {
        try { prev.obs?.disconnect(); } catch (e) {}
        if (prev.urlTimer) clearInterval(prev.urlTimer);
      }
    } catch (e) {}

    const obs = new MutationObserver((muts) => {
      // Ignore mutations caused by our own badge – otherwise every filter pass
      // schedules another one and the feed never settles.
      let relevant = false;
      for (const m of muts) {
        const node = m.target;
        const el = node && node.nodeType === 1 ? node : node?.parentElement;
        if (el?.closest?.('#yff-badge')) continue;
        relevant = true;
        break;
      }
      if (relevant) scheduleFilter();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // Fresh-start pushed from background (activation flush) – works even if
    // the storage event races the message.
    // DIAG: sidebar "Diagnose" button asks what this tab actually sees.
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && msg.type === 'FRESH_START_APPLIED') {
          // Async: wipe storage, re-filter, report counts back for the sidebar.
          applyFreshStart()
            .then((wiped) => sendResponse({ ok: true, ...wiped }))
            .catch((e) => sendResponse({ ok: false, error: String(e).slice(0, 120) }));
          return true;
        }
        if (msg && msg.type === 'DIAG') {
          try {
            const vids = document.querySelectorAll(VIDEO_SELECTORS);
            const sample = [];
            vids.forEach((el) => {
              if (sample.length >= 3) return;
              const m = extractMeta(el);
              if (m.title) sample.push(((m.channel ? m.channel + ' — ' : '') + m.title).slice(0, 90));
            });
            let localKeys = -1;
            let sessionKeys = -1;
            try { localKeys = localStorage.length; } catch (e) {}
            try { sessionKeys = sessionStorage.length; } catch (e) {}
            sendResponse({
              ok: true,
              pageType: pageType(),
              enabled: !!settings.enabled,
              allowlistSize: allowlist.length,
              allowlistPreview: allowlist.slice(0, 5),
              videoCount: vids.length,
              hiddenCount: document.querySelectorAll('[data-yff-hidden="1"]').length,
              badgePresent: !!document.getElementById('yff-badge'),
              storageKeys: { local: localKeys, session: sessionKeys },
              sample
            });
          } catch (e) {
            sendResponse({ ok: false, error: String(e) });
          }
          return true;
        }
        return false;
      });
    } catch (e) {}

    // YouTube SPA navigation
    window.addEventListener('yt-navigate-finish', () => {
      flushStats._last = 0;
      scheduleFilter();
    });
    // fallback for pushState navigations
    let lastUrl = location.href;
    const urlTimer = setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        scheduleFilter();
      }
    }, 1000);
    // publish handles so a re-injected copy can tear down this instance
    try { window.__yff = { obs, urlTimer }; } catch (e) {}

    filterPass();
    // re-run a few times for late-loading grids
    setTimeout(filterPass, 1500);
    setTimeout(filterPass, 3500);
  }

  init();
})();
