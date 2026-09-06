#!/usr/bin/env python3
"""
Qwen Chat Proxy — Standalone Python OpenAI-compatible API gateway for chat.qwen.ai

Drives a real Playwright browser session to satisfy Baxia anti-bot.
Exposes OpenAI-compatible endpoints on localhost:3031.

Usage:
    pip install -r requirements.txt
    playwright install chromium
    python qwen_proxy.py

Features:
- Chat continuity (same first user message = continue same Qwen chat)
- Chat list / select / new chat endpoints
- Mode toggles (thinking, search, deep_research)
- Request logs + analytics
- CLI dashboard with rich
- Cline / OpenAI-compatible
"""

import asyncio
import hashlib
import json
import os
import sys
import time
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
import uvicorn
from playwright.async_api import async_playwright, Browser, Page, BrowserContext
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.live import Live
from rich.text import Text

console = Console()

PORT = 3031
QWEN_HOME = "https://chat.qwen.ai"
QWEN_AUTH = "https://chat.qwen.ai/auth"

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
class ProxyState:
    def __init__(self):
        self.started_at = time.time()
        self.requests_handled = 0
        self.chat = {
            "current_chat_id": None,
            "current_chat_url": None,
            "first_user_message_hash": None,
            "last_user_message": None,
            "mode": {"thinking": True, "search": False, "deep_research": False},
            "model": "qwen3.7-plus",
        }
        self.logs: list[dict] = []

    def add_log(self, entry: dict):
        entry["id"] = f"log_{uuid.uuid4().hex[:10]}"
        entry["timestamp"] = time.time()
        self.logs.append(entry)
        if len(self.logs) > 500:
            self.logs.pop(0)
        console.print(f"[dim][log:{entry['type']}][/dim] {entry.get('prompt','')[:60]} {'ERR:'+entry.get('error','')[:80] if entry.get('error') else 'ok'}")


state = ProxyState()
browser: Optional[Browser] = None
context: Optional[BrowserContext] = None
page: Optional[Page] = None
ready = False
page_lock = asyncio.Lock()

MODEL_MAP = {
    "qwen3.7-plus": "qwen3.7-plus",
    "qwen3.8-max": "qwen3.8-max",
    "qwen-plus": "qwen3.7-plus",
    "qwen-max": "qwen3.8-max",
    "gpt-4": "qwen3.7-plus",
    "gpt-4o": "qwen3.7-plus",
    "default": "qwen3.7-plus",
}


def map_model(openai_model: str | None) -> str:
    if not openai_model:
        return MODEL_MAP["default"]
    return MODEL_MAP.get(openai_model, MODEL_MAP["default"])


def simple_hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Browser bootstrap + login
# ---------------------------------------------------------------------------
async def bootstrap_browser():
    global browser, context, page, ready

    email = os.environ.get("QWEN_EMAIL", "")
    password = os.environ.get("QWEN_PASSWORD", "")

    if not email or not password:
        # Interactive prompt
        console.print("[bold yellow]Qwen credentials not found in env.[/bold yellow]")
        email = input("Enter your Qwen email: ").strip()
        password = input("Enter your Qwen password: ").strip()
        if not email or not password:
            console.print("[red]Credentials required. Exiting.[/red]")
            sys.exit(1)
        # Save to .env
        with open(".env", "w") as f:
            f.write(f"QWEN_EMAIL={email}\nQWEN_PASSWORD={password}\n")
        console.print("[green]Credentials saved to .env[/green]")

    console.print("[cyan]Launching browser…[/cyan]")
    pw = await async_playwright().start()
    browser = await pw.chromium.launch_persistent_context(
        user_data_dir=".browser-data",
        headless=True,
        args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        viewport={"width": 1366, "height": 768},
    )
    context = browser
    page = await context.new_page()
    page.on("console", lambda msg: console.print(f"[dim][page:{msg.type}][/dim] {msg.text[:200]}") if msg.type in ("error", "warning", "log") else None)
    page.on("pageerror", lambda err: console.print(f"[red][pageerror][/red] {err.message[:200]}"))

    await page.goto(QWEN_HOME, wait_until="domcontentloaded")
    await page.wait_for_timeout(2500)

    # Check auth
    authed = await page.evaluate("""
        async () => {
            const r = await fetch('/api/v1/auths/', { credentials: 'include' });
            return r.status === 200;
        }
    """)

    if not authed:
        console.print("[yellow]Not authenticated — performing login…[/yellow]")
        await perform_login(email, password)
    else:
        console.print("[green]Already authenticated.[/green]")

    if "/auth" in page.url:
        await page.goto(QWEN_HOME, wait_until="domcontentloaded")
        await page.wait_for_timeout(2000)

    extract_chat_id_from_url()
    ready = True
    console.print("[bold green]✓ Proxy ready![/bold green]")


