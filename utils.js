/* Shared matching logic – loaded in both popup and content script (no modules, MV3-safe). */

function normalizeText(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseKeywords(raw) {
  // Accept comma- or newline-separated. Returns array of normalized phrases.
  if (Array.isArray(raw)) raw = raw.join(',');
  const parts = String(raw || '').split(/[\n,]+/);
  const out = [];
  for (const p of parts) {
    const n = normalizeText(p);
    if (n.length >= 2) out.push(n);
  }
  return [...new Set(out)];
}

function buildAllowlist(focusKeywords, recentQueries, autoDetect) {
  const manual = parseKeywords(focusKeywords);
  let auto = [];
  if (autoDetect) auto = parseKeywords(recentQueries || []);
  // Keep auto list short: last 5 queries only, each max 60 chars
  auto = auto.slice(-5);
  return [...new Set([...manual, ...auto])];
}

function isRelevant(title, channel, allowlist) {
  if (!allowlist || allowlist.length === 0) return true; // no focus set -> allow all
  const hay = normalizeText((title || '') + ' ' + (channel || ''));
  if (!hay) return false;
  const padded = ' ' + hay + ' ';
  for (const phrase of allowlist) {
    if (!phrase) continue;
    if (phrase.includes(' ')) {
      // multi-word: allow if full phrase OR all words present
      if (hay.includes(phrase)) return true;
      const words = phrase.split(' ').filter((w) => w.length >= 3);
      if (words.length >= 2 && words.every((w) => hay.includes(w))) return true;
    } else if (/[^\x00-\x7F]/.test(phrase)) {
      // non-ASCII single token (e.g. CJK has no word spaces): substring match
      if (hay.includes(phrase)) return true;
    } else if (padded.includes(' ' + phrase + ' ')) {
      // whole-word match: "rag" must not match "Raghav"
      return true;
    } else if (phrase.length >= 5 && hay.includes(phrase)) {
      // longer tokens may still match inside words ("python" in "python3")
      return true;
    }
  }
  return false;
}
