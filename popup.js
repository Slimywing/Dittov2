// glossary is stored as an object after load: { "Term": { def, whyThisMatters } }
// glossary.json on disk may be an array [{term, definition, whyThisMatters}]
// or an object {"Term": {def, ...}} — normalizeGlossary handles both.
let glossary = {};

function normalizeGlossary(raw) {
  if (Array.isArray(raw)) {
    const obj = {};
    raw.forEach(item => {
      const term = (item.term || "").trim();
      const def  = item.definition || item.def || "";
      const why  = item.whyThisMatters || "";
      if (term && def) obj[term] = { def, whyThisMatters: why };
    });
    return obj;
  }
  const obj = {};
  Object.entries(raw).forEach(([term, val]) => {
    const def = typeof val === "string" ? val : (val.def || val.definition || "");
    const why = (val && val.whyThisMatters) || "";
    if (term.trim() && def) obj[term.trim()] = { def, whyThisMatters: why };
  });
  return obj;
}

const FINANCE_SITES = [
  "finance.yahoo.com", "bloomberg.com", "marketwatch.com", "cnbc.com",
  "investing.com", "seekingalpha.com", "morningstar.com", "wsj.com",
  "reuters.com", "fool.com", "barrons.com", "ft.com", "benzinga.com",
  "stockanalysis.com", "macrotrends.net", "finviz.com", "tradingview.com",
  "robinhood.com", "etrade.com", "fidelity.com", "schwab.com",
  "vanguard.com", "nasdaq.com", "nyse.com", "sec.gov", "federalreserve.gov"
];

fetch(chrome.runtime.getURL("glossary.json"))
  .then((res) => res.json())
  .then((raw) => {
    glossary = normalizeGlossary(raw);
    updateStats();
    showDefault();
  });

// Tab switching
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// Stats
function updateStats() {
  document.getElementById("totalTerms").textContent = Object.keys(glossary).length;
  chrome.storage.local.get(["invested_lookups"], (r) => {
    const counts = r.invested_lookups || {};
    const total  = Object.values(counts).reduce((a, b) => a + (b.count || b), 0);
    const unique = Object.keys(counts).length;
    document.getElementById("lookupCount").textContent = total  || 0;
    document.getElementById("uniqueTerms").textContent = unique || 0;
  });
}

// Site toggle
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (!tabs[0]) return;
  try {
    const url       = new URL(tabs[0].url);
    const hostname  = url.hostname;
    const isFinance = FINANCE_SITES.some(s => hostname.includes(s));
    const badge     = document.getElementById("siteBadge");
    const toggle    = document.getElementById("siteToggle");

    badge.textContent = isFinance ? "Finance site" : "Other site";
    badge.className   = "site-badge " + (isFinance ? "finance" : "other");

    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => localStorage.getItem("invested_enabled")
    }, (results) => {
      const stored = results?.[0]?.result;
      toggle.checked = (stored !== null && stored !== undefined) ? stored === "true" : isFinance;
    });

    toggle.addEventListener("change", () => {
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: (val) => localStorage.setItem("invested_enabled", val),
        args: [toggle.checked ? "true" : "false"]
      });
    });
  } catch (_) {}
});

// Glossary search
function showDefault() {
  const items = Object.entries(glossary).slice(0, 5).map(([term, val]) => ({
    term,
    def: val.def,
    why: val.whyThisMatters || ""
  }));
  renderResults(items);
}

function renderResults(items) {
  const container = document.getElementById("results");
  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = '<div class="no-results">No terms found. Try a different word.</div>';
    return;
  }

  items.forEach(function({ term, def, why }) {
    const item = document.createElement("div");
    item.className = "result-item";

    const termEl = document.createElement("div");
    termEl.className = "result-term";
    termEl.textContent = term;

    const defEl = document.createElement("div");
    defEl.className = "result-def";
    defEl.textContent = def;

    item.appendChild(termEl);
    item.appendChild(defEl);

    if (why) {
      const whyToggle = document.createElement("div");
      whyToggle.className = "why-toggle";
      whyToggle.innerHTML = '<span class="why-arrow">\u25be</span> Why this matters';

      const whyBody = document.createElement("div");
      whyBody.className = "why-body";
      whyBody.textContent = why;

      whyToggle.addEventListener("click", function(e) {
        e.stopPropagation();
        const isOpen = whyBody.classList.toggle("open");
        whyToggle.querySelector(".why-arrow").textContent = isOpen ? "\u25b4" : "\u25be";
      });

      item.appendChild(whyToggle);
      item.appendChild(whyBody);
    }

    container.appendChild(item);
  });
}

document.getElementById("searchInput").addEventListener("input", function(e) {
  const query = e.target.value.trim().toLowerCase();
  if (!query) { showDefault(); return; }

  const matches = Object.entries(glossary)
    .filter(function([term, val]) {
      return term.toLowerCase().includes(query) || val.def.toLowerCase().includes(query);
    })
    .slice(0, 8)
    .map(function([term, val]) {
      return { term, def: val.def, why: val.whyThisMatters || "" };
    });

  renderResults(matches);
});