async def perform_login(email: str, password: str):
    await page.goto(QWEN_AUTH, wait_until="domcontentloaded")
    await page.wait_for_timeout(1500)
    await page.get_by_placeholder("Enter Your Email").fill(email)
    await page.get_by_placeholder("Enter Your Password").fill(password)
    await page.wait_for_timeout(500)
    await page.get_by_role("button", name="Sign in").click()
    try:
        await page.wait_for_url(QWEN_HOME, timeout=30000)
    except:
        pass
    await page.wait_for_timeout(2500)
    authed = await page.evaluate("""
        async () => {
            const r = await fetch('/api/v1/auths/', { credentials: 'include' });
            return r.status === 200;
        }
    """)
    if not authed:
        raise Exception("Login failed — check credentials or captcha.")
    console.print("[green]Login successful.[/green]")


def extract_chat_id_from_url() -> str | None:
    if not page:
        return None
    import re
    m = re.search(r"/c/([a-f0-9-]+)", page.url or "")
    if m:
        state.chat["current_chat_id"] = m.group(1)
        state.chat["current_chat_url"] = page.url
        return m.group(1)
    return None


# ---------------------------------------------------------------------------
# UI actions
# ---------------------------------------------------------------------------
async def click_new_chat():
    console.print("[cyan][ui][/cyan] clicking New Chat…")
    try:
        await page.get_by_role("button", name="New Chat").first.click(timeout=5000)
        await page.wait_for_timeout(1200)
    except:
        try:
            await page.locator('[aria-label*="New Chat"]').first.click(timeout=3000)
            await page.wait_for_timeout(1200)
        except:
            console.print("[yellow][ui] New Chat button not found[/yellow]")
    state.chat["current_chat_id"] = None
    state.chat["current_chat_url"] = None
    state.chat["first_user_message_hash"] = None
    state.chat["last_user_message"] = None


async def navigate_to_chat(chat_id: str):
    console.print(f"[cyan][ui][/cyan] navigating to chat {chat_id}…")
    await page.goto(f"{QWEN_HOME}/c/{chat_id}", wait_until="domcontentloaded")
    await page.wait_for_timeout(2500)
    state.chat["current_chat_id"] = chat_id
    state.chat["current_chat_url"] = page.url


async def fill_and_send(text: str):
    input_el = page.get_by_placeholder("Ask Qwen")
    await input_el.click()
    await page.wait_for_timeout(150)
    await page.keyboard.press("Control+a")
    await page.keyboard.press("Delete")
    await page.wait_for_timeout(100)
    await input_el.fill(text)
    await page.wait_for_timeout(300)

    value = await input_el.input_value()
    if value != text:
        console.print("[yellow][ui] fill mismatch, retrying…[/yellow]")
        await input_el.click()
        await page.keyboard.press("Control+a")
        await page.keyboard.press("Delete")
        await page.wait_for_timeout(100)
        await input_el.press_sequentially(text, delay=5)
        await page.wait_for_timeout(300)

    console.print("[cyan][ui][/cyan] sending…")
    try:
        send_btn = page.get_by_role("button", name="Send")
        await send_btn.wait_for(state="visible", timeout=3000)
        await send_btn.click(timeout=3000)
    except:
        console.print("[yellow][ui] Send button not clickable — pressing Enter…[/yellow]")
        await input_el.press("Enter")


