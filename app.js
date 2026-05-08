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
  tagList: document.getElementById("tagList"),
  loading: document.getElementById("loading"),
  error: document.getElementById("errorBox"),
  status: document.getElementById("statusPill"),
  diagram: document.getElementById("diagram"),
  codeDetails: document.getElementById("codeDetails"),
  codeBlock: document.getElementById("codeBlock"),
  btnCopy: document.getElementById("btnCopy"),
  btnFormat: document.getElementById("btnFormat"),

  drillDetails: document.getElementById("drillDetails"),
  drillForm: document.getElementById("drillForm"),
  drillNode: document.getElementById("drillNode"),
  drillQuestion: document.getElementById("drillQuestion"),
  drillAnswer: document.getElementById("drillAnswer"),
  drillLoading: document.getElementById("drillLoading"),
  drillError: document.getElementById("drillError"),
  btnAsk: document.getElementById("btnAsk"),
};

let lastMermaidCode = "";
let selectedNodeLabel = "";

function getApiKey() {
  // Preferred: injected global for demo builds
  if (typeof window !== "undefined" && window.ANTHROPIC_API_KEY) return String(window.ANTHROPIC_API_KEY).trim();
  // Fallback: localStorage for static hosting
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

function setDrillLoading(on) {
  el.drillLoading.classList.toggle("hidden", !on);
  el.btnAsk.disabled = on;
  el.drillQuestion.disabled = on;
}

function showDrillError(message) {
  el.drillError.textContent = message;
  el.drillError.classList.remove("hidden");
}

function clearDrillError() {
  el.drillError.classList.add("hidden");
  el.drillError.textContent = "";
}

function normalizeMermaid(raw) {
  const s = String(raw || "").replace(/\r\n/g, "\n").trim();
  // Remove accidental fences if the model misbehaves
  const noFences = s
    .replace(/^```[a-zA-Z]*\n/, "")
    .replace(/\n```$/, "")
    .trim();
  // Force top-down for flowcharts/graphs when the model returns LR/RL/BT/TB or no direction
  // (Keeps other diagram types unchanged.)
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

function highlightSelectedNode(nodeEl) {
  el.diagram.querySelectorAll(".node.is-selected").forEach((n) => n.classList.remove("is-selected"));
  if (nodeEl) nodeEl.classList.add("is-selected");
}

function handleNodeQuestion(label, nodeEl) {
  selectedNodeLabel = label;
  el.drillDetails.open = true;
  el.drillNode.textContent = label || "Unknown node";
  highlightSelectedNode(nodeEl);

  const q = `How is \"${label}\" performed?`;
  el.drillQuestion.value = q;
  el.drillQuestion.focus();
  el.drillQuestion.setSelectionRange(el.drillQuestion.value.length, el.drillQuestion.value.length);
}

function bindNodeClicks() {
  const nodes = el.diagram.querySelectorAll(".node");
  nodes.forEach((node) => {
    node.style.cursor = "pointer";
    node.setAttribute("tabindex", "0");
    node.setAttribute("role", "button");

    const onPick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const label = getNodeLabel(node);
      if (label) handleNodeQuestion(label, node);
    };

    node.addEventListener("click", onPick);
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") onPick(e);
    });
  });
}

function guessFallbackDiagram(promptText) {
  const t = String(promptText || "").toLowerCase();
  if (t.includes("sequence")) return "sequenceDiagram\nparticipant User\nparticipant System\nUser->>System: Request\nSystem-->>User: Response";
  if (t.includes("class")) return "classDiagram\nclass User\nclass Account\nUser --> Account";
  if (t.includes("er")) return "erDiagram\nUSER ||--o{ ORDER : places\nORDER ||--|{ ORDER_ITEM : contains";
  if (t.includes("gantt")) return "gantt\ntitle Project Plan\nsection Phase 1\nTask A :a1, 2026-01-01, 7d\nTask B :after a1, 5d";
  if (t.includes("state")) return "stateDiagram-v2\n[*] --> Idle\nIdle --> Working : start\nWorking --> Idle : done";
  if (t.includes("mindmap")) return "mindmap\n  root((DiagramStore))\n    Search\n    Generate\n    Preview";
  return "flowchart TD\nA[Prompt] --> B[Claude API]\nB --> C[Mermaid Code]\nC --> D[Render]";
}

