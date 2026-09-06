#!/usr/bin/env python3
"""
Qwen + DeepSeek API Bridge Server

Receives chat requests from Cline, forwards to Chrome extension via WebSocket,
streams responses back.

Run: python3 server.py
Open: http://localhost:8000

Requires: pip install websockets
"""

import asyncio, json, time, sys, os
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

try:
    import websockets
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets"])
    import websockets

PORT = 8000
WS_PORT = 8765

# ─── State ─────────────────────────────────────────────
connected_clients = set()
pending_requests = {}  # requestId -> asyncio.Future
request_counter = 0
state = {
    "extension_connected": False,
    "qwen_tab": False,
    "deepseek_tab": False,
    "logs": [],
    "analytics": {"total_reqs": 0, "total_in": 0, "total_out": 0},
}

# ─── WebSocket server (receives connections from extension) ───
async def ws_handler(websocket, path=None):
    connected_clients.add(websocket)
    state["extension_connected"] = True
    print(f"[WS] Extension connected ({len(connected_clients)} total)")
    
    try:
        async for message in websocket:
            try:
                msg = json.loads(message)
            except:
                continue

            if msg.get("type") == "ping":
                await websocket.send(json.dumps({"type": "pong"}))
                continue

            if msg.get("type") == "content_ready":
                provider = msg.get("provider", "")
                if provider == "qwen":
                    state["qwen_tab"] = True
                elif provider == "deepseek":
                    state["deepseek_tab"] = True
                print(f"[WS] {provider} tab ready")
                continue

            if msg.get("type") == "stream_chunk":
                req_id = msg.get("requestId")
                if req_id in pending_requests:
                    pending_requests[req_id]["chunks"].append(msg.get("text", ""))

            elif msg.get("type") == "stream_done":
                req_id = msg.get("requestId")
                if req_id in pending_requests:
                    pending_requests[req_id]["done"] = True

            elif msg.get("type") == "stream_error":
                req_id = msg.get("requestId")
                if req_id in pending_requests:
                    pending_requests[req_id]["error"] = msg.get("error", "Unknown error")

    except Exception as e:
        print(f"[WS] Error: {e}")
    finally:
        connected_clients.discard(websocket)
        if not connected_clients:
            state["extension_connected"] = False
            state["qwen_tab"] = False
            state["deepseek_tab"] = False
        print(f"[WS] Extension disconnected ({len(connected_clients)} remaining)")

async def send_to_extension(msg):
    """Send a message to the connected extension."""
    if not connected_clients:
        return False
    data = json.dumps(msg)
    for ws in list(connected_clients):
        try:
            await ws.send(data)
        except:
            connected_clients.discard(ws)
    return True

