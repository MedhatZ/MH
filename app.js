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
};

// Diagram history: ordered list of card metadata.
// Each card: { id, depth, title, parentLabel, parentCardId, timestamp, mermaidCode, element, selectedNode }
const history = [];
let cardCounter = 0;

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

  applyReadableInitialView(card);

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
  if (btnReset) btnReset.addEventListener("click", () => applyReadableInitialView(card));

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
}

function teardownZoomPan(card) {
  const viewport = card.element && card.element.querySelector(".diagramCard__diagram");
  if (viewport) {
    if (card._onWheel) viewport.removeEventListener("wheel", card._onWheel);
    if (card._onMouseDown) viewport.removeEventListener("mousedown", card._onMouseDown);
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

  showWelcomeCard().catch(() => {});
  setStatus("pill--idle", "Idle");
}

boot();
