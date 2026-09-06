# Qwen Chat Proxy — Standalone Python

An OpenAI-compatible API proxy for chat.qwen.ai. Drives a real browser session (via Playwright) to satisfy Baxia anti-bot.

## Quick Start

```bash
cd mini-services/qwen-python
pip install -r requirements.txt
playwright install chromium
python qwen_proxy.py
```

On first run, it will ask for your Qwen email + password and save them to `.env`.

## Using with Cline (VS Code)

1. Open Cline settings in VS Code
2. API Provider: **OpenAI Compatible**
3. Base URL: `http://localhost:3031/v1`
4. API Key: `sk-qwen-local`
5. Model: `qwen3.7-plus` or `qwen3.8-max`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | OpenAI-compatible chat (streaming + non-streaming) |
| GET | `/v1/models` | List available models |
| GET | `/v1/chats` | List recent Qwen chats |
| POST | `/v1/chats/select` | Switch active chat |
| POST | `/v1/chats/new` | Start a new chat |
| GET | `/v1/state` | Get current mode + active chat |
| POST | `/v1/state` | Update mode toggles |
| GET | `/v1/logs` | Request history |
| GET | `/v1/analytics` | Token usage stats |
| GET | `/health` | Health check |

## Chat Continuity

The proxy automatically detects conversation continuations:
- Same first user message → continues the same Qwen chat
- New first user message → starts a new Qwen chat
- Works automatically with Cline (no special configuration needed)

## Test with curl

```bash
# Streaming
curl -N http://localhost:3031/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"Hi"}]}'

# Non-streaming
curl -X POST http://localhost:3031/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3.7-plus","messages":[{"role":"user","content":"Hi"}],"stream":false}'
```
