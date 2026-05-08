import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 5500);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function send(res, status, body, headers = {}) {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, {
    "content-length": buf ? String(buf.length) : "0",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-client-key",
    ...headers,
  });
  if (buf) res.end(buf);
  else res.end();
}

function addCors(_res) {}

async function handleApiMessages(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, "");
  if (req.method !== "POST") return send(res, 405, JSON.stringify({ error: "Method not allowed" }), { "content-type": MIME[".json"] });

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");

  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return send(res, 400, JSON.stringify({ error: "Invalid JSON body" }), { "content-type": MIME[".json"] });
  }

  const clientKey = String(req.headers["x-client-key"] || "").trim();
  const keyToUse = clientKey || ANTHROPIC_API_KEY;
  if (!keyToUse) {
    return send(
      res,
      401,
      JSON.stringify({
        error: "Missing API key. Set ANTHROPIC_API_KEY in your environment (recommended) or provide it via the app key icon.",
      }),
      { "content-type": MIME[".json"] },
    );
  }

  try {
    const upstream = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": keyToUse,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    const text = await upstream.text();
    return send(res, upstream.status, text, { "content-type": upstream.headers.get("content-type") || MIME[".json"] });
  } catch (e) {
    return send(
      res,
      502,
      JSON.stringify({ error: "Upstream request failed", detail: e?.message || String(e) }),
      { "content-type": MIME[".json"] },
    );
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  let filePath = pathname === "/" ? "/index.html" : pathname;
  // basic safety
  if (filePath.includes("..")) return send(res, 400, "Bad request", { "content-type": MIME[".txt"] });

  const abs = path.join(__dirname, filePath);
  const ext = path.extname(abs).toLowerCase();

  try {
    const data = await readFile(abs);
    return send(res, 200, data, { "content-type": MIME[ext] || "application/octet-stream" });
  } catch {
    return send(res, 404, "Not found", { "content-type": MIME[".txt"] });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/messages") return await handleApiMessages(req, res);
    return await serveStatic(req, res);
  } catch {
    send(res, 500, "Server error", { "content-type": MIME[".txt"] });
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`DiagramStore Demo running at http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Proxy endpoint: http://localhost:${PORT}/api/messages`);
});

 
