/* global mermaid */

const ANTHROPIC_ENDPOINT = "/api/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";

const SYSTEM_PROMPT =
  "You are a Mermaid.js diagram expert. Return ONLY valid Mermaid diagram code with no explanation, no backticks, no markdown fences.\n\nRequired layout:\n- For flowcharts, ALWAYS start with: flowchart TD\n- Prefer vertical, top-down structure.\n\nReadability rules:\n- Keep node labels short and readable.\n- If a label is long, split it with \\n line breaks.\n- Avoid wide fan-out. Prefer 1–2 outgoing edges per node.\n- Reduce crossings by grouping related steps into subgraphs and using clear stages.\n- Keep the diagram compact; avoid unnecessary nodes.\n";

const TAGS = [
  { id: "flowchart", label: "Flowchart", hint: "flowchart" },
  { id: "sequence", label: "Sequence", hint: "sequence diagram" },
  { id: "class", label: "Class", hint: "class diagram" },
  { id: "er", label: "Entity Relationship", hint: "ER diagram" },
  { id: "state", label: "State", hint: "state diagram" },
  { id: "gantt", label: "Gantt", hint: "gantt chart" },
  { id: "mindmap", label: "Mindmap", hint: "mindmap" },
  { id: "journey", label: "User Journey", hint: "user journey" },
  { id: "requirement", label: "Requirement", hint: "requirement diagram" },
  { id: "architecture", label: "Architecture", hint: "architecture diagram" },
  { id: "block", label: "Block", hint: "block diagram" },
  { id: "timeline", label: "Timeline", hint: "timeline" },
  { id: "pie", label: "Pie", hint: "pie chart" },
  { id: "quadrant", label: "Quadrant", hint: "quadrant chart" },
];

const el = {
  form: document.getElementById("promptForm"),
  input: document.getElementById("promptInput"),
  btnGenerate: document.getElementById("btnGenerate"),
  btnSetKey: document.getElementById("btnSetKey"),
  btnClearHistory: document.getElementById("btnClearHistory"),
  btnBackToTop: document.getElementById("backToTop"),
  tagList: document.getElementById("tagList"),
  loading: document.getElementById("loading"),
  error: document.getElementById("errorBox"),
  status: document.getElementById("statusPill"),
  history: document.getElementById("diagramHistory"),
  historyEmpty: document.getElementById("historyEmpty"),
  historyCount: document.getElementById("historyCount"),
  lightbox: document.getElementById("imageLightbox"),
  lightboxClose: document.getElementById("imageLightboxClose"),
  lightboxBackdrop: document.getElementById("imageLightboxBackdrop"),
  lightboxImg: document.getElementById("imageLightboxImg"),
  lightboxCaption: document.getElementById("imageLightboxCaption"),
};

// Diagram history: ordered list of card metadata.
// Each card: { id, depth, title, parentLabel, parentCardId, timestamp, mermaidCode, element, selectedNode, relatedImages }
const history = [];
let cardCounter = 0;

// MVP: static/local image mapping by keyword. This is intentionally a plain
// object so it can later be swapped for an async "image providers" pipeline.
// Paths assume a static server that serves `/images/*` (e.g. `public/images`).
const imageMap = {
  "tune radio": [{ label: "Radio panel example", url: "/images/radio_panel.jpg" }],
  "radio knob": [{ label: "Radio knob", url: "/images/radio_knob.png" }],
  "adjust antenna": [{ label: "Antenna tuner", url: "/images/antenna.png" }],
  antenna: [{ label: "Antenna hardware", url: "/images/antenna_hardware.jpg" }],
  "landing gear lever": [{ label: "Landing gear lever", url: "/images/landing_gear_lever.jpg" }],
  "landing gear": [{ label: "Landing gear control panel", url: "/images/landing_gear_panel.jpg" }],
};

// Wikimedia Commons fallback (client-side; CORS via `origin=*`).
const WIKIMEDIA_COMMONS_ENDPOINT = "https://commons.wikimedia.org/w/api.php";
const COMMONS_MAX_IMAGES = 4;
const COMMONS_THUMB_WIDTH = 420;
const commonsCache = new Map(); // key(normalized label) -> images[]
const commonsInFlight = new Map(); // key -> Promise<images[]>

function getApiKey() {
  if (typeof window !== "undefined" && window.ANTHROPIC_API_KEY) return String(window.ANTHROPIC_API_KEY).trim();
  try {
    const v = localStorage.getItem("ANTHROPIC_API_KEY");
    if (v) return v.trim();
  } catch {
    // ignore
  }
  return "";
}

function setApiKeyInteractive() {
  const current = getApiKey();
  const v = window.prompt(
    "Optional: paste your Anthropic API key (stored locally in this browser).\n\nRecommended: set ANTHROPIC_API_KEY on the server and run `node server.js`.",
    current || "",
  );
  if (v == null) return;
  const trimmed = String(v).trim();
  try {
    if (trimmed) localStorage.setItem("ANTHROPIC_API_KEY", trimmed);
    else localStorage.removeItem("ANTHROPIC_API_KEY");
  } catch {
    // ignore
  }
}

function setStatus(kind, text) {
  el.status.textContent = text;
  el.status.classList.remove("pill--idle", "pill--loading", "pill--ok", "pill--error");
  el.status.classList.add(kind);
}

function setLoading(on) {
  el.loading.classList.toggle("hidden", !on);
  el.btnGenerate.disabled = on;
  el.input.disabled = on;
  if (on) setStatus("pill--loading", "Loading");
}

function showError(message) {
  el.error.textContent = message;
  el.error.classList.remove("hidden");
  setStatus("pill--error", "Error");
}

function clearError() {
  el.error.classList.add("hidden");
  el.error.textContent = "";
}

function normalizeMermaid(raw) {
  const s = String(raw || "").replace(/\r\n/g, "\n").trim();
  const noFences = s
    .replace(/^```[a-zA-Z]*\n/, "")
    .replace(/\n```$/, "")
    .trim();
  // Force top-down for flowcharts/graphs when the model returns LR/RL/BT/TB or no direction.
  // Other diagram types are left untouched.
  const forced = noFences
    .replace(/^(flowchart)\s+(LR|RL|BT|TB|TD)\b/im, "flowchart TD")
    .replace(/^(graph)\s+(LR|RL|BT|TB|TD)\b/im, "graph TD")
    .replace(/^(flowchart)\s*$/im, "flowchart TD")
    .replace(/^(graph)\s*$/im, "graph TD");
  return forced.trim();
}

