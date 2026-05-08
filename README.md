# DiagramStore Demo

Static demo app that turns natural-language prompts into **Mermaid.js** diagrams using the **Anthropic Claude Messages API**.

## Files

- `index.html`: UI layout
- `style.css`: styles (responsive)
- `app.js`: Claude API call + Mermaid rendering

## Run locally

You **must** run a local server because the Anthropic API is **not callable directly from the browser** (CORS).

### Option A) Node proxy server (recommended)

```bash
cd d:\upwork\MH
set ANTHROPIC_API_KEY=YOUR_KEY_HERE
npm run dev
```

Then open `http://localhost:5500`.

### Option B) PowerShell variant

```powershell
cd d:\upwork\MH
$env:ANTHROPIC_API_KEY="YOUR_KEY_HERE"
npm run dev
```

## Set `ANTHROPIC_API_KEY`

This demo includes a tiny local proxy (`server.js`) that reads `ANTHROPIC_API_KEY` from your environment and calls Anthropic server-to-server (no CORS).

### Optional: in-app key (not recommended)

Click the **key icon (🔑)** in the header and paste your API key.
It’s stored in this browser’s `localStorage` as `ANTHROPIC_API_KEY` and sent to the local proxy via `x-client-key`.

## Notes

- **Browser calls**: `POST /api/messages` (local proxy)
- **Proxy calls**: `https://api.anthropic.com/v1/messages`
- **Model**: `claude-sonnet-4-20250514`
- **System prompt**: returns Mermaid code only (no fences, no explanations)
- If Claude returns invalid Mermaid (or network fails), the app shows an error and a small local fallback diagram.

