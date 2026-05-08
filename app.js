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
  const depthLabel = isRoot ? `Root · Depth ${depth}` : `Depth ${depth}`;
  const depthClass = isRoot ? "diagramCard__depth diagramCard__depth--root" : "diagramCard__depth";

  card.innerHTML = `
    <header class="diagramCard__header">
      <div class="diagramCard__badges">
        <span class="${depthClass}">${depthLabel}</span>
        <span class="diagramCard__time" title="${timestamp.toISOString()}">${formatTime(timestamp)}</span>
      </div>
      <div class="diagramCard__titleRow">
        <div class="diagramCard__title"></div>
        <button class="diagramCard__remove" type="button" title="Remove this diagram" aria-label="Remove this diagram">×</button>
      </div>
      <div class="diagramCard__parent"></div>
    </header>

    <div class="diagramCard__diagramWrap">
      <div class="diagramCard__diagram" aria-label="Rendered diagram"></div>
    </div>

    <div class="diagramCard__nodeInfo hidden">
      <div class="diagramCard__nodeLabel">
        Selected node: <strong class="diagramCard__nodeText"></strong>
      </div>
      <form class="diagramCard__askForm" autocomplete="off">
        <input
          class="diagramCard__askInput"
          type="text"
          placeholder='e.g. "Explain this step in more detail"'
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

    <details class="diagramCard__code" open>
      <summary class="diagramCard__codeSummary">
        <span>Mermaid code</span>
        <span class="diagramCard__codeHint">click to collapse</span>
      </summary>
      <div class="diagramCard__codeToolbar">
        <button type="button" class="btn diagramCard__copy">Copy</button>
      </div>
      <div class="diagramCard__codeBody">
        <pre class="code__pre"><code class="code__code diagramCard__codeBlock"></code></pre>
      </div>
    </details>
  `;

  card.querySelector(".diagramCard__title").textContent = title || (isRoot ? "Diagram" : "Sub-diagram");

  const parentEl = card.querySelector(".diagramCard__parent");
  if (parentCardId && parentLabel) {
    const parentCard = history.find((c) => c.id === parentCardId);
    const fromLabel = parentCard ? truncate(parentCard.title, 60) : "previous diagram";
    parentEl.innerHTML = `From <strong>${escapeHtml(fromLabel)}</strong> → node <strong>${escapeHtml(parentLabel)}</strong>`;
  } else {
    parentEl.textContent = "Top-level diagram from your prompt.";
  }

  const meta = {
    id,
    depth,
    title,
    parentLabel,
    parentCardId,
    timestamp,
    mermaidCode: "",
    element: card,
    selectedNode: { label: "", el: null },
  };

  card.querySelector(".diagramCard__remove").addEventListener("click", () => removeCard(id));
  card.querySelector(".diagramCard__copy").addEventListener("click", (e) => copyCardCode(meta, e.currentTarget));
  card.querySelector(".diagramCard__askForm").addEventListener("submit", (e) => onAskFromCard(e, meta));

  history.push(meta);
  el.history.appendChild(card);
  updateHistoryUi();

  return meta;
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
  card.element.remove();
  history.splice(idx, 1);
  updateHistoryUi();
}

function clearHistory() {
  for (const card of history.slice()) card.element.remove();
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
  if (!input.value.trim()) {
    input.value = `Explain "${label}" in more detail with a step-by-step flowchart.`;
  }
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function renderCardDiagram(card, code) {
  const clean = normalizeMermaid(code);
  card.mermaidCode = clean;

  const codeBlock = card.element.querySelector(".diagramCard__codeBlock");
  codeBlock.textContent = clean;

  const diagram = card.element.querySelector(".diagramCard__diagram");
  diagram.innerHTML = "";
  const renderId = `mmd-${card.id}-${Math.random().toString(16).slice(2)}`;

  try {
    const { svg } = await mermaid.render(renderId, clean);
    diagram.innerHTML = svg;
    bindCardNodeClicks(card);
  } catch (e) {
    diagram.innerHTML = `<div style="padding:12px;color:#b42318;font-size:13px;">
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
      curve: "linear",
      nodeSpacing: 35,
      rankSpacing: 55,
    },
  });
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