async function callClaudeForMermaid(userPrompt) {
  const apiKey = getApiKey(); // optional; server can also use env var

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
  // Anthropic Messages API returns: { content: [{ type:"text", text:"..." }, ...] }
  const parts = Array.isArray(data?.content) ? data.content : [];
  const text = parts
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();

  if (!text) throw new Error("Empty response from Claude.");
  return text;
}

async function callClaudeForDrilldown(nodeLabel, question, diagramCode) {
  const apiKey = getApiKey(); // optional; server can also use env var

  const system =
    "You are a precise, helpful tutor. Answer the user's question about a single step in a diagram.\n" +
    "Be concrete and structured. Use short bullet points when helpful.\n" +
    "If the step could be ambiguous, ask 1 short clarifying question.\n" +
    "Do not include Mermaid code unless explicitly asked.\n";

  const user = [
    "Diagram context (Mermaid):",
    diagramCode || "(none)",
    "",
    `Selected step: ${nodeLabel || "(unknown)"}`,
    `Question: ${question}`,
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

async function renderMermaid(code) {
  const clean = normalizeMermaid(code);
  el.codeBlock.textContent = clean;
  el.codeDetails.open = true;
  lastMermaidCode = clean;

  // Ensure unique IDs for repeated renders
  const id = `mmd-${Math.random().toString(16).slice(2)}`;
  el.diagram.innerHTML = "";

  try {
    const { svg } = await mermaid.render(id, clean);
    el.diagram.innerHTML = svg;
    setStatus("pill--ok", "Rendered");
    bindNodeClicks();
  } catch (e) {
    // Show raw code if render fails
    el.diagram.innerHTML = `<div style="padding:12px;color:#b42318;font-size:13px;">
      Mermaid render error. Check the Mermaid code below.
    </div>`;
    throw new Error(`Mermaid render error: ${e?.message || String(e)}`);
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

function cleanUpCode() {
  const v = normalizeMermaid(el.codeBlock.textContent);
  el.codeBlock.textContent = v;
}

async function copyCode() {
  const v = el.codeBlock.textContent || "";
  if (!v) return;
  try {
    await navigator.clipboard.writeText(v);
    el.btnCopy.textContent = "Copied";
    window.setTimeout(() => (el.btnCopy.textContent = "Copy"), 900);
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = v;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    el.btnCopy.textContent = "Copied";
    window.setTimeout(() => (el.btnCopy.textContent = "Copy"), 900);
  }
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
    await renderMermaid(mermaidCode);
  } catch (err) {
    const msg = err?.message || String(err);
    showError(msg);
    // still show something useful
    const fallback = guessFallbackDiagram(promptText);
    el.codeBlock.textContent = fallback;
    el.diagram.innerHTML =
      `<div style="padding:12px;color:#667085;font-size:13px;">
        Showing a local fallback diagram. Fix the error above and try again.
      </div>`;
  } finally {
    setLoading(false);
  }
}

async function onAskDrilldown(e) {
  e.preventDefault();
  clearDrillError();

  const question = (el.drillQuestion.value || "").trim();
  if (!question) return;

  if (!selectedNodeLabel) {
    showDrillError("Click a node in the diagram first.");
    return;
  }

  setDrillLoading(true);
  try {
    const answer = await callClaudeForDrilldown(selectedNodeLabel, question, lastMermaidCode);
    el.drillAnswer.textContent = answer;
  } catch (err) {
    showDrillError(err?.message || String(err));
  } finally {
    setDrillLoading(false);
  }
}

function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "default",
    flowchart: {
      // Encourage compact, readable vertical layouts
      curve: "linear",
      nodeSpacing: 35,
      rankSpacing: 55,
    },
  });
}

function boot() {
  buildTags();
  initMermaid();

  el.form.addEventListener("submit", onSubmit);
  el.btnSetKey.addEventListener("click", setApiKeyInteractive);
  el.btnCopy.addEventListener("click", copyCode);
  el.btnFormat.addEventListener("click", cleanUpCode);
  el.drillForm.addEventListener("submit", onAskDrilldown);

  // Initial demo diagram
  const initial = "flowchart TD\nA[DiagramStore Demo] --> B[Type prompt]\nB --> C[Generate]\nC --> D[Mermaid renders here]";
  renderMermaid(initial).catch(() => {});
  el.codeBlock.textContent = initial;
  setStatus("pill--idle", "Idle");
}

boot();