async def stream_response(on_text, on_done, existing_count=0):
    # Wait for new assistant message to appear
    try:
        await page.wait_for_function(
            f"document.querySelectorAll('.qwen-chat-message-assistant').length > {existing_count}",
            timeout=20000,
        )
    except:
        raise Exception("new assistant message did not appear within 20s")

    last_text = ""
    stable_ticks = 0
    start_time = time.time()
    POLL_MS = 150
    STABLE_LIMIT = 14
    HARD_TIMEOUT_MS = 120000

    while True:
        result = await page.evaluate("""
            () => {
                const msgs = document.querySelectorAll('.qwen-chat-message-assistant');
                if (msgs.length === 0) return {text: '', thinking: false};
                const last = msgs[msgs.length - 1];
                // Check if thinking (Skip button visible)
                const allEls = last.querySelectorAll('*');
                let isThinking = false;
                for (const el of allEls) {
                    if (el.children.length === 0) {
                        const t = (el.textContent || '').trim().toLowerCase();
                        if (t === 'skip' && el.offsetWidth > 0 && el.offsetHeight > 0) {
                            isThinking = true;
                            break;
                        }
                    }
                }
                // Read only the answer phase
                let text = '';
                for (const sel of ['.response-message-content.phase-answer .custom-qwen-markdown', '.response-message-content.phase-answer']) {
                    const el = last.querySelector(sel);
                    if (el && el.textContent && el.textContent.trim()) {
                        text = el.textContent;
                        break;
                    }
                }
                if (isThinking) return {text: '', thinking: true};
                return {text, thinking: false};
            }
        """)

        text, thinking = result["text"], result["thinking"]

        if thinking:
            stable_ticks = 0
        elif text and len(text) > len(last_text):
            on_text(text[len(last_text):])
            last_text = text
            stable_ticks = 0
        elif len(last_text) > 0:
            stable_ticks += 1

        elapsed = (time.time() - start_time) * 1000
        if len(last_text) > 0 and stable_ticks >= STABLE_LIMIT:
            console.print(f"[dim][stream] stable after {elapsed:.0f}ms ({len(last_text)} chars)[/dim]")
            on_done()
            return last_text
        if elapsed > HARD_TIMEOUT_MS:
            console.print(f"[yellow][stream] hard timeout at {elapsed:.0f}ms[/yellow]")
            on_done()
            return last_text

        await asyncio.sleep(POLL_MS / 1000)


async def scrape_chat_list():
    return await page.evaluate("""
        () => {
            const selectors = ['.chat-list-item', '[class*="chat-history"] [class*="item"]', 'a[href*="/c/"]'];
            const seen = new Set();
            const out = [];
            for (const sel of selectors) {
                document.querySelectorAll(sel).forEach(el => {
                    const href = el.getAttribute('href') || '';
                    const m = href.match(/\\/c\\/([a-f0-9-]+)/i);
                    if (!m) return;
                    const id = m[1];
                    if (seen.has(id)) return;
                    seen.add(id);
                    const title = (el.textContent || '').trim().slice(0, 120);
                    out.push({id, title, preview: title});
                });
                if (out.length > 0) break;
            }
            return out.slice(0, 50);
        }
    """)


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="Qwen Chat Proxy")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {
        "status": "ok" if ready else "booting",
        "uptime_s": int(time.time() - state.started_at),
        "requests_handled": state.requests_handled,
        "browser_url": page.url if page else None,
        "current_chat": state.chat["current_chat_id"],
        "mode": state.chat["mode"],
    }


@app.get("/v1/models")
async def models():
    return {
        "object": "list",
        "data": [
            {"id": "qwen3.7-plus", "object": "model", "created": 1732711466, "owned_by": "qwen", "permission": [], "root": "qwen3.7-plus", "parent": None},
            {"id": "qwen3.8-max", "object": "model", "created": 1732711466, "owned_by": "qwen", "permission": [], "root": "qwen3.8-max", "parent": None},
        ],
    }


@app.get("/v1/chats")
async def chats_list():
    if not ready:
        return JSONResponse({"error": "not ready"}, status_code=503)
    async with page_lock:
        chats = await scrape_chat_list()
    return {"object": "list", "data": chats, "current": state.chat["current_chat_id"]}


@app.post("/v1/chats/select")
async def chats_select(request: Request):
    body = await request.json()
    chat_id = body.get("chat_id") or body.get("id")
    if not chat_id:
        return JSONResponse({"error": "chat_id required"}, status_code=400)
    async with page_lock:
        await navigate_to_chat(chat_id)
    state.chat["first_user_message_hash"] = None
    state.chat["last_user_message"] = None
    return {"ok": True, "chat_id": chat_id, "url": state.chat["current_chat_url"]}


@app.post("/v1/chats/new")
async def chats_new():
    async with page_lock:
        await click_new_chat()
    return {"ok": True, "message": "New chat ready."}


@app.get("/v1/state")
async def state_get():
    return {
        "chat": state.chat,
        "ready": ready,
        "uptime_s": int(time.time() - state.started_at),
        "requests_handled": state.requests_handled,
        "browser_url": page.url if page else None,
    }


@app.post("/v1/state")
async def state_set(request: Request):
    body = await request.json()
    if "mode" in body:
        state.chat["mode"].update(body["mode"])
    if "model" in body:
        state.chat["model"] = map_model(body["model"])
    return {"ok": True, "chat": state.chat}