function getNodeLabel(nodeEl) {
  const texts = [];
  nodeEl.querySelectorAll("text").forEach((t) => {
    const v = (t.textContent || "").trim();
    if (v) texts.push(v);
  });
  if (texts.length) return texts.join(" ").replace(/\s+/g, " ").trim();

  const fo = nodeEl.querySelector("foreignObject");
  if (fo) {
    const v = (fo.textContent || "").trim();
    if (v) return v.replace(/\s+/g, " ").trim();
  }

  const v = (nodeEl.textContent || "").trim();
  return v.replace(/\s+/g, " ").trim();
}

function highlightSelectedNode(rootEl, nodeEl) {
  rootEl.querySelectorAll(".node.is-selected").forEach((n) => n.classList.remove("is-selected"));
  if (nodeEl) nodeEl.classList.add("is-selected");
}

function formatTime(d) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function truncate(s, n) {
  const v = String(s || "");
  return v.length > n ? v.slice(0, n - 1) + "…" : v;
}

function normalizeForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[_\-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const COMMONS_WEAK_WORDS = new Set([
  "a",
  "an",
  "and",
  "or",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "from",
  "by",
  "via",
  "into",
  "over",
  "under",
  "about",
  // user action / generic workflow words
  "check",
  "verify",
  "adjust",
  "configure",
  "system",
  "issue",
  "problem",
  "phase",
  "step",
  "process",
  "procedure",
  "troubleshoot",
  "troubleshooting",
  "fix",
  "repair",
  "inspect",
  "test",
  "ensure",
  // ultra-generic words that pollute image search
  "part",
  "parts",
  "thing",
  "things",
  "item",
  "items",
]);

const COMMONS_DOMAIN_WORDS = new Set([
  "radio",
  "electronics",
  "electronic",
  "aircraft",
  "aviation",
  "helicopter",
  "engine",
  "computer",
  "network",
  "avionics",
  "mechanical",
  "hydraulic",
  "electrical",
]);

const COMMONS_TECH_BOOST_WORDS = new Set([
  "schematic",
  "schematics",
  "diagram",
  "circuit",
  "circuitry",
  "pcb",
  "board",
  "component",
  "components",
  "hardware",
  "device",
  "equipment",
  "power",
  "battery",
  "plug",
  "connector",
  "switch",
  "knob",
  "lever",
  "panel",
  "antenna",
  "transceiver",
  "receiver",
  "transmitter",
  "power-supply",
  "supply",
  "voltage",
  "current",
  "avionics",
  "cockpit",
  "landing",
  "gear",
]);

const COMMONS_AVOID_WORDS = new Set([
  "history",
  "art",
  "museum",
  "painting",
  "landscape",
  "nature",
  "people",
  "person",
  "war",
  "battle",
  "soldier",
  "portrait",
  "city",
  "church",
  "statue",
  "flag",
  "animal",
  "flower",
  "tree",
]);

function tokenizeKeywords(s) {
  const v = normalizeForMatch(s);
  if (!v) return [];
  const parts = v.split(" ").filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p.length <= 2) continue;
    if (COMMONS_WEAK_WORDS.has(p)) continue;
    out.push(p);
  }
  return out;
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const v of arr || []) {
    const k = String(v || "").trim();
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function uniqueImages(images) {
  const out = [];
  const seen = new Set();
  for (const img of images || []) {
    if (!img || !img.url) continue;
    const key = `${img.url}::${img.fullUrl || ""}::${img.label || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: img.label || "", url: img.url, fullUrl: img.fullUrl || img.url, source: img.source || "" });
  }
  return out;
}

function getRelatedImagesForLabel(label) {
  const q = normalizeForMatch(label);
  if (!q) return [];

  const hits = [];
  for (const [rawKey, images] of Object.entries(imageMap)) {
    const k = normalizeForMatch(rawKey);
    if (!k) continue;
    if (q === k || q.includes(k) || k.includes(q)) {
      hits.push(...(Array.isArray(images) ? images : []));
    }
  }
  return uniqueImages(hits);
}

function ensureCardImagesUi(card) {
  const media = card.element.querySelector(".diagramCard__media");
  if (media) return media;
  return null;
}

function setCardImagesStatus(card, kind, text) {
  const media = ensureCardImagesUi(card);
  if (!media) return;
  const statusEl = media.querySelector(".diagramCard__imagesStatus");
  if (!statusEl) return;
  statusEl.classList.toggle("hidden", !text);
  statusEl.classList.toggle("is-loading", kind === "loading");
  statusEl.classList.toggle("is-error", kind === "error");
  statusEl.textContent = text || "";
}

function getLocalImagesForLabel(card, nodeLabel) {
  const fromCard = Array.isArray(card.relatedImages) ? card.relatedImages : [];
  const fromMap = getRelatedImagesForLabel(nodeLabel);
  return uniqueImages([...fromCard, ...fromMap]);
}

function renderCardImages(card, nodeLabel) {
  const media = ensureCardImagesUi(card);
  if (!media) return;

  const imagesEl = media.querySelector(".diagramCard__images");
  const titleEl = media.querySelector(".diagramCard__mediaTitle");
  const emptyEl = media.querySelector(".diagramCard__imagesEmpty");
  const statusEl = media.querySelector(".diagramCard__imagesStatus");
  if (!imagesEl || !titleEl || !emptyEl || !statusEl) return;

  const localImages = getLocalImagesForLabel(card, nodeLabel);
  const commonsImages = Array.isArray(card.commonsImages) ? card.commonsImages : [];
  const images = uniqueImages([...localImages, ...commonsImages]).slice(0, COMMONS_MAX_IMAGES);

  titleEl.textContent = nodeLabel ? `Image References — ${truncate(nodeLabel, 42)}` : "Image References";
  imagesEl.innerHTML = "";

  if (!images.length) {
    emptyEl.classList.remove("hidden");
    if (!nodeLabel) emptyEl.textContent = "Select a node to see contextual images.";
    else if (card.commonsTried) emptyEl.textContent = "No highly relevant technical references found.";
    else emptyEl.textContent = "No related images found.";
    return;
  }

  emptyEl.classList.add("hidden");
  for (const img of images) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "diagramCard__imageBtn";
    btn.title = img.label || "Open image";
    btn.setAttribute("aria-label", img.label || "Open image");

    const elImg = document.createElement("img");
    elImg.className = "diagramCard__image";
    elImg.src = img.url;
    elImg.alt = img.label || (nodeLabel ? `Reference image for ${nodeLabel}` : "Reference image");
    elImg.loading = "lazy";
    elImg.decoding = "async";

    const cap = document.createElement("div");
    cap.className = "diagramCard__imageLabel";
    cap.textContent = img.label || "";

    btn.appendChild(elImg);
    if (img.label) btn.appendChild(cap);
    btn.addEventListener("click", () => openImageLightbox(img.fullUrl || img.url, img.label || ""));
    imagesEl.appendChild(btn);
  }
}

function getContextTokensForCard(card, nodeLabel) {
  const path = typeof getAncestorPath === "function" ? getAncestorPath(card) : [card];
  const root = path && path.length ? path[0] : card;

  const tokens = [];
  // Root topic (often the initial prompt)
  tokens.push(...tokenizeKeywords(root?.title || ""));
  // Parent chain labels/titles
  for (const c of path || []) tokens.push(...tokenizeKeywords(c?.title || ""));
  // Clicked node label
  tokens.push(...tokenizeKeywords(nodeLabel || ""));

  const uniqTokens = uniq(tokens);
  return { rootTokens: uniq(tokenizeKeywords(root?.title || "")), tokens: uniqTokens };
}

function domainBoostersFromRoot(rootTokens) {
  const set = new Set(rootTokens || []);
  const out = [];
  const add = (w) => {
    if (!w) return;
    if (set.has(w)) return;
    out.push(w);
    set.add(w);
  };

  // If the root indicates a domain, append supporting context keywords.
  if (rootTokens.some((t) => t === "radio" || t === "avionics")) {
    add("radio");
    add("electronics");
    add("electrical");
  }
  if (rootTokens.some((t) => t === "electronics" || t === "electronic")) {
    add("electronics");
    add("hardware");
    add("circuit");
  }
  if (rootTokens.some((t) => t === "aircraft" || t === "aviation" || t === "cockpit")) {
    add("aircraft");
    add("aviation");
    add("cockpit");
    add("avionics");
  }
  if (rootTokens.some((t) => t === "helicopter")) {
    add("helicopter");
    add("aviation");
  }
  if (rootTokens.some((t) => t === "engine")) {
    add("engine");
    add("mechanical");
  }
  if (rootTokens.some((t) => t === "computer" || t === "network")) {
    add("computer");
    add("network");
    add("hardware");
  }

  return uniq(out);
}

function buildCommonsQueryFromContext(contextTokens, boosters) {
  const base = uniq([...(contextTokens || []), ...(boosters || [])]).filter(Boolean);
  // Keep queries compact to avoid overly broad search.
  const trimmed = base.slice(0, 10);
  return trimmed.join(" ").trim();
}

function scoreCommonsCandidate({ title, snippet, categories }, contextTokens) {
  const ctx = new Set(contextTokens || []);
  const txt = `${title || ""} ${snippet || ""} ${(categories || []).join(" ")}`;
  const tokens = tokenizeKeywords(txt);
  let score = 0;
  let overlap = 0;
  for (const t of tokens) {
    if (ctx.has(t)) overlap += 1;
    if (COMMONS_TECH_BOOST_WORDS.has(t)) score += 2;
    if (COMMONS_AVOID_WORDS.has(t)) score -= 4;
    if (COMMONS_DOMAIN_WORDS.has(t)) score += 1;
  }
  // Overlap is the main signal.
  score += overlap * 3;
  // Light penalty if the title/snippet looks unrelated.
  if (overlap === 0) score -= 3;
  return score;
}

function mapCommonsImageInfoToImage(nodeLabel, title, ii) {
  if (!ii) return null;
  const mime = String(ii.mime || "").toLowerCase();
  const isSupported =
    mime === "image/jpeg" || mime === "image/jpg" || mime === "image/png" || mime === "image/svg+xml";
  if (!isSupported) return null;

  const thumbUrl = ii.thumburl || ii.url;
  const fullUrl = ii.url || ii.thumburl;
  if (!thumbUrl || !fullUrl) return null;

  const cleanTitle = String(title || "").replace(/^File:/i, "").replace(/_/g, " ").trim();
  const label = cleanTitle || nodeLabel || "Wikimedia Commons";
  return { label, url: thumbUrl, fullUrl, source: "commons" };
}

async function fetchCommonsImagesForContext({ cacheKey, nodeLabel, contextTokens, boosters }) {
  const key = normalizeForMatch(cacheKey);
  if (!key) return [];
  if (commonsCache.has(key)) return commonsCache.get(key) || [];
  if (commonsInFlight.has(key)) return commonsInFlight.get(key);

  const promise = (async () => {
    const query = buildCommonsQueryFromContext(contextTokens, boosters);
    if (!query) return [];

    // Step 1: search for files (namespace=6)
    const searchUrl =
      `${WIKIMEDIA_COMMONS_ENDPOINT}?action=query&format=json&origin=*` +
      `&list=search&srnamespace=6&srlimit=${encodeURIComponent(String(12))}` +
      `&srsearch=${encodeURIComponent(query)}`;
    const searchRes = await fetch(searchUrl, { method: "GET" });
    if (!searchRes.ok) throw new Error(`Wikimedia search failed (${searchRes.status})`);
    const searchJson = await searchRes.json();
    const hits = Array.isArray(searchJson?.query?.search) ? searchJson.query.search : [];
    const candidates = hits
      .map((h) => ({
        title: String(h?.title || "").trim(),
        snippet: String(h?.snippet || "").replace(/<[^>]+>/g, " ").trim(),
      }))
      .filter((h) => h.title);
    if (!candidates.length) return [];

    // Step 2: fetch thumbnails + full urls + categories (for relevance scoring)
    const titles = candidates.map((c) => c.title).slice(0, 12);

    const infoUrl =
      `${WIKIMEDIA_COMMONS_ENDPOINT}?action=query&format=json&origin=*` +
      `&prop=imageinfo|categories&iiprop=url|mime&iiurlwidth=${encodeURIComponent(String(COMMONS_THUMB_WIDTH))}` +
      `&cllimit=20&clshow=!hidden` +
      `&titles=${encodeURIComponent(titles.join("|"))}`;
    const infoRes = await fetch(infoUrl, { method: "GET" });
    if (!infoRes.ok) throw new Error(`Wikimedia imageinfo failed (${infoRes.status})`);
    const infoJson = await infoRes.json();
    const pages = infoJson?.query?.pages || {};

    const scored = [];
    for (const c of candidates) {
      const page = Object.values(pages).find((p) => String(p?.title || "") === c.title);
      const ii = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
      const cats = Array.isArray(page?.categories)
        ? page.categories.map((x) => String(x?.title || "").replace(/^Category:/i, "").replace(/_/g, " ").trim()).filter(Boolean)
        : [];
      const score = scoreCommonsCandidate({ title: c.title, snippet: c.snippet, categories: cats }, contextTokens);
      const mapped = mapCommonsImageInfoToImage(nodeLabel, c.title, ii);
      if (!mapped) continue;
      scored.push({ score, img: mapped });
    }

    scored.sort((a, b) => b.score - a.score);
    const THRESHOLD = 5;
    const filtered = scored.filter((s) => s.score >= THRESHOLD).slice(0, COMMONS_MAX_IMAGES).map((s) => s.img);
    return uniqueImages(filtered);
  })();

  commonsInFlight.set(key, promise);
  try {
    const imgs = await promise;
    commonsCache.set(key, imgs);
    return imgs;
  } finally {
    commonsInFlight.delete(key);
  }
}

function maybeFetchCommonsImages(card, nodeLabel) {
  const ctx = getContextTokensForCard(card, nodeLabel);
  const boosters = domainBoostersFromRoot(ctx.rootTokens);
  // Compose a stable cache key from context+node so "plug" doesn't fetch random plugs
  const cacheKey = buildCommonsQueryFromContext(ctx.tokens, boosters);
  const key = normalizeForMatch(cacheKey);
  if (!key) return;

  // Reset Commons state for this card/label.
  card.commonsKey = key;
  card.commonsImages = [];
  card.commonsTried = false;

  const local = getLocalImagesForLabel(card, nodeLabel);
  if (local.length >= COMMONS_MAX_IMAGES) {
    setCardImagesStatus(card, "idle", "");
    renderCardImages(card, nodeLabel);
    return;
  }

  // Cache hit: render immediately.
  if (commonsCache.has(key)) {
    card.commonsImages = commonsCache.get(key) || [];
    card.commonsTried = true;
    setCardImagesStatus(card, "idle", "");
    renderCardImages(card, nodeLabel);
    return;
  }

  // Async fetch: do not block diagram rendering.
  card.commonsFetchSeq = (card.commonsFetchSeq || 0) + 1;
  const seq = card.commonsFetchSeq;
  setCardImagesStatus(card, "loading", "Searching technical references…");
  renderCardImages(card, nodeLabel);

  fetchCommonsImagesForContext({
    cacheKey,
    nodeLabel,
    contextTokens: ctx.tokens,
    boosters,
  })
    .then((imgs) => {
      if (card.commonsFetchSeq !== seq) return; // stale
      if (normalizeForMatch(card.commonsKey || "") !== key) return;
      card.commonsImages = imgs || [];
      card.commonsTried = true;
      setCardImagesStatus(card, "idle", "");
      renderCardImages(card, nodeLabel);
    })
    .catch(() => {
      if (card.commonsFetchSeq !== seq) return;
      if (normalizeForMatch(card.commonsKey || "") !== key) return;
      card.commonsTried = true;
      setCardImagesStatus(card, "idle", "");
      renderCardImages(card, nodeLabel);
    });
}

function openImageLightbox(url, label) {
  if (!el.lightbox || !el.lightboxImg) return;
  el.lightboxImg.src = url;
  el.lightboxImg.alt = label || "Image preview";
  if (el.lightboxCaption) el.lightboxCaption.textContent = label || "";
  el.lightbox.classList.remove("hidden");
  document.documentElement.classList.add("is-modalOpen");
  try {
    el.lightboxClose && el.lightboxClose.focus({ preventScroll: true });
  } catch {
    el.lightboxClose && el.lightboxClose.focus();
  }
}

function closeImageLightbox() {
  if (!el.lightbox || !el.lightboxImg) return;
  el.lightbox.classList.add("hidden");
  document.documentElement.classList.remove("is-modalOpen");
  if (el.lightboxImg) el.lightboxImg.src = "";
  if (el.lightboxCaption) el.lightboxCaption.textContent = "";
}

function updateHistoryUi() {
  el.historyCount.textContent = String(history.length);
  el.historyEmpty.classList.toggle("hidden", history.length > 0);
  el.btnClearHistory.disabled = history.length === 0;
}

async function callClaudeForMermaid(userPrompt) {
  const apiKey = getApiKey();

  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "x-client-key": apiKey } : {}),
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Claude API error (${res.status}). ${text || "No details."}`.trim());
  }

  const data = await res.json();
  const parts = Array.isArray(data?.content) ? data.content : [];
  const text = parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("Empty response from Claude.");
  return text;
}

