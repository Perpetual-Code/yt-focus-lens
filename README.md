# Blinders for YouTube

> GitHub: https://github.com/Perpetual-Code/yt-focus-lens

A Manifest V3 Chrome extension that keeps YouTube on-topic while you study. Set focus keywords and it hides everything else — Home feed, Search results, Watch sidebar — plus full Shorts removal. 100% local, no AI, no tracking.

## Why

YouTube's recommendations are built to pull you off-task. When you're studying one topic, the feed fills with unrelated videos, Shorts, and rabbit holes. Blinders puts blinders on your feed: only videos matching your focus stay visible.

## Features

- **Strict allowlist filtering** — only videos matching your focus keywords stay visible; everything else is hidden with a live counter (`🎯 Focus ON • N hidden`)
- **Hybrid focus input** — manual keywords plus auto-detected recent YouTube searches
- **Custom per-surface toggles** — filter Home, Search results, and Watch sidebar independently
- **Complete Shorts removal** — feed items, shelves, sidebar entries, and nav tabs
- **Master ON/OFF toggle** — turning OFF instantly restores YouTube untouched
- **Start-fresh flush** — activating clears old extension state, `youtube.com` browser-history entries, and YouTube site keys, then rebuilds purely from your topics
- **🔍 Diagnose filter** — one-click report of what the filter sees on each open tab (page type, allowlist, videos found vs hidden)
- **Sidebar + popup UI** — toolbar click opens a side panel (Chrome 114+); popup remains as fallback

## Install (developer mode)

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select the `youtube-focus-filter/` folder
3. Pin the extension, then **reload every open YouTube tab** (tabs opened before install run no content script until reloaded)
4. Click the toolbar icon to open the sidebar and set focus keywords, e.g. `python async, calculus`

> After any extension update or permission change, hit **Reload** on `chrome://extensions` and reload your YouTube tabs again — stale tabs run old code (Manifest V3 gotcha the sidebar's Diagnose button will call out).

## Usage

1. Add 1–5 focus phrases in the sidebar
2. Toggle which surfaces to filter (Home / Search / Sidebar) and Shorts removal
3. Browse YouTube — off-topic tiles disappear, badge shows hidden count
4. Turning the master toggle OFF restores everything instantly

**Quick sanity test:** set a nonsense keyword like `xyzqwerty123` — a working filter hides nearly everything. Then set your real topic.

## Honest limitations

- **Keyword matching only** (substring on title + channel). No semantic/AI matching — a related video with none of your keywords in its title will be hidden.
- **YouTube account watch history is server-side.** The flush clears this browser's history and site data, but `youtube.com/feed/history` (which drives recommendations on other devices) can only be cleared by you on YouTube itself — the sidebar has a `🔥 Clear YouTube account history…` button that opens that page.
- **YouTube DOM changes** may require selector updates in `content.js` (`VIDEO_SELECTORS`).

## Permissions (and why)

| Permission | Used for |
|---|---|
| `storage` | Focus keywords, toggles, stats — local only |
| `tabs` | Notify open YouTube tabs on flush / diagnose |
| `sidePanel` | Toolbar-click sidebar UI |
| `history` | Delete `youtube.com` entries on Start-fresh (explicit user action only) |
| `scripting` | Re-inject content script into tabs opened before an update |
| `*://*.youtube.com/*` | Content filtering on YouTube pages |

No network calls. No analytics. No data leaves the browser.

## Project structure

```
youtube-focus-filter/
├── manifest.json    # MV3 manifest, icons, side panel
├── utils.js         # shared keyword normalize + match logic
├── content.js       # DOM filtering, badge, site-key wipe, diagnostics
├── background.js    # search capture, history purge, tab messaging
├── sidepanel.html / .css / .js   # primary UI
├── popup.html / .css / .js       # fallback UI (older Chrome)
└── icons/           # icon16/32/48/128.png + icon.svg source
```

## Roadmap ideas

- Block-page interstitial for off-topic watch/Shorts opens
- Focus timer lock (Pomodoro-style)
- Channel blocklist alongside keyword allowlist

## License

MIT — do what you want, no warranty.