@app.get("/v1/logs")
async def logs(limit: int = 100, type: str = None):
    logs = list(reversed(state.logs))
    if type:
        logs = [l for l in logs if l["type"] == type]
    return {"object": "list", "data": logs[:limit], "total": len(state.logs)}


@app.get("/v1/analytics")
async def analytics():
    chat_logs = [l for l in state.logs if l["type"] == "chat"]
    error_logs = [l for l in state.logs if l["type"] == "error"]
    tokens_in = sum(l.get("tokensIn", 0) for l in chat_logs)
    tokens_out = sum(l.get("tokensOut", 0) for l in chat_logs)
    continuations = sum(1 for l in chat_logs if l.get("isContinuation"))
    new_chats = sum(1 for l in chat_logs if not l.get("isContinuation"))
    return {
        "totals": {
            "requests": state.requests_handled,
            "chat_requests": len(chat_logs),
            "errors": len(error_logs),
            "new_chats": new_chats,
            "continuations": continuations,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "total_tokens": tokens_in + tokens_out,
            "avg_duration_ms": sum(l.get("durationMs", 0) for l in chat_logs) // max(len(chat_logs), 1),
            "uptime_s": int(time.time() - state.started_at),
        },
        "by_model": [],
        "hourly": [],
        "mode": state.chat["mode"],
        "current_chat": state.chat["current_chat_id"],
    }


async def execute_send(prompt, desired_mode, is_new_chat, first_msg_hash, last_user_content, model):
    state.chat["mode"] = desired_mode
    if is_new_chat:
        await click_new_chat()
    else:
        cid = state.chat["current_chat_id"]
        if cid and f"/c/{cid}" not in page.url:
            await navigate_to_chat(cid)

    existing_count = await page.evaluate("document.querySelectorAll('.qwen-chat-message-assistant').length")
    await fill_and_send(prompt)

    if is_new_chat:
        try:
            await page.wait_for_url(r".*/c/[a-f0-9-]+", timeout=10000)
            await page.wait_for_timeout(1000)
        except:
            pass
        new_id = extract_chat_id_from_url()
        if new_id:
            state.chat["current_chat_id"] = new_id
            state.chat["first_user_message_hash"] = first_msg_hash

    state.chat["last_user_message"] = last_user_content
    state.chat["model"] = model
    return existing_count


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    global state
    state.requests_handled += 1
    if not ready:
        return JSONResponse({"error": {"message": "Proxy not ready"}}, status_code=503)

    body = await request.json()
    model = map_model(body.get("model"))
    messages = body.get("messages", [])
    stream = body.get("stream", True)

    desired_mode = {
        "thinking": body.get("extra", {}).get("thinking", body.get("thinking", state.chat["mode"]["thinking"])),
        "search": body.get("extra", {}).get("search", body.get("search", state.chat["mode"]["search"])),
        "deep_research": body.get("extra", {}).get("deep_research", body.get("deep_research", state.chat["mode"]["deep_research"])),
    }

    if not messages:
        return JSONResponse({"error": {"message": "messages required"}}, status_code=400)

    user_msgs = [m for m in messages if m["role"] == "user"]
    first_user_content = user_msgs[0]["content"] if user_msgs else ""
    last_user_content = user_msgs[-1]["content"] if user_msgs else ""
    first_msg_hash = simple_hash(first_user_content)

    is_continuation = (
        state.chat["current_chat_id"] is not None
        and state.chat["first_user_message_hash"] == first_msg_hash
        and state.chat["last_user_message"] != last_user_content
    )
    is_new_chat = not is_continuation
    prompt_to_send = first_user_content if is_new_chat else last_user_content

    console.print(f"[cyan][req #{state.requests_handled}][/cyan] model={model} msgs={len(messages)} stream={stream} continuation={is_continuation}")

    completion_id = f"chatcmpl-{uuid.uuid4().hex[:10]}"
    created = int(time.time())
    start_time = time.time()

    def make_chunk(delta=None, finish_reason=None, error=None):
        chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish_reason}],
        }
        if error:
            chunk["error"] = {"message": error}
        return f"data: {json.dumps(chunk)}\n\n"

    if stream:
        async def generate():
            yield make_chunk({"role": "assistant"})
            full_text = ""
            try:
                async with page_lock:
                    existing = await execute_send(prompt_to_send, desired_mode, is_new_chat, first_msg_hash, last_user_content, model)
                    full_text = await stream_response(
                        lambda delta: None,  # We yield directly below
                        lambda: None,
                        existing,
                    )
                    # Re-stream the full text as a single chunk (simpler than live streaming)
                    if full_text:
                        yield make_chunk({"content": full_text})
                yield make_chunk(finish_reason="stop")
                yield "data: [DONE]\n\n"
                state.add_log({
                    "type": "chat", "model": model,
                    "chatId": state.chat["current_chat_id"],
                    "prompt": prompt_to_send[:200],
                    "response": full_text[:200],
                    "durationMs": int((time.time() - start_time) * 1000),
                    "mode": desired_mode, "isContinuation": is_continuation,
                    "tokensIn": len(prompt_to_send) // 4,
                    "tokensOut": len(full_text) // 4,
                })
            except Exception as e:
                state.add_log({"type": "error", "error": str(e), "prompt": prompt_to_send[:200]})
                yield make_chunk(finish_reason="stop", error=str(e))
                yield "data: [DONE]\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
        })

    # Non-streaming
    full_text = ""
    try:
        async with page_lock:
            existing = await execute_send(prompt_to_send, desired_mode, is_new_chat, first_msg_hash, last_user_content, model)
            full_text = await stream_response(lambda d: None, lambda: None, existing)
    except Exception as e:
        state.add_log({"type": "error", "error": str(e), "prompt": prompt_to_send[:200]})
        return JSONResponse({"error": {"message": str(e)}}, status_code=502)

    state.add_log({
        "type": "chat", "model": model,
        "chatId": state.chat["current_chat_id"],
        "prompt": prompt_to_send[:200], "response": full_text[:200],
        "durationMs": int((time.time() - start_time) * 1000),
        "mode": desired_mode, "isContinuation": is_continuation,
        "tokensIn": len(prompt_to_send) // 4, "tokensOut": len(full_text) // 4,
    })
    return {
        "id": completion_id, "object": "chat.completion", "created": created, "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": full_text}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": len(prompt_to_send) // 4, "completion_tokens": len(full_text) // 4,
                  "total_tokens": (len(prompt_to_send) + len(full_text)) // 4},
    }