async function callClaudeForDrilldown(nodeLabel, question, parentDiagramCode) {
  const apiKey = getApiKey();

  const system =
    "You are a Mermaid.js diagram expert. Return ONLY valid Mermaid diagram code with no explanation, no backticks, no markdown fences.\n" +
    "Requirements:\n" +
    "- Always use flowchart TD\n" +
    "- Keep it vertically readable and compact\n" +
    "- Keep labels concise; use \\n line breaks for long labels\n" +
    "- Avoid crossings by using stages/subgraphs where helpful\n";

  const user = [
    "Parent diagram context (Mermaid):",
    parentDiagramCode || "(none)",
    "",
    `Selected step: ${nodeLabel || "(unknown)"}`,
    "",
    question,
  ].join("\n");

  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "x-client-key": apiKey } : {}),
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 700,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Claude API error (${res.status}). ${text || "No details."}`.trim());
  }

  const data = await res.json();
  const parts = Array.isArray(data?.content) ? data.content : [];
  const text = parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("Empty response from Claude.");
  return text;
}

function createCard({ depth, title, parentLabel = "", parentCardId = null }) {
  cardCounter += 1;
  const id = `card-${cardCounter}`;
  const timestamp = new Date();

  const card = document.createElement("article");
  card.className = "diagramCard";
  card.dataset.id = id;
  card.dataset.depth = String(depth);

  const isRoot = !parentCardId;
  const depthLabel = isRoot ? `Root · L${depth}` : `L${depth}`;

  card.innerHTML = `
    <header class="diagramCard__header">
      <div class="diagramCard__topRow">
        <span class="diagramCard__depth">${depthLabel}</span>
        <span class="diagramCard__time" title="${timestamp.toISOString()}">${formatTime(timestamp)}</span>
        <span class="diagramCard__headerSpacer"></span>
        <button class="diagramCard__iconBtn diagramCard__minimize" type="button" title="Collapse / expand" aria-label="Collapse">−</button>
        <button class="diagramCard__iconBtn diagramCard__remove" type="button" title="Remove this diagram" aria-label="Remove">×</button>
      </div>
      <div class="diagramCard__title"></div>
      <div class="diagramCard__breadcrumb"></div>
    </header>

    <div class="diagramCard__body">
      <div class="diagramCard__main">
        <div class="diagramCard__diagramWrap">
          <div class="diagramCard__diagramControls" role="toolbar" aria-label="Zoom controls">
            <button type="button" class="diagramCard__zoomBtn diagramCard__zoomOut" title="Zoom out (Ctrl+−)" aria-label="Zoom out">−</button>
            <span class="diagramCard__zoomLabel">100%</span>
            <button type="button" class="diagramCard__zoomBtn diagramCard__zoomIn" title="Zoom in (Ctrl+=)" aria-label="Zoom in">+</button>
            <button type="button" class="diagramCard__zoomBtn diagramCard__zoomReset" title="Reset zoom" aria-label="Reset zoom">⤢</button>
          </div>
          <div class="diagramCard__diagram" aria-label="Rendered diagram">
            <div class="diagramCard__pan"></div>
          </div>
        </div>

        <div class="diagramCard__media">
          <div class="diagramCard__mediaHeader">
            <div class="diagramCard__mediaTitle">Image References</div>
          </div>
          <div class="diagramCard__imagesStatus hidden" aria-live="polite"></div>
          <div class="diagramCard__imagesEmpty">Select a node to see contextual images.</div>
          <div class="diagramCard__images"></div>
        </div>
      </div>

      <div class="diagramCard__nodeInfo hidden">
        <div class="diagramCard__nodeLabel">
          Selected: <strong class="diagramCard__nodeText"></strong>
        </div>
        <form class="diagramCard__askForm" autocomplete="off">
          <input
            class="diagramCard__askInput"
            type="text"
            placeholder="Ask a question about this node…"
            required
          />
          <button type="submit" class="diagramCard__askBtn">Ask</button>
        </form>
        <div class="diagramCard__drillLoading hidden" aria-live="polite">
          <div class="spinner" aria-hidden="true"></div>
          <div>Thinking…</div>
        </div>
        <div class="diagramCard__drillError hidden" role="alert"></div>
      </div>

      <details class="diagramCard__code">
        <summary class="diagramCard__codeSummary">
          <span>Mermaid code</span>
          <span class="diagramCard__codeHint">expand</span>
        </summary>
        <div class="diagramCard__codeToolbar">
          <button type="button" class="btn diagramCard__copy">Copy</button>
        </div>
        <div class="diagramCard__codeBody">
          <pre class="code__pre"><code class="code__code diagramCard__codeBlock"></code></pre>
        </div>
      </details>
    </div>
  `;

  const finalTitle = title || (isRoot ? "Diagram" : "Sub-diagram");
  card.querySelector(".diagramCard__title").textContent = finalTitle;

  const meta = {
    id,
    depth,
    title: finalTitle,
    parentLabel,
    parentCardId,
    timestamp,
    mermaidCode: "",
    element: card,
    selectedNode: { label: "", el: null },
    relatedImages: [],
    commonsKey: "",
    commonsImages: [],
    commonsFetchSeq: 0,
    commonsTried: false,
    suppressClickUntil: 0,
    viewport: null,
  };

  history.push(meta);
  renderBreadcrumb(meta);

  card.querySelector(".diagramCard__remove").addEventListener("click", () => removeCard(id));
  card.querySelector(".diagramCard__minimize").addEventListener("click", () => toggleCardMinimize(meta));
  card.querySelector(".diagramCard__copy").addEventListener("click", (e) => copyCardCode(meta, e.currentTarget));
  card.querySelector(".diagramCard__askForm").addEventListener("submit", (e) => onAskFromCard(e, meta));

  el.history.appendChild(card);
  updateHistoryUi();

  return meta;
}

function getAncestorPath(card) {
  const path = [];
  let cur = card;
  let guard = 0;
  while (cur && guard++ < 40) {
    path.unshift(cur);
    cur = cur.parentCardId ? history.find((c) => c.id === cur.parentCardId) : null;
  }
  return path;
}

function renderBreadcrumb(card) {
  const wrap = card.element.querySelector(".diagramCard__breadcrumb");
  if (!wrap) return;
  const path = getAncestorPath(card);
  wrap.innerHTML = "";
  path.forEach((node, idx) => {
    if (idx > 0) {
      const sep = document.createElement("span");
      sep.className = "diagramCard__crumbSep";
      sep.textContent = "›";
      wrap.appendChild(sep);
    }
    const isCurrent = node.id === card.id;
    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = "diagramCard__crumb" + (isCurrent ? " diagramCard__crumb--current" : "");
    crumb.textContent = truncate(node.title, 40);
    crumb.title = node.title;
    if (!isCurrent) {
      crumb.addEventListener("click", () => {
        node.element.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } else {
      crumb.disabled = true;
    }
    wrap.appendChild(crumb);
  });
}

function toggleCardMinimize(card) {
  const collapsed = card.element.classList.toggle("is-collapsed");
  const btn = card.element.querySelector(".diagramCard__minimize");
  btn.textContent = collapsed ? "+" : "−";
  btn.title = collapsed ? "Expand" : "Collapse";
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function removeCard(cardId) {
  const idx = history.findIndex((c) => c.id === cardId);
  if (idx < 0) return;
  const card = history[idx];
  teardownZoomPan(card);
  card.element.remove();
  history.splice(idx, 1);
  for (const c of history) renderBreadcrumb(c);
  updateHistoryUi();
}

function clearHistory() {
  for (const card of history.slice()) {
    teardownZoomPan(card);
    card.element.remove();
  }
  history.length = 0;
  updateHistoryUi();
}

async function copyCardCode(card, btn) {
  const v = card.mermaidCode || "";
  if (!v) return;
  const reset = () => {
    btn.textContent = "Copy";
    btn.disabled = false;
  };
  try {
    await navigator.clipboard.writeText(v);
    btn.textContent = "Copied";
    btn.disabled = true;
    window.setTimeout(reset, 900);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = v;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      // ignore
    }
    document.body.removeChild(ta);
    btn.textContent = "Copied";
    btn.disabled = true;
    window.setTimeout(reset, 900);
  }
}

function bindCardNodeClicks(card) {
  const rootEl = card.element.querySelector(".diagramCard__diagram");
  rootEl.querySelectorAll(".node").forEach((node) => {
    node.setAttribute("tabindex", "0");
    node.setAttribute("role", "button");

    const onPick = (ev) => {
      // Ignore click that follows a pan drag.
      if (Date.now() < (card.suppressClickUntil || 0)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const label = getNodeLabel(node);
      if (label) selectCardNode(card, label, node);
    };

    node.addEventListener("click", onPick);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") onPick(e);
    });
  });
}

function suggestedQuestionFor(label) {
  // User-friendly natural-language prefill. No Mermaid rules, syntax
  // constraints, or internal prompt instructions are ever exposed here —
  // all of that lives in callClaudeForDrilldown's `system` field.
  return `Show me a detailed diagram of "${label}"`;
}

function selectCardNode(card, label, nodeEl) {
  card.selectedNode = { label, el: nodeEl };

  const rootEl = card.element.querySelector(".diagramCard__diagram");
  highlightSelectedNode(rootEl, nodeEl);

  setCardImagesStatus(card, "idle", "");
  renderCardImages(card, label); // local images are instant
  maybeFetchCommonsImages(card, label); // Commons fallback is async

  const nodeInfo = card.element.querySelector(".diagramCard__nodeInfo");
  nodeInfo.classList.remove("hidden");

  card.element.querySelector(".diagramCard__nodeText").textContent = label;

  const errEl = card.element.querySelector(".diagramCard__drillError");
  errEl.classList.add("hidden");
  errEl.textContent = "";

  const input = card.element.querySelector(".diagramCard__askInput");
  input.placeholder = `Ask about "${truncate(label, 60)}"…`;
  // Always overwrite with a fresh contextual question. Switching to a new
  // node should obviously change the suggested question — leaving the old
  // node's text in here makes the drill-down feel broken.
  input.value = suggestedQuestionFor(label);

  // Reveal the ask form smoothly if it's currently scrolled out of view.
  // `block: "nearest"` only scrolls when the form isn't already visible.
  nodeInfo.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // `preventScroll: true` keeps the smooth scroll above from being interrupted.
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus();
  }
  // Place the caret at the end so users can keep typing or just press Ask.
  const len = input.value.length;
  if (typeof input.setSelectionRange === "function") {
    input.setSelectionRange(len, len);
  }
}

// Readability-first layout constants. Tall diagrams keep their scale and
// grow the card downward instead of being squished into a fixed viewport.
const READABLE_MIN_SCALE = 0.85;
const READABLE_MAX_SCALE = 1.4;
const DIAGRAM_PAD = 24;
const DIAGRAM_MIN_HEIGHT = 280;
const ZOOM_STEP = 1.2;
const MIN_ZOOM = 0.15; // user multiplier; with initialScale=1.4 → ~21% display
const MAX_ZOOM = 8; // user multiplier; with initialScale=1.4 → ~1120% display

// Mobile/tablet rendering uses a different fit strategy: width-fit the WHOLE
// diagram with no readable-min-scale floor, center on the actual rendered
// bounding box, and use tighter padding. Desktop UX is intentionally untouched.
const MOBILE_BREAKPOINT_PX = 768;
const MOBILE_PAD = 12;
const MOBILE_MIN_HEIGHT = 200;
const MOBILE_MAX_INITIAL_SCALE = 1.2;

function isMobileViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
}

function applyTransform(card) {
  const pan = card.element && card.element.querySelector(".diagramCard__pan");
  if (!pan) return;
  const totalScale = (card.initialScale || 1) * (card.zoom || 1);
  const tx = card.panX || 0;
  const ty = card.panY || 0;
  pan.style.transform = `translate(${tx}px, ${ty}px) scale(${totalScale})`;
  const lbl = card.element.querySelector(".diagramCard__zoomLabel");
  if (lbl) lbl.textContent = `${Math.round(totalScale * 100)}%`;
}

function applyReadableInitialView(card) {
  const viewport = card.element.querySelector(".diagramCard__diagram");
  if (!viewport || !card.viewBoxW || !card.viewBoxH) return;

  const containerW = Math.max(360, viewport.clientWidth || 800);
  const widthFit = (containerW - DIAGRAM_PAD * 2) / card.viewBoxW;
  const initialScale = Math.min(
    READABLE_MAX_SCALE,
    Math.max(READABLE_MIN_SCALE, widthFit),
  );

  card.initialScale = initialScale;
  card.zoom = 1;

  const scaledW = card.viewBoxW * initialScale;
  card.panX = Math.max(DIAGRAM_PAD, (containerW - scaledW) / 2);
  card.panY = DIAGRAM_PAD;

  // Grow the viewport to host the scaled diagram + padding. Tall diagrams
  // extend the card downward so the page (not the diagram) becomes scrollable.
  const scaledH = card.viewBoxH * initialScale;
  viewport.style.height = `${Math.max(DIAGRAM_MIN_HEIGHT, scaledH + DIAGRAM_PAD * 2)}px`;

  applyTransform(card);
}

// Mobile fit. Replaces the readable-first heuristic with a "show the whole
// diagram on screen, centered on its real bounding box" strategy. Keeps the
// same { initialScale, zoom, panX, panY } state shape so manual zoom + drag
// work unchanged after init.
function applyMobileFitView(card) {
  const viewport = card.element.querySelector(".diagramCard__diagram");
  const pan = card.element.querySelector(".diagramCard__pan");
  const svgEl = pan && pan.querySelector("svg");
  if (!viewport || !svgEl || !card.viewBoxW || !card.viewBoxH) return;

  // Use the real viewport width — no desktop floor that would push wide
  // diagrams off the right edge of phones smaller than 360 px.
  const containerW = Math.max(200, viewport.clientWidth || 320);

  // Prefer the rendered content bbox over the declared viewBox: Mermaid
  // sometimes pads the viewBox and that bias is what makes diagrams render
  // partially off-screen on phones. Falls back to viewBox if getBBox fails.
  let contentW = card.viewBoxW;
  let contentH = card.viewBoxH;
  let contentX = 0;
  let contentY = 0;
  try {
    const bbox = svgEl.getBBox();
    if (bbox && bbox.width > 0 && bbox.height > 0) {
      contentW = bbox.width;
      contentH = bbox.height;
      contentX = bbox.x;
      contentY = bbox.y;
    }
  } catch {
    // ignore — fall back to viewBox dims.
  }

  // Width-fit only, no readable-min-scale floor. Slight extra reduction for
  // wide branching diagrams so they don't kiss the edges on phones.
  const widthFit = (containerW - MOBILE_PAD * 2) / contentW;
  const branchPenalty = contentW > 1200 ? 0.92 : contentW > 700 ? 0.96 : 1;
  const initialScale = Math.min(
    MOBILE_MAX_INITIAL_SCALE,
    Math.max(0.05, widthFit * branchPenalty),
  );

  card.initialScale = initialScale;
  card.zoom = 1;
  // Center horizontally on the actual content extent (handles non-zero bbox.x)
  // and top-align with MOBILE_PAD. After scale s and translate (panX, panY),
  // viewBox point (vx, vy) renders at (panX + s*vx, panY + s*vy), so:
  //   center: panX + s*(contentX + contentW/2) = containerW/2
  //   top:    panY + s*contentY              = MOBILE_PAD
  card.panX = containerW / 2 - initialScale * (contentX + contentW / 2);
  card.panY = MOBILE_PAD - initialScale * contentY;

  const scaledContentH = contentH * initialScale;
  viewport.style.height = `${Math.max(MOBILE_MIN_HEIGHT, scaledContentH + MOBILE_PAD * 2)}px`;

  applyTransform(card);
}

// Dispatch to the right initial-view strategy. Desktop path is left exactly
// as it was; mobile gets the dedicated viewport-fit pass.
function applyInitialView(card) {
  if (isMobileViewport()) applyMobileFitView(card);
  else applyReadableInitialView(card);
}

function setupZoomPan(card) {
  const viewport = card.element.querySelector(".diagramCard__diagram");
  const pan = card.element.querySelector(".diagramCard__pan");
  const svgEl = pan && pan.querySelector("svg");
  const btnIn = card.element.querySelector(".diagramCard__zoomIn");
  const btnOut = card.element.querySelector(".diagramCard__zoomOut");
  const btnReset = card.element.querySelector(".diagramCard__zoomReset");
  if (!svgEl || !viewport || !pan) return;

  // Read the diagram's natural drawing dimensions from Mermaid's viewBox.
  const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
  const vbW = (vb && vb.width) || 800;
  const vbH = (vb && vb.height) || 600;
  card.viewBoxW = vbW;
  card.viewBoxH = vbH;

  // Render the SVG at its natural pixel size. CSS transform on the pan layer
  // is the single source of truth for visible scale and pan offset.
  svgEl.setAttribute("width", String(vbW));
  svgEl.setAttribute("height", String(vbH));
  svgEl.style.width = `${vbW}px`;
  svgEl.style.height = `${vbH}px`;
  svgEl.style.maxWidth = "none";
  svgEl.style.display = "block";
  svgEl.removeAttribute("preserveAspectRatio");

  pan.style.transformOrigin = "0 0";
  pan.style.willChange = "transform";

  applyInitialView(card);

  // Zoom around an arbitrary point (kept stationary in viewport coords).
  const setZoomAround = (newZoom, cx, cy) => {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    if (clamped === card.zoom) return;
    const r = clamped / card.zoom;
    if (cx != null && cy != null) {
      const rect = viewport.getBoundingClientRect();
      const px = cx - rect.left;
      const py = cy - rect.top;
      // Keep (px, py) in viewport space stationary across the scale change.
      card.panX = card.panX * r + px * (1 - r);
      card.panY = card.panY * r + py * (1 - r);
    }
    card.zoom = clamped;
    applyTransform(card);
  };
  const zoomFromCenter = (factor) => {
    const rect = viewport.getBoundingClientRect();
    setZoomAround(card.zoom * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  };

  if (btnIn) btnIn.addEventListener("click", () => zoomFromCenter(ZOOM_STEP));
  if (btnOut) btnOut.addEventListener("click", () => zoomFromCenter(1 / ZOOM_STEP));
  if (btnReset) btnReset.addEventListener("click", () => applyInitialView(card));

  // Wheel zoom — Ctrl/Meta required so plain wheel still scrolls the page.
  const onWheel = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoomAround(card.zoom * factor, e.clientX, e.clientY);
  };
  viewport.addEventListener("wheel", onWheel, { passive: false });
  card._onWheel = onWheel;

  // Drag-to-pan. Movement >4 px sets `suppressClickUntil` so the post-drag
  // click on a node is ignored.
  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    // Only preventDefault on background drags to keep node focus working.
    if (!e.target.closest || !e.target.closest(".node")) e.preventDefault();
    let lastX = e.clientX;
    let lastY = e.clientY;
    let moved = 0;
    viewport.classList.add("is-panning");
    const onMove = (ev) => {
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      card.panX += dx;
      card.panY += dy;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 4) card.suppressClickUntil = Date.now() + 200;
      applyTransform(card);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      viewport.classList.remove("is-panning");
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };
  viewport.addEventListener("mousedown", onMouseDown);
  card._onMouseDown = onMouseDown;

  // Mobile-only resize / orientation handler. On rotation or browser-chrome
  // changes, re-fit the diagram so it never ends up off-screen. Desktop is
  // left untouched per spec; if the user crosses back from mobile->desktop
  // we hand off to the desktop fit once so the card isn't stuck in mobile pose.
  let resizeRaf = 0;
  let lastWasMobile = isMobileViewport();
  const onResize = () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      const nowMobile = isMobileViewport();
      if (nowMobile) {
        applyMobileFitView(card);
      } else if (lastWasMobile) {
        applyReadableInitialView(card);
      }
      lastWasMobile = nowMobile;
    });
  };
  window.addEventListener("resize", onResize);
  card._onResize = onResize;
}

function teardownZoomPan(card) {
  const viewport = card.element && card.element.querySelector(".diagramCard__diagram");
  if (viewport) {
    if (card._onWheel) viewport.removeEventListener("wheel", card._onWheel);
    if (card._onMouseDown) viewport.removeEventListener("mousedown", card._onMouseDown);
  }
  if (card._onResize) {
    window.removeEventListener("resize", card._onResize);
    card._onResize = null;
  }
  card._onWheel = null;
  card._onMouseDown = null;
}

async function renderCardDiagram(card, code) {
  const clean = normalizeMermaid(code);
  card.mermaidCode = clean;

  const codeBlock = card.element.querySelector(".diagramCard__codeBlock");
  codeBlock.textContent = clean;

  // If we're re-rendering, tear down any existing pan/zoom instance first.
  teardownZoomPan(card);

  const pan = card.element.querySelector(".diagramCard__pan");
  pan.innerHTML = "";
  const renderId = `mmd-${card.id}-${Math.random().toString(16).slice(2)}`;

  try {
    const { svg } = await mermaid.render(renderId, clean);
    pan.innerHTML = svg;
    bindCardNodeClicks(card);
    setCardImagesStatus(card, "idle", "");
    renderCardImages(card, card.selectedNode?.label || "");
    if (card.selectedNode?.label) maybeFetchCommonsImages(card, card.selectedNode.label);
    // Defer pan/zoom init by a frame so the SVG is in the DOM and laid out.
    requestAnimationFrame(() => setupZoomPan(card));
  } catch (e) {
    pan.innerHTML = `<div style="padding:12px;color:#b42318;font-size:13px;">
      Mermaid render error. Check the code below.
    </div>`;
    throw new Error(`Mermaid render error: ${e?.message || String(e)}`);
  }
}

async function onAskFromCard(e, card) {
  e.preventDefault();

  const askInput = card.element.querySelector(".diagramCard__askInput");
  const errorEl = card.element.querySelector(".diagramCard__drillError");
  const loadingEl = card.element.querySelector(".diagramCard__drillLoading");
  const submitBtn = card.element.querySelector(".diagramCard__askBtn");

  errorEl.classList.add("hidden");
  errorEl.textContent = "";

  const question = (askInput.value || "").trim();
  if (!card.selectedNode.label) {
    errorEl.textContent = "Click a node in this diagram first.";
    errorEl.classList.remove("hidden");
    return;
  }
  if (!question) {
    errorEl.textContent = "Type a question.";
    errorEl.classList.remove("hidden");
    return;
  }

  loadingEl.classList.remove("hidden");
  submitBtn.disabled = true;
  askInput.disabled = true;

  try {
    const code = await callClaudeForDrilldown(card.selectedNode.label, question, card.mermaidCode);

    const childCard = createCard({
      depth: card.depth + 1,
      title: card.selectedNode.label,
      parentLabel: card.selectedNode.label,
      parentCardId: card.id,
    });

    await renderCardDiagram(childCard, code);
    setStatus("pill--ok", "Rendered");
    childCard.element.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    errorEl.textContent = err?.message || String(err);
    errorEl.classList.remove("hidden");
  } finally {
    loadingEl.classList.add("hidden");
    submitBtn.disabled = false;
    askInput.disabled = false;
  }
}

function buildTags() {
  const frag = document.createDocumentFragment();
  for (const t of TAGS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tag";
    b.textContent = t.label;
    b.dataset.id = t.id;
    b.dataset.hint = t.hint;
    b.addEventListener("click", () => {
      for (const n of el.tagList.querySelectorAll(".tag")) n.classList.remove("is-active");
      b.classList.add("is-active");
      const current = el.input.value.trim();
      const prefix = `Create a ${t.hint} for: `;
      el.input.value = current ? current : prefix;
      el.input.focus();
      el.input.setSelectionRange(el.input.value.length, el.input.value.length);
    });
    frag.appendChild(b);
  }
  el.tagList.appendChild(frag);
}

async function onSubmit(e) {
  e.preventDefault();
  clearError();
  setStatus("pill--idle", "Idle");

  const promptText = el.input.value.trim();
  if (!promptText) return;

  setLoading(true);
  try {
    const mermaidCode = await callClaudeForMermaid(promptText);
    const rootCard = createCard({
      depth: 1,
      title: truncate(promptText, 120),
      parentLabel: "",
      parentCardId: null,
    });
    await renderCardDiagram(rootCard, mermaidCode);
    setStatus("pill--ok", "Rendered");
    rootCard.element.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    showError(err?.message || String(err));
  } finally {
    setLoading(false);
  }
}

function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "default",
    flowchart: {
      curve: "basis",
      useMaxWidth: true,
      htmlLabels: true,
      nodeSpacing: 60,
      rankSpacing: 90,
      padding: 24,
    },
    sequence: { useMaxWidth: true, boxMargin: 12, messageMargin: 40 },
    gantt: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    class: { useMaxWidth: true },
    state: { useMaxWidth: true, padding: 20 },
    er: { useMaxWidth: true },
  });
}

function setupBackToTop() {
  if (!el.btnBackToTop) return;
  const onScroll = () => {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    el.btnBackToTop.classList.toggle("is-visible", y > 480);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  el.btnBackToTop.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  onScroll();
}

async function showWelcomeCard() {
  const card = createCard({
    depth: 1,
    title: "Welcome — click any node to drill down",
    parentLabel: "",
    parentCardId: null,
  });
  const code =
    "flowchart TD\n" +
    "A[DiagramStore Demo] --> B[Type a prompt above]\n" +
    "B --> C[Generate]\n" +
    "C --> D[Click any node]\n" +
    "D --> E[Sub-diagram appears below]\n" +
    "E --> F[Keep drilling deeper]";
  try {
    await renderCardDiagram(card, code);
    setStatus("pill--ok", "Rendered");
  } catch {
    // ignore — welcome card render is best-effort
  }
}

function boot() {
  buildTags();
  initMermaid();
  updateHistoryUi();
  setupBackToTop();

  el.form.addEventListener("submit", onSubmit);
  el.btnSetKey.addEventListener("click", setApiKeyInteractive);
  el.btnClearHistory.addEventListener("click", () => {
    if (history.length === 0) return;
    const ok = window.confirm("Clear all diagrams from the history?");
    if (ok) {
      clearHistory();
      setStatus("pill--idle", "Idle");
    }
  });

  if (el.lightboxClose) el.lightboxClose.addEventListener("click", closeImageLightbox);
  if (el.lightboxBackdrop) el.lightboxBackdrop.addEventListener("click", closeImageLightbox);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeImageLightbox();
  });

  showWelcomeCard().catch(() => {});
  setStatus("pill--idle", "Idle");
}

boot();