# ─── Chat handler ──────────────────────────────────────
async def handle_chat_async(data, wfile, stream=True):
    """Forward chat request to extension and stream response back."""
    global request_counter
    request_counter += 1
    request_id = f"req_{request_counter}"

    model = data.get("model", "qwen3.7-plus")
    messages = data.get("messages", [])
    prompt = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            prompt = m.get("content", "")
            break

    provider = "deepseek" if model.startswith("deepseek") else "qwen"

    if not state["extension_connected"]:
        if stream and not wfile.closed:
            wfile.write(b'data: {"error":"Extension not connected. Install the Chrome extension."}\n\n')
            wfile.flush()
        return

    if provider == "qwen" and not state["qwen_tab"]:
        if stream and not wfile.closed:
            wfile.write(b'data: {"error":"Open chat.qwen.ai in a browser tab first."}\n\n')
            wfile.flush()
        return

    if provider == "deepseek" and not state["deepseek_tab"]:
        if stream and not wfile.closed:
            wfile.write(b'data: {"error":"Open chat.deepseek.com in a browser tab first."}\n\n')
            wfile.flush()
        return

    # Set up pending request
    pending_requests[request_id] = {"chunks": [], "done": False, "error": None}

    # Send chat request to extension
    await send_to_extension({
        "type": "chat_request",
        "requestId": request_id,
        "provider": provider,
        "prompt": prompt,
        "model": model,
    })

    print(f"[Chat] {provider} request sent (id={request_id}, prompt={prompt[:50]}...)")

    if stream:
        # Stream chunks back to client
        initial_chunk = json.dumps({
            "id": "chatcmpl-x", "object": "chat.completion.chunk",
            "created": int(time.time()), "model": model,
            "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
        })
        wfile.write(f"data: {initial_chunk}\n\n".encode())
        wfile.flush()

        full_text = ""
        start = time.time()
        last_processed = 0

        while time.time() - start < 300:  # 5 min timeout
            req = pending_requests[request_id]
            new_chunks = req["chunks"][last_processed:]
            if new_chunks:
                last_processed = len(req["chunks"])
                for chunk in new_chunks:
                    for line in chunk.split("\n"):
                        trimmed = line.strip()
                        if not trimmed.startswith("data:"):
                            continue
                        payload = trimmed[5:].strip()
                        if payload == "[DONE]":
                            continue
                        try:
                            j = json.loads(payload)
                            choices = j.get("choices", [])
                            if choices and choices[0].get("delta", {}).get("content"):
                                delta = choices[0]["delta"]["content"]
                                full_text += delta
                                chunk_data = json.dumps({
                                    "id": "chatcmpl-x", "object": "chat.completion.chunk",
                                    "created": int(time.time()), "model": model,
                                    "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}],
                                })
                                if not wfile.closed:
                                    wfile.write(f"data: {chunk_data}\n\n".encode())
                                    wfile.flush()
                            elif "content_list" in j:
                                for item in j["content_list"]:
                                    if item.get("phase") == "answer" and item.get("content"):
                                        delta = item["content"]
                                        full_text += delta
                                        chunk_data = json.dumps({
                                            "id": "chatcmpl-x", "object": "chat.completion.chunk",
                                            "created": int(time.time()), "model": model,
                                            "choices": [{"index": 0, "delta": {"content": delta}, "finish_reason": None}],
                                        })
                                        if not wfile.closed:
                                            wfile.write(f"data: {chunk_data}\n\n".encode())
                                            wfile.flush()
                        except:
                            pass

            if req["done"]:
                break
            if req["error"]:
                if not wfile.closed:
                    wfile.write(f'data: {{"error":"{req["error"]}"}}\n\n'.encode())
                    wfile.flush()
                break

            await asyncio.sleep(0.02)

        # Send final chunk
        if not wfile.closed:
            done_chunk = json.dumps({
                "id": "chatcmpl-x", "object": "chat.completion.chunk",
                "created": int(time.time()), "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            })
            wfile.write(f"data: {done_chunk}\n\ndata: [DONE]\n\n".encode())
            wfile.flush()

        # Log
        state["analytics"]["total_reqs"] += 1
        state["analytics"]["total_in"] += len(prompt) // 4
        state["analytics"]["total_out"] += len(full_text) // 4
        state["logs"].append({
            "ts": time.time(), "model": model, "provider": provider,
            "prompt": prompt[:100], "response": full_text[:100], "chars": len(full_text),
        })
        if len(state["logs"]) > 100:
            state["logs"] = state["logs"][-100:]

        del pending_requests[request_id]
        print(f"[Chat] {provider} done ({len(full_text)} chars)")
    else:
        # Non-streaming — wait for full response
        full_text = ""
        start = time.time()
        last_processed = 0

        while time.time() - start < 300:
            req = pending_requests[request_id]
            new_chunks = req["chunks"][last_processed:]
            if new_chunks:
                last_processed = len(req["chunks"])
                for chunk in new_chunks:
                    for line in chunk.split("\n"):
                        trimmed = line.strip()
                        if not trimmed.startswith("data:"):
                            continue
                        payload = trimmed[5:].strip()
                        if payload == "[DONE]":
                            continue
                        try:
                            j = json.loads(payload)
                            choices = j.get("choices", [])
                            if choices and choices[0].get("delta", {}).get("content"):
                                full_text += choices[0]["delta"]["content"]
                            elif "content_list" in j:
                                for item in j["content_list"]:
                                    if item.get("phase") == "answer" and item.get("content"):
                                        full_text += item["content"]
                        except:
                            pass
            if req["done"] or req["error"]:
                break
            await asyncio.sleep(0.02)

        del pending_requests[request_id]
        return full_text

# ─── HTTP Server ────────────────────────────────────────
ws_loop = None

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            self._html(DASHBOARD)
        elif path == "/chat":
            self._html(CHAT_PAGE)
        elif path == "/cline":
            self._html(CLINE_PAGE)
        elif path == "/api/status":
            self._json({
                "extension": state["extension_connected"],
                "qwen": state["qwen_tab"],
                "deepseek": state["deepseek_tab"],
                "analytics": state["analytics"],
            })
        elif path == "/api/models":
            self._json({"object": "list", "data": [
                {"id": "qwen3.7-plus", "object": "model", "owned_by": "qwen"},
                {"id": "qwen3.8-max", "object": "model", "owned_by": "qwen"},
                {"id": "deepseek-chat", "object": "model", "owned_by": "deepseek"},
                {"id": "deepseek-reasoner", "object": "model", "owned_by": "deepseek"},
            ]})
        elif path == "/api/logs":
            self._json({"data": state["logs"][-50:]})
        elif path == "/health":
            self._json({"status": "ok", "extension": state["extension_connected"]})
        else:
            self.send_error(404)

    def do_POST(self):
        path = self.path.split("?")[0]
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode() if length else "{}"
        try:
            data = json.loads(body)
        except:
            data = {}

        if path == "/v1/chat/completions":
            self._handle_chat(data)
        else:
            self.send_error(404)

    def _handle_chat(self, data):
        stream = data.get("stream", True)
        model = data.get("model", "qwen3.7-plus")

        if stream:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self._cors()
            self.end_headers()

            async def run():
                await handle_chat_async(data, self.wfile, stream=True)
            future = asyncio.run_coroutine_threadsafe(run(), ws_loop)
            try:
                future.result(timeout=310)
            except:
                pass
        else:
            async def run():
                return await handle_chat_async(data, self.wfile, stream=False)
            future = asyncio.run_coroutine_threadsafe(run(), ws_loop)
            try:
                full_text = future.result(timeout=310)
                self._json({
                    "id": "chatcmpl-x", "object": "chat.completion",
                    "created": int(time.time()), "model": model,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": full_text}, "finish_reason": "stop"}],
                })
            except Exception as e:
                self._json({"error": {"message": str(e)}}, 502)

    def _html(self, content):
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self._cors()
        self.end_headers()
        self.wfile.write(content.encode())

    def _json(self, obj, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._cors()
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode())

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

# ─── HTML Pages ────────────────────────────────────────
NAV = '<nav style="display:flex;background:#1a1a2e"><a href="/" style="padding:12px 20px;color:#aaa;text-decoration:none;font-size:14px">Dashboard</a><a href="/chat" style="padding:12px 20px;color:#aaa;text-decoration:none;font-size:14px">Chat</a><a href="/cline" style="padding:12px 20px;color:#aaa;text-decoration:none;font-size:14px">Cline</a></nav>'
S = '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui;background:#0f0f1a;color:#e0e0e0}.card{background:#1a1a2e;border-radius:12px;padding:20px;margin:16px}.badge{padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}.on{background:#1a5c3a;color:#4ade80}.off{background:#5c1a1a;color:#f87171}input,select{background:#0f0f1a;border:1px solid #333;border-radius:8px;padding:10px 14px;color:#e0e0e0;width:100%;font-size:14px}button{background:#2563eb;color:#fff;border:none;border-radius:8px;padding:10px 20px;cursor:pointer;font-size:14px}.stat{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #2a2a3e}pre{background:#0a0a14;padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;color:#4ade80}.msg{padding:10px 14px;border-radius:12px;margin:8px 0;max-width:80%}.user{background:#1e3a5f;margin-left:auto}.bot{background:#1a2e1a}</style>'

DASHBOARD = f'''<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>API Bridge</title>{S}</head><body>{NAV}
<div style="padding:20px;max-width:600px;margin:0 auto">
<h1 style="margin-bottom:20px">API Bridge</h1>
<div class="card">
<h2 style="margin-bottom:12px">Connection Status</h2>
<div class="stat"><span>Chrome Extension</span><span id="ext" class="badge off">—</span></div>
<div class="stat"><span>Qwen Tab</span><span id="qw" class="badge off">—</span></div>
<div class="stat"><span>DeepSeek Tab</span><span id="ds" class="badge off">—</span></div>
</div>
<div class="card">
<h2 style="margin-bottom:12px">Setup</h2>
<p style="font-size:13px;color:#888;line-height:1.6">
1. Install the Chrome extension (load unpacked from <code style="color:#4ade80">qwen-extension/</code> folder)<br>
2. Open <a href="https://chat.qwen.ai" style="color:#4ade80">chat.qwen.ai</a> in a tab<br>
3. Open <a href="https://chat.deepseek.com" style="color:#4ade80">chat.deepseek.com</a> in a tab<br>
4. Log in to both (if not already)<br>
5. The extension auto-connects — status turns green above
</p>
</div>
<div class="card">
<h2 style="margin-bottom:12px">Analytics</h2>
<div class="stat"><span>Requests</span><span id="reqs">0</span></div>
<div class="stat"><span>Tokens In</span><span id="tin">0</span></div>
<div class="stat"><span>Tokens Out</span><span id="tout">0</span></div>
</div>
</div>
<script>
async function poll() {{
  try {{
    const r = await fetch('/api/status');
    const d = await r.json();
    const set = (id, val) => {{
      const el = document.getElementById(id);
      el.textContent = val ? 'Connected' : 'Not connected';
      el.className = 'badge ' + (val ? 'on' : 'off');
    }};
    set('ext', d.extension); set('qw', d.qwen); set('ds', d.deepseek);
    document.getElementById('reqs').textContent = d.analytics.total_reqs;
    document.getElementById('tin').textContent = d.analytics.total_in;
    document.getElementById('tout').textContent = d.analytics.total_out;
  }} catch {{}}
}}
setInterval(poll, 3000); poll();
</script>
</body></html>'''

CHAT_PAGE = f'''<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat</title>{S}</head><body>{NAV}
<div style="padding:20px;max-width:800px;margin:0 auto">
<div style="display:flex;gap:8px;margin-bottom:16px"><select id="model" style="width:auto">
<option value="qwen3.7-plus">Qwen3.7-Plus</option><option value="qwen3.8-max">Qwen3.8-Max</option>
<option value="deepseek-chat">DeepSeek Chat</option><option value="deepseek-reasoner">DeepSeek Reasoner</option>
</select></div>
<div id="msgs" style="min-height:300px;margin-bottom:16px"></div>
<div style="display:flex;gap:8px"><input id="inp" placeholder="Type..." onkeydown="if(event.key==='Enter')send()"><button onclick="send()">Send</button></div>
</div>
<script>
const m=[];
async function send() {{
  const i=document.getElementById('inp'),t=i.value.trim();if(!t)return;i.value='';
  m.push({{role:'user',content:t}});render();
  const model=document.getElementById('model').value;
  const b=document.createElement('div');b.className='msg bot';b.textContent='...';
  document.getElementById('msgs').appendChild(b);
  try {{
    const r=await fetch('/v1/chat/completions',{{method:'POST',headers:{{'Content-Type':'application/json'}},body:JSON.stringify({{model,messages:m,stream:true}})}});
    const rd=r.body.getReader(),d=new TextDecoder();let buf='',full='';
    while(true){{const{{done,value}}=await rd.read();if(done)break;buf+=d.decode(value,{{stream:true}});
    const lines=buf.split('\\n');buf=lines.pop();
    for(const l of lines){{const t=l.trim();if(!t.startsWith('data:'))continue;const p=t.slice(5).trim();
    if(p==='[DONE]')continue;try{{const j=JSON.parse(p);const c=j.choices?.[0]?.delta?.content;
    if(c){{full+=c;b.textContent=full}}}}catch{{}}}}}}
    m.push({{role:'assistant',content:full}});
  }} catch(e) {{ b.textContent='Error: '+e; }}
  render();
}}
function render(){{const d=document.getElementById('msgs');d.innerHTML='';
  for(const x of m){{const e=document.createElement('div');e.className='msg '+(x.role==='user'?'user':'bot');
  e.textContent=x.content;d.appendChild(e)}}d.scrollTop=d.scrollHeight;}}
</script>
</body></html>'''

CLINE_PAGE = f'''<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cline</title>{S}</head><body>{NAV}
<div style="padding:20px;max-width:600px;margin:0 auto">
<h1 style="margin-bottom:20px">Cline Setup</h1>
<div class="card">
<p style="margin-bottom:16px">In Cline (VS Code) → Settings:</p>
<div class="stat"><span>API Provider</span><b style="color:#4ade80">OpenAI Compatible</b></div>
<div class="stat"><span>Base URL</span><code style="color:#4ade80">http://localhost:{PORT}/v1</code></div>
<div class="stat"><span>API Key</span><code style="color:#4ade80">sk-local</code></div>
<div class="stat"><span>Model</span><code style="color:#4ade80">qwen3.7-plus</code></div>
</div>
<div class="card"><h3>Test</h3>
<pre>curl -N http://localhost:{PORT}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{{"model":"qwen3.7-plus","messages":[{{"role":"user","content":"Hi"}}]}}'</pre>
</div>
</div></body></html>'''

# ─── Main ────────────────────────────────────────────────
def run_ws_server():
    """Run the WebSocket server in a separate thread."""
    global ws_loop
    ws_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(ws_loop)
    ws_server = websockets.serve(ws_handler, "0.0.0.0", WS_PORT)
    ws_loop.run_until_complete(ws_server)
    print(f"[WS] WebSocket server on port {WS_PORT}")
    ws_loop.run_forever()

def main():
    print("""
╔══════════════════════════════════════════════╗
║  Qwen + DeepSeek API Bridge                  ║
║  Chrome Extension + Python Server            ║
╚══════════════════════════════════════════════╝
""")
    # Start WebSocket server in background thread
    ws_thread = threading.Thread(target=run_ws_server, daemon=True)
    ws_thread.start()
    time.sleep(1)

    # Start HTTP server in main thread
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[✓] HTTP server on http://localhost:{PORT}")
    print(f"[✓] WebSocket on ws://localhost:{WS_PORT}")
    print(f"\n    Dashboard: http://localhost:{PORT}")
    print(f"    Chat:      http://localhost:{PORT}/chat")
    print(f"    Cline URL: http://localhost:{PORT}/v1")
    print(f"\n    Install the Chrome extension:")
    print(f"    1. Open chrome://extensions")
    print(f"    2. Enable Developer mode (top right)")
    print(f"    3. Click 'Load unpacked' → select qwen-extension/ folder")
    print(f"    4. Open chat.qwen.ai + chat.deepseek.com tabs")
    print(f"\n    Press Ctrl+C to stop\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[!] Stopping...")
        server.server_close()

if __name__ == "__main__":
    main()