# ---------------------------------------------------------------------------
# CLI Dashboard
# ---------------------------------------------------------------------------
def show_dashboard():
    base_url = f"http://localhost:{PORT}/v1"
    api_key = "sk-qwen-local"  # Python proxy doesn't check auth

    table = Table(show_header=False, box=None, padding=(0, 2))
    table.add_column("Key", style="cyan", no_wrap=True)
    table.add_column("Value", style="white")
    table.add_row("Base URL", base_url)
    table.add_row("API Key", api_key)
    table.add_row("Models", "qwen3.7-plus, qwen3.8-max")
    table.add_row("Status", "✓ Online" if ready else "… Booting")
    table.add_row("Active Chat", state.chat["current_chat_id"] or "None")
    table.add_row("Mode", f"thinking={state.chat['mode']['thinking']} search={state.chat['mode']['search']}")
    table.add_row("Requests", str(state.requests_handled))
    table.add_row("Uptime", f"{int(time.time() - state.started_at)}s")

    console.print(Panel(table, title="[bold]Qwen Chat Proxy[/bold]", border_style="emerald"))
    console.print("\n[bold green]Cline Setup:[/bold green]")
    console.print(f"  API Provider: [cyan]OpenAI Compatible[/cyan]")
    console.print(f"  Base URL:     [cyan]{base_url}[/cyan]")
    console.print(f"  API Key:      [cyan]{api_key}[/cyan]")
    console.print(f"  Model:        [cyan]qwen3.7-plus[/cyan]")
    console.print(f"\n[dim]Test: curl -N {base_url}/chat/completions -H 'Content-Type: application/json' -d '{{\"model\":\"qwen3.7-plus\",\"messages\":[{{\"role\":\"user\",\"content\":\"Hi\"}}]}}'[/dim]")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
async def main():
    console.print(Panel.fit("[bold emerald]Qwen Chat Proxy[/bold emerald]\nOpenAI-compatible API for chat.qwen.ai", border_style="emerald"))

    # Bootstrap browser
    await bootstrap_browser()

    # Show dashboard
    console.print()
    show_dashboard()
    console.print()

    # Start server
    config = uvicorn.Config(app, host="0.0.0.0", port=PORT, log_level="warning")
    server = uvicorn.Server(config)

    console.print(f"[bold green]🚀 Server running on http://localhost:{PORT}[/bold green]")
    console.print(f"[dim]Press Ctrl+C to stop[/dim]\n")

    await server.serve()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        console.print("\n[yellow]Shutting down…[/yellow]")
