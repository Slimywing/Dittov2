/**
 * InvestEd — Content Script (rebuilt for deterministic matching)
 *
 * PIPELINE:
 *   1. Load glossary.json → sorted term list (longest first)
 *   2. Build Aho-Corasick automaton once
 *   3. TreeWalker collects visible text nodes
 *   4. Each text node: normalize → search → annotate directly
 *      (no virtual string, no cross-node offset remap)
 *   5. Poll until content stabilizes (handles SPA lazy loading)
 *   6. MutationObserver re-scans dynamically added subtrees
 *   7. URL watcher handles SPA navigation
 */
(function () {
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — NORMALIZATION
//
// Applied identically to glossary terms AND page text so they always match.
// Key decision: "/" and "&" → space (not hyphen).
//   "P/E" → "p e",  "R&D" → "r d"
// This keeps word boundaries clean and avoids mismatches from hyphen vs space.
// ─────────────────────────────────────────────────────────────────────────────

function normalize(raw) {
  return raw
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")   // curly apostrophes
    .replace(/[\u2013\u2014\u2012]/g, ' ')          // en/em dash → space
    .replace(/[\/&]/g, ' ')                          // slash/ampersand → space
    .replace(/[^a-z0-9'\s]/g, ' ')                  // strip everything else
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — GLOSSARY
// Builds a lookup sorted longest-first so the automaton always
// prefers "weighted average cost of capital" over "cost of capital".
// ─────────────────────────────────────────────────────────────────────────────

function buildGlossary(raw) {
  const byCanonical = new Map();
  const entries = [];

  for (const [display, val] of Object.entries(raw)) {
    const def = typeof val === 'string' ? val
      : (val && typeof val.def === 'string' ? val.def : '');
    if (!def || !display.trim()) continue;

    const canonical = normalize(display);
    if (!canonical || canonical.length < 2) continue;
    if (byCanonical.has(canonical)) continue;

    const why = (val && typeof val.whyThisMatters === 'string') ? val.whyThisMatters : '';
    const entry = { display: display.trim(), canonical, def, why };
    entries.push(entry);
    byCanonical.set(canonical, entry);
  }

  // LONGEST FIRST — multi-word phrases beat shorter sub-phrases
  entries.sort((a, b) => b.canonical.length - a.canonical.length);
  console.log('[Ditto] Glossary:', entries.length, 'terms');
  return { entries, byCanonical };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — AHO-CORASICK AUTOMATON
// Single linear scan finds all terms simultaneously.
// Built once on startup, reused forever.
// ─────────────────────────────────────────────────────────────────────────────

function buildAutomaton(entries) {
  const nodes = [{ ch: new Map(), fail: 0, out: null, outLink: null }];

  // Insert patterns into trie
  for (const { canonical } of entries) {
    let cur = 0;
    for (const c of canonical) {
      if (!nodes[cur].ch.has(c)) {
        nodes[cur].ch.set(c, nodes.length);
        nodes.push({ ch: new Map(), fail: 0, out: null, outLink: null });
      }
      cur = nodes[cur].ch.get(c);
    }
    if (nodes[cur].out === null) nodes[cur].out = canonical;
  }

  // BFS: compute failure and output links
  const q = [];
  for (const [, ci] of nodes[0].ch) { nodes[ci].fail = 0; q.push(ci); }
  for (let h = 0; h < q.length; h++) {
    const u = q[h];
    for (const [c, v] of nodes[u].ch) {
      let f = nodes[u].fail;
      while (f !== 0 && !nodes[f].ch.has(c)) f = nodes[f].fail;
      const ft = nodes[f].ch.get(c);
      nodes[v].fail = (ft !== undefined && ft !== v) ? ft : 0;
      const fn = nodes[nodes[v].fail];
      nodes[v].outLink = fn.out !== null ? nodes[v].fail : fn.outLink;
      q.push(v);
    }
  }

  console.log('[Ditto] Automaton:', nodes.length, 'states');

  return {
    search(text) {
      const raw = [];
      let cur = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        while (cur !== 0 && !nodes[cur].ch.has(c)) cur = nodes[cur].fail;
        cur = nodes[cur].ch.get(c) ?? 0;
        let e = cur;
        while (e) {
          if (nodes[e].out) {
            raw.push({ start: i - nodes[e].out.length + 1, end: i + 1, canonical: nodes[e].out });
          }
          e = nodes[e].outLink;
        }
      }
      return raw;
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — MATCH RESOLUTION
// Word-boundary check + longest-match-wins greedy selection.
// ─────────────────────────────────────────────────────────────────────────────

function isBoundary(text, pos) {
  if (pos <= 0 || pos >= text.length) return true;
  const before = text[pos - 1], at = text[pos];
  return !/[a-z0-9']/.test(before) || !/[a-z0-9']/.test(at);
}

function resolveMatches(raw, normText, byCanonical) {
  // Word boundaries required
  const filtered = raw.filter(m => isBoundary(normText, m.start) && isBoundary(normText, m.end));

  // Longest first, then earliest
  filtered.sort((a, b) => {
    const d = (b.end - b.start) - (a.end - a.start);
    return d !== 0 ? d : a.start - b.start;
  });

  const occupied = new Uint8Array(normText.length);
  const accepted = [];
  for (const m of filtered) {
    let clash = false;
    for (let i = m.start; i < m.end; i++) if (occupied[i]) { clash = true; break; }
    if (clash) continue;
    const entry = byCanonical.get(m.canonical);
    if (!entry) continue;
    for (let i = m.start; i < m.end; i++) occupied[i] = 1;
    accepted.push({ start: m.start, end: m.end, entry });
  }
  return accepted.sort((a, b) => a.start - b.start);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — OFFSET MAP
// Converts normalized-string positions back to original-string positions.
// Built fresh for each text node — no cross-node complexity.
// ─────────────────────────────────────────────────────────────────────────────

function buildOffsetMap(original) {
  // Simulate normalize() character-by-character to track alignment.
  const lower = original.toLowerCase();
  let normStr = '';
  const normToOrig = []; // normToOrig[normPos] = origPos
  let prevSpace = true;  // treat start as "after space" to handle leading trim

  for (let i = 0; i < lower.length; i++) {
    let ch = lower[i];

    // Mirror the substitutions in normalize():
    if ('\u2018\u2019\u201A\u201B'.includes(ch)) ch = "'";
    else if ('\u2013\u2014\u2012'.includes(ch)) ch = ' ';
    else if (ch === '/' || ch === '&') ch = ' ';
    else if (!/[a-z0-9'\s]/.test(ch)) ch = ' ';

    if (ch === ' ') {
      if (!prevSpace) {
        normStr += ' ';
        normToOrig.push(i);
        prevSpace = true;
      }
    } else {
      normStr += ch;
      normToOrig.push(i);
      prevSpace = false;
    }
  }
  // Trim trailing space
  if (normStr.endsWith(' ')) { normStr = normStr.slice(0, -1); normToOrig.pop(); }

  return { normStr, normToOrig };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — ANNOTATION
// Splits and wraps text nodes directly. Right-to-left order so earlier
// splits don't shift the offsets of matches further left in the same node.
// ─────────────────────────────────────────────────────────────────────────────

const ATTR_TERM    = 'data-invested-term';
const ATTR_DEF     = 'data-invested-def';
const ATTR_WHY     = 'data-invested-why';
const ATTR_SCANNED = 'data-invested-scanned';

function makeSpan(entry) {
  const s = document.createElement('span');
  s.setAttribute(ATTR_TERM, entry.display);
  s.setAttribute(ATTR_DEF,  entry.def);
  if (entry.why) s.setAttribute(ATTR_WHY, entry.why);
  s.className = 'invested-term';
  return s;
}

function annotateNode(textNode, matches, normToOrig) {
  // Process right-to-left to preserve left-side offsets after each split
  for (let mi = matches.length - 1; mi >= 0; mi--) {
    const { start: ns, end: ne, entry } = matches[mi];
    if (!textNode.isConnected || textNode.nodeType !== Node.TEXT_NODE) break;

    // Map normalized offsets → original string offsets
    const origStart = normToOrig[ns];
    const origEnd   = ne - 1 < normToOrig.length
      ? normToOrig[ne - 1] + 1
      : textNode.textContent.length;

    if (origStart >= origEnd || origEnd > textNode.textContent.length) continue;

    try {
      // Split tail first (keeps origStart valid)
      if (origEnd < textNode.textContent.length) textNode.splitText(origEnd);

      // Split head — matchNode is now just the phrase text
      let matchNode = textNode;
      if (origStart > 0) matchNode = textNode.splitText(origStart);

      // Wrap
      const span = makeSpan(entry);
      matchNode.parentNode.insertBefore(span, matchNode);
      span.appendChild(matchNode);

      console.log('[Ditto] Annotating:', entry.display);
    } catch (err) {
      // Rare: node mutated between collect and annotate — skip this match
      console.warn('[Ditto] Annotation skipped:', entry.display, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — DOM SCANNING
// TreeWalker visits every visible text node. Each node processed independently.
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set([
  'SCRIPT','STYLE','NOSCRIPT','TEXTAREA','INPUT','SELECT',
  'CODE','PRE','SVG','CANVAS','IFRAME','MATH','BUTTON',
]);

const BLOCK_TAGS = new Set([
  'P','DIV','SECTION','ARTICLE','ASIDE','MAIN','HEADER','FOOTER',
  'NAV','LI','TD','TH','H1','H2','H3','H4','H5','H6',
  'BLOCKQUOTE','FIGCAPTION','CAPTION','DT','DD','LABEL','SUMMARY',
]);

function getBlock(node) {
  let el = node.parentElement;
  while (el && el !== document.body) {
    if (BLOCK_TAGS.has(el.tagName)) return el;
    el = el.parentElement;
  }
  return document.body;
}

function inSkipZone(node) {
  let el = node.parentElement;
  while (el && el !== document.documentElement) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.getAttribute && el.getAttribute(ATTR_TERM) !== null) return true;
    if (el.isContentEditable) return true;
    el = el.parentElement;
  }
  return false;
}

/**
 * Scan a subtree and annotate all glossary terms found.
 *
 * markScanned=false (poll phase):  never stamps data-invested-scanned on block
 *   parents. Each poll tick needs to re-visit freely so that content that
 *   arrives between ticks is never missed. Double-annotation is prevented at
 *   the text-node level by inSkipZone() — any text node already inside one
 *   of our <span data-invested-term> elements is rejected by the TreeWalker.
 *
 * markScanned=true (MO phase):  stamps data-invested-scanned after processing
 *   so the MutationObserver doesn't re-scan stable blocks on every minor DOM
 *   tweak. The MO itself clears the stamp from any block whose content changes.
 */
function scanSubtree(root, automaton, byCanonical, markScanned) {
  if (!root || !root.isConnected) return;
  console.log('[Ditto] Scanning page', markScanned ? '(MO phase)' : '(poll phase)');

  // --- Collect text nodes WITHOUT mutating the DOM yet ---
  const nodes = [];
  const walker = document.createTreeWalker(
    root, NodeFilter.SHOW_TEXT,
    {
      acceptNode(n) {
        if (!n.textContent || n.textContent.trim().length < 2) return NodeFilter.FILTER_REJECT;
        // Always skip text already inside our own annotated spans
        if (inSkipZone(n)) return NodeFilter.FILTER_REJECT;
        // In MO phase only: skip block parents already fully processed
        if (markScanned) {
          const bp = getBlock(n);
          if (bp !== document.body && bp.hasAttribute(ATTR_SCANNED)) return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  // --- Annotate ---
  for (const textNode of nodes) {
    if (!textNode.isConnected || textNode.nodeType !== Node.TEXT_NODE) continue;
    if (inSkipZone(textNode)) continue; // re-check: prior iterations may have wrapped siblings

    const original = textNode.textContent;
    if (!original.trim()) continue;

    const { normStr, normToOrig } = buildOffsetMap(original);
    if (!normStr) continue;

    const raw = automaton.search(normStr);
    if (!raw.length) continue;

    const resolved = resolveMatches(raw, normStr, byCanonical);
    if (!resolved.length) continue;

    console.log('[Ditto] Term detected:', resolved.map(m => m.entry.display).join(', '));
    annotateNode(textNode, resolved, normToOrig);
  }

  // --- Stamp block parents (MO phase only) ---
  if (markScanned) {
    const seen = new Set();
    const w2 = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let n2;
    while ((n2 = w2.nextNode())) {
      const bp = getBlock(n2);
      if (bp !== document.body && !seen.has(bp)) {
        seen.add(bp);
        try { bp.setAttribute(ATTR_SCANNED, '1'); } catch (_) {}
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — ENGINE ORCHESTRATION
// Poll-until-stable handles SPA lazy loading. MutationObserver handles
// content injected after stabilization. URL watcher handles navigation.
// ─────────────────────────────────────────────────────────────────────────────

function startEngine(automaton, byCanonical) {
  let lastLen = -1, stable = 0, moStarted = false;
  const NEED = 3, DELAY = 600;
  let pollTimer = null;

  function isEnabled() {
    try { const v = localStorage.getItem('invested_enabled'); return v !== null ? v === 'true' : true; }
    catch (_) { return true; }
  }

  // poll phase: markScanned=false so every tick can freely re-visit any block
  function scan(root) {
    if (isEnabled()) scanSubtree(root || document.body, automaton, byCanonical, false);
  }

  // MO phase: markScanned=true so stable blocks aren't re-walked on every minor DOM event
  function scanMO(root) {
    if (isEnabled()) scanSubtree(root || document.body, automaton, byCanonical, true);
  }

  function poll() {
    const len = document.body ? document.body.innerText.length : 0;
    scan(document.body);
    if (len === lastLen) { stable++; } else { stable = 0; lastLen = len; }
    if (stable < NEED) {
      pollTimer = setTimeout(poll, DELAY);
    } else if (!moStarted) {
      moStarted = true;
      // Run one final scan in MO phase to stamp all block parents before handing off
      scanMO(document.body);
      startMO();
    }
  }

  function startMO() {
    if (!document.body) return;
    let debounce = null;
    const pending = new Set();

    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const added of m.addedNodes) {
          if (added.nodeType !== Node.ELEMENT_NODE) continue;
          if (added.hasAttribute && added.hasAttribute('data-invested-term')) continue;
          if ((added.textContent || '').length < 5) continue;

          // Clear ATTR_SCANNED from this node and ALL its block-parent ancestors
          // unconditionally. We cannot tell whether the new content contains terms
          // that weren't there before, so we always re-scan.
          // Double-annotation is safe: inSkipZone() inside scanSubtree rejects
          // text nodes that are already inside invested-term spans.
          try {
            // Clear the added node itself
            if (added.hasAttribute(ATTR_SCANNED)) added.removeAttribute(ATTR_SCANNED);
            // Clear any scanned descendants
            added.querySelectorAll('[' + ATTR_SCANNED + ']').forEach(el => {
              el.removeAttribute(ATTR_SCANNED);
            });
            // Also clear scanned flags on block-parent ancestors of added node
            // (e.g. a TD that wraps a span that was just replaced)
            let ancestor = added.parentElement;
            while (ancestor && ancestor !== document.body) {
              if (ancestor.hasAttribute(ATTR_SCANNED)) ancestor.removeAttribute(ATTR_SCANNED);
              ancestor = ancestor.parentElement;
            }
          } catch (_) {}

          pending.add(added);
        }
      }
      if (!pending.size) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        pending.forEach(node => { if (node.isConnected) scanMO(node); });
        pending.clear();
      }, 250);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // SPA navigation — URL polling
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    document.querySelectorAll('[' + ATTR_SCANNED + ']').forEach(el => el.removeAttribute(ATTR_SCANNED));
    stable = 0; lastLen = -1; moStarted = false;
    clearTimeout(pollTimer);
    setTimeout(poll, 800);
  }, 500);

  poll();
}


// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — TOOLTIP
// Hover model: tooltip stays open while cursor is over EITHER the highlighted
// term OR the tooltip itself. Only hides when both are left (220ms debounce).
// pointer-events:auto lets tooltip receive mouse events so clicks work.
// ─────────────────────────────────────────────────────────────────────────────

function initTooltip() {
  if (!document.body) { document.addEventListener('DOMContentLoaded', initTooltip); return; }
  if (document.getElementById('invested-tooltip')) return;

  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Sora:wght@700;800&family=DM+Sans:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap');
    span.invested-term {
      display:inline !important;
      text-decoration:none !important;
      border-bottom:2.5px solid #FBBF24 !important;
      cursor:help !important;
      color:inherit !important; font-style:inherit !important;
      font-weight:inherit !important; background:transparent !important;
      padding:0 1px 1px !important; margin:0 !important;
      box-shadow:none !important;
      transition:all .15s ease !important;
    }
    span.invested-term:hover {
      background:rgba(124,58,237,0.08) !important;
      border-bottom-color:#7C3AED !important;
      border-radius:3px !important;
      color:#7C3AED !important;
    }
    #invested-tooltip {
      pointer-events:auto;
      transition:opacity .15s ease, transform .15s ease;
    }
    #invested-tooltip.ie-vis { opacity:1 !important; transform:translateY(0) !important; }
    #ie-accent { height:3px; background:linear-gradient(90deg,#7C3AED,#a78bfa); border-radius:14px 14px 0 0; }
    #ie-badge  {
      display:flex; align-items:center; justify-content:space-between;
      padding:10px 16px 0;
    }
    #ie-badge-label {
      font-family:'Space Mono',monospace; font-size:9px; font-weight:700;
      letter-spacing:1.2px; text-transform:uppercase; color:#7C3AED; opacity:.7;
    }
    #ie-badge-logo {
      font-family:'Sora',sans-serif; font-weight:800; font-size:13px; color:#111;
    }
    #ie-badge-logo .ie-dot { color:#7C3AED; }
    #ie-term   { font-family:'Sora',sans-serif; font-weight:700; font-size:15px; padding:8px 16px 2px; color:#111; }
    #ie-def    { font-family:'DM Sans',sans-serif; font-size:13px; color:#888; line-height:1.65; padding:4px 16px 10px; }
    #ie-why-toggle {
      display:none; align-items:center; gap:6px;
      font-family:'DM Sans',sans-serif;
      font-size:11px; font-weight:600; letter-spacing:0.2px; color:#7C3AED;
      cursor:pointer; user-select:none;
      padding:8px 16px; border-top:1px solid #E8E8E8;
    }
    #ie-why-toggle:hover { background:rgba(124,58,237,0.04); }
    #ie-why-arrow { font-size:10px; transition:transform .15s; display:inline-block; }
    #ie-why-body {
      display:none; font-family:'DM Sans',sans-serif;
      font-size:12.5px; color:#111; line-height:1.6;
      background:#FFFBEB; border-left:3px solid #FBBF24;
      margin:0 12px 12px; padding:10px 12px; border-radius:0 8px 8px 0;
    }
    #ie-why-body.ie-open { display:block; }
  `;
  document.head.appendChild(style);

  const tip = document.createElement('div');
  tip.id = 'invested-tooltip';
  tip.style.cssText = 'position:fixed;display:none;opacity:0;z-index:2147483647;background:#fff;'
    + 'color:#111;border-radius:14px;padding:0;max-width:380px;min-width:260px;'
    + 'box-shadow:0 8px 32px rgba(0,0,0,.10),0 0 0 1px rgba(232,232,232,.9);'
    + 'font-family:"DM Sans",-apple-system,BlinkMacSystemFont,sans-serif;transform:translateY(4px);';
  tip.innerHTML = '<div id="ie-accent"></div>'
    + '<div id="ie-badge"><span id="ie-badge-label">Definition</span><span id="ie-badge-logo">d<span class="ie-dot">.</span></span></div>'
    + '<div id="ie-term"></div>'
    + '<div id="ie-def"></div>'
    + '<div id="ie-why-toggle"><span id="ie-why-arrow">&#9660;</span>Why this matters</div>'
    + '<div id="ie-why-body"></div>';
  document.body.appendChild(tip);

  const whyToggle = document.getElementById('ie-why-toggle');
  const whyBody   = document.getElementById('ie-why-body');
  const whyArrow  = document.getElementById('ie-why-arrow');
  const termEl    = document.getElementById('ie-term');
  const defEl     = document.getElementById('ie-def');

  whyToggle.addEventListener('click', function(evt) {
    evt.stopPropagation();
    evt.preventDefault();
    var open = whyBody.classList.toggle('ie-open');
    whyArrow.style.transform = open ? 'rotate(180deg)' : '';
  });

  // ── State ──
  var overSpan  = false;
  var overTip   = false;
  var activeSpan = null;
  var hideTimer = null;
  var showTimer = null;
  var visible = false;

  // ── Helper: find the invested-term span from any node (including text nodes) ──
  function findSpan(node) {
    if (!node) return null;
    // Text nodes don't have closest(), walk up to parent element first
    var el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el) return null;
    // Check if this element IS the span or is inside one
    if (el.classList && el.classList.contains('invested-term')) return el;
    return el.closest ? el.closest('span.invested-term') : null;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function() {
      if (!overSpan && !overTip) forceHide();
    }, 220);
  }

  function forceHide() {
    visible = false;
    activeSpan = null;
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    tip.classList.remove('ie-vis');
    // Single timeout to set display:none after opacity transition
    setTimeout(function() {
      if (!visible) tip.style.display = 'none';
    }, 160);
  }

  function showTooltip(term, def, why, anchorX, anchorY) {
    clearTimeout(hideTimer);
    visible = true;

    termEl.textContent = term;
    defEl.textContent  = def;

    if (why) {
      whyBody.textContent = why;
      whyToggle.style.display = 'flex';
      whyBody.classList.remove('ie-open');
      whyArrow.style.transform = '';
    } else {
      whyToggle.style.display = 'none';
      whyBody.classList.remove('ie-open');
    }

    tip.style.display = 'block';
    tip.classList.remove('ie-vis');

    // Position: prefer below-right of anchor, flip if overflowing
    var GAP = 10;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var tw = tip.offsetWidth || 300;
    var th = tip.offsetHeight || 120;
    var left = anchorX;
    var top  = anchorY + GAP;

    // Flip horizontal if overflows right
    if (left + tw + GAP > vw) left = anchorX - tw;
    // Flip vertical if overflows bottom
    if (top + th + GAP > vh) top = anchorY - th - GAP;
    // Clamp to viewport
    left = Math.max(GAP, Math.min(left, vw - tw - GAP));
    top  = Math.max(GAP, Math.min(top, vh - th - GAP));

    tip.style.left = left + 'px';
    tip.style.top  = top + 'px';

    // Trigger fade-in on next frame
    requestAnimationFrame(function() {
      if (visible) tip.classList.add('ie-vis');
    });

    // Track lookup
    try { chrome.runtime.sendMessage({ type: 'invested_hover', term: term, def: def }); } catch (_) {}
    try {
      chrome.storage.local.get(['invested_lookups', 'invested_streak'], function(r) {
        var c = r.invested_lookups || {};
        var now = Date.now();
        var ex = c[term];
        c[term] = ex ? { count: ex.count + 1, firstSeen: ex.firstSeen, lastSeen: now }
                     : { count: 1, firstSeen: now, lastSeen: now };

        var today = new Date().toISOString().slice(0, 10);
        var streak = r.invested_streak || { count: 0, totalDays: 0, lastDate: null };
        if (streak.lastDate !== today) {
          var yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          var yesterdayStr = yesterday.toISOString().slice(0, 10);
          streak.count = (streak.lastDate === yesterdayStr) ? (streak.count || 0) + 1 : 1;
          streak.totalDays = (streak.totalDays || 0) + 1;
          streak.lastDate = today;
        }

        chrome.storage.local.set({ invested_lookups: c, invested_streak: streak });
      });
    } catch (_) {}
  }

  // ── Event delegation: mouseover on any invested-term span ──
  document.addEventListener('mouseover', function(e) {
    var span = findSpan(e.target);
    if (!span) return;

    overSpan = true;
    clearTimeout(hideTimer);

    // Only trigger show if this is a different span than what's currently active
    if (span === activeSpan && visible) return;

    // Cancel any pending show from a previous span
    clearTimeout(showTimer);
    activeSpan = span;

    // Small delay to avoid flicker on fast mouse movement
    showTimer = setTimeout(function() {
      // Verify span is still the one we're hovering
      if (activeSpan !== span || !overSpan) return;

      var term = span.getAttribute(ATTR_TERM) || '';
      var def  = span.getAttribute(ATTR_DEF)  || '';
      var why  = span.getAttribute(ATTR_WHY)  || '';

      if (!term || !def) return;

      var rect = span.getBoundingClientRect();
      showTooltip(term, def, why, rect.left + rect.width / 2, rect.bottom);
    }, 120);
  }, true);

  // ── Event delegation: mouseout from invested-term spans ──
  document.addEventListener('mouseout', function(e) {
    var span = findSpan(e.target);
    if (!span) {
      // If we were over a span but mouseout target isn't one,
      // check if we're leaving the active span's area
      if (overSpan && activeSpan) {
        var related = findSpan(e.relatedTarget);
        if (related === activeSpan) return; // still inside same span
        overSpan = false;
        scheduleHide();
      }
      return;
    }

    // Check if cursor moved to a child within the same span — ignore
    if (e.relatedTarget) {
      var relatedSpan = findSpan(e.relatedTarget);
      if (relatedSpan === span) return;
    }

    overSpan = false;
    scheduleHide();
  }, true);

  // ── Tooltip itself keeps alive while hovered ──
  tip.addEventListener('mouseenter', function() {
    overTip = true;
    clearTimeout(hideTimer);
  });

  tip.addEventListener('mouseleave', function() {
    overTip = false;
    scheduleHide();
  });

  // ── Scroll/resize dismiss immediately ──
  document.addEventListener('scroll', function() {
    overSpan = false;
    overTip = false;
    forceHide();
  }, { passive: true, capture: true });

  window.addEventListener('resize', function() {
    overSpan = false;
    overTip = false;
    forceHide();
  }, { passive: true });

  // ── Click outside dismisses ──
  document.addEventListener('mousedown', function(e) {
    if (visible && !tip.contains(e.target) && !findSpan(e.target)) {
      overSpan = false;
      overTip = false;
      forceHide();
    }
  }, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────

(function bootstrap() {
  if (window !== window.top) return;
  if (location.protocol === 'chrome-extension:' || location.protocol === 'about:') return;

  initTooltip(); // starts immediately — uses event delegation, doesn't need glossary

  fetch(chrome.runtime.getURL('glossary.json'))
    .then(r => { if (!r.ok) throw new Error('glossary ' + r.status); return r.json(); })
    .then(raw => {
      const { entries, byCanonical } = buildGlossary(raw);
      const automaton = buildAutomaton(entries);
      startEngine(automaton, byCanonical);
    })
    .catch(err => console.warn('[Ditto] Init failed:', err));
})();

})(); // end InvestEd bundle