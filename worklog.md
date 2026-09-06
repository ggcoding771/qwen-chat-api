# Project Worklog

---
Task ID: 1
Agent: main (Z.ai Code)
Task: Analyze chat.qwen.ai chat system + API flow, then build an OpenAI-compatible API proxy using a real Qwen account.

Work Log:
- Used agent-browser to navigate chat.qwen.ai, captured network requests, dumped the React bundle's API endpoint catalog
- Reverse-engineered the API flow: bootstrap (/configs, /models, /users/status), auth (/api/v1/auths), chat (/api/v2/chat/completions with SSE), Baxia anti-bot protected-path list
- Identified that Baxia intercepts axios (not native fetch), so any direct fetch() hangs server-side
- Inspected Qwen login page — confirmed email/password is supported (no Google OAuth required)
- Built `mini-services/qwen-proxy/` — a Bun + Playwright service that:
  - Logs into chat.qwen.ai via headless Chromium with persistent context
  - Saves storage state for fast restarts
  - Exposes OpenAI-compatible `/v1/chat/completions` (streaming SSE + non-streaming) and `/v1/models`
  - Uses a UI-driven approach (click New Chat → fill input → click Send → poll `.response-message-content.phase-answer` DOM) since Baxia blocks native fetch
  - Serializes concurrent requests via a mutex (single shared browser page)
  - Forwards page console to Node for debugging
  - Includes `manage.sh` (start/stop/restart/status with PID file)
- Added Next.js routes: `src/app/api/v1/chat/completions/route.ts` + `src/app/api/v1/models/route.ts` that proxy to localhost:3030
- Built polished chat demo UI on `/` with emerald/teal accent, sticky header, status badge, model selector, streaming chat bubbles, API docs drawer, sticky footer
- Self-verified with agent-browser: page renders correctly, "Proxy online" badge works, sending "What is 2 plus 2?" returns "4"
- VLM verified UI quality: clean, no overlapping/cut-off content, professional developer aesthetic

Stage Summary:
- Working OpenAI-compatible API at `/api/v1/chat/completions` driving a real chat.qwen.ai browser session
- Verified end-to-end: "Count 1 to 5" → `1\n2\n3\n4\n5`; "Capital of France" → "Paris"; "Haiku about ocean" → 3-line haiku
- Proxy service: `/home/z/my-project/mini-services/qwen-proxy/` (port 3030)
- Next.js routes: `/api/v1/chat/completions`, `/api/v1/models`
- Demo UI: `/` (root)
- Credentials stored as env vars in `mini-services/qwen-proxy/.env` (gitignored)
- Note: rotate the Qwen account password after use
