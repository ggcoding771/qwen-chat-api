/**
 * Qwen Chat Proxy — OpenAI-compatible API gateway for chat.qwen.ai
 *
 * - Drives a persistent Playwright browser to satisfy Baxia anti-bot
 * - Exposes POST /v1/chat/completions (OpenAI shape, SSE streaming)
 * - Exposes GET /v1/models
 * - Exposes GET /health
 *
 * Port: 3030 (fixed)
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { chromium, type BrowserContext, type Page } from 'playwright'

const PORT = 3030
const QWEN_HOME = 'https://chat.qwen.ai'
const QWEN_AUTH = 'https://chat.qwen.ai/auth'

const QWEN_EMAIL = process.env.QWEN_EMAIL || ''
const QWEN_PASSWORD = process.env.QWEN_PASSWORD || ''

if (!QWEN_EMAIL || !QWEN_PASSWORD) {
  console.error('[FATAL] QWEN_EMAIL / QWEN_PASSWORD env vars are required.')
  process.exit(1)
}

// Map common OpenAI model names -> Qwen model ids
const MODEL_MAP: Record<string, string> = {
  'qwen3.7-plus': 'qwen3.7-plus',
  'qwen3.8-max': 'qwen3.8-max',
  'qwen-plus': 'qwen3.7-plus',
  'qwen-max': 'qwen3.8-max',
  'gpt-4': 'qwen3.7-plus',
  'gpt-4o': 'qwen3.7-plus',
  'gpt-3.5-turbo': 'qwen3.7-plus',
  default: 'qwen3.7-plus',
}

const BROWSER_DATA_DIR = `${import.meta.dir}/.browser-data`
const STORAGE_STATE_PATH = `${import.meta.dir}/storage-state.json`

let context: BrowserContext | null = null
let page: Page | null = null
let ready = false

// ---------------------------------------------------------------------------
// Browser bootstrap + login
// ---------------------------------------------------------------------------
async function bootstrapBrowser() {
  console.log('[boot] launching persistent chromium context…')
  context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1366, height: 768 },
  })

  page = await context.newPage()
  // Forward page console logs to Node stdout for debugging
  page.on('console', (msg) => {
    const t = msg.type()
    if (t === 'error' || t === 'warning' || t === 'log') {
      console.log(`[page:${t}] ${msg.text()}`)
    }
  })
  page.on('pageerror', (err) => console.log('[pageerror]', err.message))

  await page.goto(QWEN_HOME, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  // Detect login state by hitting /api/v1/auths/ (200 => logged in)
  const authed = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auths/', { credentials: 'include' })
    return r.status === 200
  })

  if (!authed) {
    console.log('[boot] not authenticated — performing login…')
    await performLogin()
  } else {
    console.log('[boot] already authenticated.')
  }

  // Make sure we land on the home page so Baxia hooks are active.
  if (!page.url().startsWith(QWEN_HOME) || page.url().includes('/auth')) {
    await page.goto(QWEN_HOME, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
  }

  ready = true
  console.log('[boot] proxy ready.')
}

async function performLogin() {
  if (!page || !context) throw new Error('page/context missing for login')

  await page.goto(QWEN_AUTH, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  // Fill email + password
  await page.getByPlaceholder('Enter Your Email').fill(QWEN_EMAIL)
  await page.getByPlaceholder('Enter Your Password').fill(QWEN_PASSWORD)
  await page.waitForTimeout(500)

  // Click "Sign in"
  const signInBtn = page.getByRole('button', { name: 'Sign in' })
  await signInBtn.click()

  // Wait for either success (redirect to home) or error message
  try {
    await Promise.race([
      page.waitForURL(QWEN_HOME, { timeout: 30000 }),
      page.waitForSelector('text=incorrect', { timeout: 30000 }),
      page.waitForSelector('text=Invalid', { timeout: 30000 }),
    ])
  } catch {
    // ignore timeout — we'll verify via auth endpoint below
  }

  await page.waitForTimeout(2500)

  const authed = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auths/', { credentials: 'include' })
    return r.status === 200
  })

  if (!authed) {
    const body = await page.content()
    throw new Error('Login failed — check credentials or captcha. Page snippet: ' + body.slice(0, 500))
  }

  // Persist storage state for fast restart
  await context.storageState({ path: STORAGE_STATE_PATH })
  console.log('[boot] login successful; storage state saved.')
}

// ---------------------------------------------------------------------------
// Chat helpers — executed inside the page so Baxia hooks the fetch
// ---------------------------------------------------------------------------

async function createChatId(): Promise<string> {
  if (!page) throw new Error('page not ready')
  // First check Baxia readiness — if not initialized, the protected-path
  // fetch will hang silently because the bx-* token can't be generated.
  const baxiaState = await page.evaluate(() => {
    const w = window as any
    const hasBaxiaCommon = !!w.baxiaCommon
    const hasBaxiaModule = !!(w.__baxia__ && w.__baxia__.baxiaPromptInit)
    const initialized = !!w.baxiaInitialized
    let uidToken: string | null = null
    try {
      uidToken = w.__baxia__?.getFYModule?.getUidToken?.() || null
    } catch (e) {
      uidToken = 'ERR:' + String(e)
    }
    return { hasBaxiaCommon, hasBaxiaModule, initialized, uidToken }
  })
  console.log('[createChat] baxia state:', JSON.stringify(baxiaState))

  // POST /api/v2/chats/new — the actual create endpoint found in the bundle.
  const result = await page.evaluate(async () => {
    console.log('[createChat] starting fetch to /api/v2/chats/new…')
    const startedAt = Date.now()
    try {
      const res = await fetch('/api/v2/chats/new', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat: {
            title: 'API',
            models: ['qwen3.7-plus'],
            chat_type: 't2t',
            chat_mode: 'normal',
          },
        }),
      })
      const elapsed = Date.now() - startedAt
      console.log('[createChat] fetch returned status=' + res.status + ' after ' + elapsed + 'ms')
      const text = await res.text()
      console.log('[createChat] body length=' + text.length + ' preview=' + text.slice(0, 200))
      return { status: res.status, body: text }
    } catch (e: any) {
      console.log('[createChat] fetch threw: ' + String(e?.message || e))
      throw e
    }
  })
  if (result.status >= 400) {
    throw new Error(`createChat failed ${result.status}: ${result.body}`)
  }
  let json: any
  try {
    json = JSON.parse(result.body)
  } catch {
    throw new Error(`createChat bad JSON: ${result.body}`)
  }
  const chatId = json?.data?.id
  if (!chatId) throw new Error(`createChat: missing data.id in ${result.body}`)
  return chatId
}

interface QwenMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  chat_type?: string
  sub_chat_type?: string
  feature_config?: any
}

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

function mapModel(openaiModel: string | undefined): string {
  if (!openaiModel) return MODEL_MAP.default
  return MODEL_MAP[openaiModel] || MODEL_MAP.default
}

function buildQwenRequest(opts: {
  model: string
  messages: OpenAIMessage[]
  chatId: string
  stream: boolean
}) {
  const messages: QwenMessage[] = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
    chat_type: 't2t',
    sub_chat_type: 'thinking',
    feature_config: {
      thinking_enabled: true,
      auto_thinking: true,
      thinking_format: 'summary',
    },
  }))

  return {
    chat_id: opts.chatId,
    model: opts.model,
    chat_type: 't2t',
    sub_chat_type: 'thinking',
    messages,
    models: [opts.model],
    user_action: '',
    feature_config: {
      thinking_enabled: true,
      auto_thinking: true,
      thinking_format: 'summary',
    },
    extra: {},
    timestamp: Math.floor(Date.now() / 1000),
    stream_options: { include_usage: true },
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJSON(res: ServerResponse, status: number, body: any) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function makeChunk(obj: any): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function generateId() {
  return 'chatcmpl-' + Math.random().toString(36).slice(2, 12)
}

interface ProxyState {
  startedAt: number
  requestsHandled: number
  lastError?: string
}

const state: ProxyState = { startedAt: Date.now(), requestsHandled: 0 }

async function handleChatCompletions(req: IncomingMessage, res: ServerResponse) {
  state.requestsHandled++
  console.log(`[req #${state.requestsHandled}] /v1/chat/completions received`)
  if (!ready || !page) {
    return sendJSON(res, 503, { error: { message: 'Proxy not ready', type: 'proxy_error' } })
  }

  const raw = await readBody(req)
  console.log(`[req #${state.requestsHandled}] body bytes:`, raw.length)
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return sendJSON(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } })
  }

  const model = mapModel(parsed.model)
  const messages: OpenAIMessage[] = Array.isArray(parsed.messages) ? parsed.messages : []
  const stream = parsed.stream !== false // default true
  console.log(`[req #${state.requestsHandled}] model=${model} msgs=${messages.length} stream=${stream}`)

  if (messages.length === 0) {
    return sendJSON(res, 400, { error: { message: 'messages is required', type: 'invalid_request' } })
  }

  // Build a single prompt to send through the UI. For multi-turn, fold prior
  // context into the user message so Qwen has it (Qwen's UI doesn't expose a
  // raw messages array — each "New Chat" + send is one fresh turn).
  const prompt = buildPromptFromMessages(messages)
  const completionId = generateId()
  const created = Math.floor(Date.now() / 1000)

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    })

    // Initial role chunk (OpenAI convention)
    res.write(
      makeChunk({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })
    )

    try {
      await sendViaUI({
        prompt,
        onText: (text) => {
          res.write(
            makeChunk({
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            })
          )
        },
        onDone: () => {
          res.write(
            makeChunk({
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })
          )
          res.write('data: [DONE]\n\n')
          res.end()
        },
      })
    } catch (e: any) {
      state.lastError = e.message
      console.log(`[req #${state.requestsHandled}] sendViaUI FAILED: ${e.message}`)
      res.write(
        makeChunk({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          error: { message: e.message },
        })
      )
      res.write('data: [DONE]\n\n')
      res.end()
    }
    return
  }

  // Non-streaming path
  let fullText = ''
  try {
    await sendViaUI({
      prompt,
      onText: (t) => (fullText += t),
      onDone: () => {},
    })
  } catch (e: any) {
    return sendJSON(res, 502, { error: { message: 'Qwen stream error: ' + e.message, type: 'upstream_error' } })
  }

  return sendJSON(res, 200, {
    id: completionId,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: fullText },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
}

/**
 * Fold an OpenAI messages array into a single user prompt for the Qwen UI.
 * System messages become a preamble; alternating turns are rendered as a
 * transcript so the model has multi-turn context.
 */
function buildPromptFromMessages(messages: OpenAIMessage[]): string {
  if (messages.length === 1) return messages[0].content
  const parts: string[] = []
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  if (system) parts.push(`[System]\n${system}`)
  const turns = messages.filter((m) => m.role !== 'system')
  for (const m of turns) {
    const label = m.role === 'user' ? 'User' : 'Assistant'
    parts.push(`[${label}]\n${m.content}`)
  }
  if (turns.length && turns[turns.length - 1].role !== 'user') {
    parts.push('[User]\n(please continue)')
  }
  return parts.join('\n\n')
}

/**
 * UI-driven sender. Drives the Qwen React UI to type a prompt and click
 * Send, then polls the assistant response DOM element, emitting incremental
 * deltas. This is the only reliable path because Baxia's anti-bot tokens
 * are only attached to axios requests made by the Qwen app itself — native
 * fetch() from page.evaluate hangs server-side.
 *
 * Concurrent calls are serialized via `pageMutex` because there is only one
 * browser page — running two chats in parallel would corrupt the DOM state.
 */
const pageMutex = new (class {
  private chain: Promise<unknown> = Promise.resolve()
  acquire<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    // Even if fn rejects, the chain keeps going.
    this.chain = run.catch(() => {})
    return run
  }
})()

async function sendViaUI(opts: {
  prompt: string
  onText: (delta: string) => void
  onDone: () => void
}) {
  if (!page) throw new Error('page not available')

  return pageMutex.acquire(() => sendViaUILocked(opts))
}

async function sendViaUILocked(opts: {
  prompt: string
  onText: (delta: string) => void
  onDone: () => void
}) {
  if (!page) throw new Error('page not available')

  // 1. Start a fresh chat (clears prior context).
  console.log('[sendViaUI] clicking New Chat…')
  try {
    await page.getByRole('button', { name: 'New Chat' }).click({ timeout: 5000 })
    await page.waitForTimeout(1200)
  } catch {
    console.log('[sendViaUI] New Chat button not found — assuming fresh state')
  }

  // 2. Fill the input box — re-query the locator, clear, then type.
  const input = page.getByPlaceholder('Ask Qwen')
  await input.click()
  await page.waitForTimeout(150)
  // Clear any leftover content (Ctrl+A → Delete is most reliable)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(100)
  await input.fill(opts.prompt)
  await page.waitForTimeout(300)

  // Verify the input actually contains our prompt.
  const value = await input.inputValue().catch(() => '')
  if (value !== opts.prompt) {
    console.log(`[sendViaUI] input value mismatch (got "${value.slice(0, 60)}"), retrying…`)
    await input.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.waitForTimeout(100)
    // Type character-by-character as a last resort
    await input.pressSequentially(opts.prompt, { delay: 5 })
    await page.waitForTimeout(300)
    const v2 = await input.inputValue().catch(() => '')
    if (v2 !== opts.prompt) {
      throw new Error(`failed to fill input (got "${v2.slice(0, 60)}")`)
    }
  }

  // 3. Wait for Send button to be enabled, then click it.
  console.log('[sendViaUI] clicking Send…')
  const sendBtn = page.getByRole('button', { name: 'Send' })
  await sendBtn.waitFor({ state: 'visible', timeout: 5000 })
  // Best-effort: wait for enabled (Playwright auto-waits click)
  await sendBtn.click({ timeout: 5000 })

  // 4. Wait for the assistant message container to appear.
  try {
    await page.waitForSelector('.qwen-chat-message-assistant', { timeout: 15000 })
  } catch {
    throw new Error('assistant message did not appear within 15s')
  }

  // 5. Poll the answer-phase text for streaming deltas.
  let lastText = ''
  let stableTicks = 0
  const startTime = Date.now()
  const POLL_MS = 150
  const STABLE_LIMIT = 14 // ~2.1s of no change
  const HARD_TIMEOUT_MS = 120000

  await new Promise<void>((resolve) => {
    const poll = async () => {
      try {
        const text = await page!.evaluate(() => {
          const sel = [
            '.response-message-content.phase-answer .custom-qwen-markdown',
            '.response-message-content.phase-answer',
            '.qwen-chat-message-assistant .custom-qwen-markdown',
            '.qwen-chat-message-assistant .response-message-content',
          ]
          for (const s of sel) {
            const el = document.querySelector(s)
            if (el && el.textContent && el.textContent.trim()) {
              return el.textContent
            }
          }
          return ''
        })

        if (text && text.length > lastText.length) {
          const delta = text.slice(lastText.length)
          opts.onText(delta)
          lastText = text
          stableTicks = 0
        } else if (lastText.length > 0) {
          stableTicks++
        }

        const elapsed = Date.now() - startTime
        if (lastText.length > 0 && stableTicks >= STABLE_LIMIT) {
          console.log(`[sendViaUI] stream stable after ${elapsed}ms (${lastText.length} chars)`)
          opts.onDone()
          resolve()
          return
        }
        if (elapsed > HARD_TIMEOUT_MS) {
          console.log(`[sendViaUI] hard timeout at ${elapsed}ms`)
          opts.onDone()
          resolve()
          return
        }
      } catch (e: any) {
        console.log('[sendViaUI] poll error:', e.message)
      }
      setTimeout(poll, POLL_MS)
    }
    setTimeout(poll, POLL_MS)
  })
}

/**
 * Streams Qwen's SSE response by evaluating fetch() inside the page
 * (so Baxia can attach its anti-bot headers). Chunks are pushed back
 * to Node via a window-exposed callback.
 *
 * NOTE: any helper used inside page.evaluate must be inlined or
 * serialized — the browser has no access to Node-scope functions.
 */
async function streamQwenResponse(opts: {
  chatId: string
  body: any
  onText: (text: string) => void
  onDone: () => void
}) {
  if (!page) throw new Error('page not available')

  const callbackName = '__qwenChunk_' + Math.random().toString(36).slice(2, 10)
  let doneFired = false

  await page.exposeFunction(callbackName, (payload: { text: string; done: boolean; error?: string }) => {
    if (payload.error) opts.onText(`\n[error: ${payload.error}]`)
    if (payload.text) opts.onText(payload.text)
    if (payload.done && !doneFired) {
      doneFired = true
      opts.onDone()
    }
  })

  console.log(`[stream] chatId=${opts.chatId} starting fetch…`)

  try {
    await page.evaluate(
      async ({ cbName, chatId, body }) => {
        const cb = (window as any)[cbName]
        const decoder = new TextDecoder()

        // Inlined answer-delta extractor (browser scope).
        const extractAnswer = (json: any): string => {
          if (!json || typeof json !== 'object') return ''
          const choices = json.choices
          if (Array.isArray(choices) && choices[0]?.delta?.content) {
            return choices[0].delta.content
          }
          let out = ''
          const cl = json.content_list
          if (Array.isArray(cl)) {
            for (const item of cl) {
              if (item?.phase === 'answer' && typeof item.content === 'string') {
                out += item.content
              }
            }
          }
          if (out) return out
          if (typeof json.content === 'string') return json.content
          return ''
        }

        try {
          const res = await fetch(`/api/v2/chat/completions?chat_id=${encodeURIComponent(chatId)}`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'X-Accel-Buffering': 'no',
            },
            body: JSON.stringify(body),
          })

          console.log('[stream] fetch status:', res.status, 'ok:', res.ok)

          if (!res.ok || !res.body) {
            const errText = await res.text().catch(() => '')
            console.log('[stream] error body:', errText.slice(0, 300))
            cb({ done: true, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` })
            return
          }

          const reader = res.body.getReader()
          let buffer = ''
          let chunkCount = 0

          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            const raw = decoder.decode(value, { stream: true })
            buffer += raw
            chunkCount++
            if (chunkCount <= 3) {
              console.log('[stream] raw chunk #' + chunkCount + ' (len=' + raw.length + '):', raw.slice(0, 200))
            }

            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith('data:')) continue
              const payload = trimmed.slice(5).trim()
              if (payload === '[DONE]') {
                console.log('[stream] got [DONE]')
                cb({ done: true })
                return
              }
              try {
                const json = JSON.parse(payload)
                const text = extractAnswer(json)
                if (text) cb({ text })
              } catch {
                // non-JSON keep-alive
              }
            }
          }
          console.log('[stream] stream ended; total chunks=' + chunkCount)
          cb({ done: true })
        } catch (e: any) {
          console.log('[stream] exception:', String(e?.message || e))
          cb({ done: true, error: String(e?.message || e) })
        }
      },
      { cbName: callbackName, chatId: opts.chatId, body: opts.body }
    )

    if (!doneFired) {
      doneFired = true
      opts.onDone()
    }
  } finally {
    try {
      await page.evaluate((cbName: string) => {
        delete (window as any)[cbName]
      }, callbackName)
    } catch {
      /* ignore */
    }
  }
}

// Extract incremental text from a Qwen SSE chunk.
function extractAnswerDelta(json: any): string {
  if (!json || typeof json !== 'object') return ''
  // OpenAI-style delta
  const choices = json.choices
  if (Array.isArray(choices) && choices[0]?.delta?.content) {
    return choices[0].delta.content
  }
  // Qwen content_list phases
  const contentList = json.content_list
  let out = ''
  if (Array.isArray(contentList)) {
    for (const item of contentList) {
      if (item?.phase === 'answer' && typeof item.content === 'string') {
        out += item.content
      }
    }
  }
  if (out) return out
  // Fallback: top-level content
  if (typeof json.content === 'string') return json.content
  return ''
}

// ---------------------------------------------------------------------------
// /v1/models, /health
// ---------------------------------------------------------------------------
async function handleModels(res: ServerResponse) {
  return sendJSON(res, 200, {
    object: 'list',
    data: [
      {
        id: 'qwen3.7-plus',
        object: 'model',
        created: 1732711466,
        owned_by: 'qwen',
        permission: [],
        root: 'qwen3.7-plus',
        parent: null,
      },
      {
        id: 'qwen3.8-max',
        object: 'model',
        created: 1732711466,
        owned_by: 'qwen',
        permission: [],
        root: 'qwen3.8-max',
        parent: null,
      },
    ],
  })
}

function handleHealth(res: ServerResponse) {
  return sendJSON(res, 200, {
    status: ready ? 'ok' : 'booting',
    uptime_s: Math.floor((Date.now() - state.startedAt) / 1000),
    requests_handled: state.requestsHandled,
    last_error: state.lastError || null,
    browser_url: page?.url() || null,
  })
}

// Debug endpoint: drives the UI to send a message and returns the DOM snapshot.
async function handleDebugSend(req: IncomingMessage, res: ServerResponse) {
  if (!ready || !page) return sendJSON(res, 503, { error: 'not ready' })
  const raw = await readBody(req)
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = {}
  }
  const msg = parsed.message || 'Hello'
  try {
    // Click New Chat
    await page.getByRole('button', { name: 'New Chat' }).click({ timeout: 5000 }).catch(() => {})
    await page.waitForTimeout(500)
    // Fill input
    await page.getByPlaceholder('Ask Qwen').fill(msg)
    await page.waitForTimeout(300)
    // Click Send
    await page.getByRole('button', { name: 'Send' }).click({ timeout: 5000 })
    // Wait longer for the assistant message to fully stream
    await page.waitForTimeout(9000)
    // Capture the DOM structure of the main area
    const domInfo = await page.evaluate(() => {
      const main = document.querySelector('main')
      if (!main) return { error: 'no main element' }
      // Walk the tree and gather text + class info up to depth 10
      const walk = (el: Element, depth: number): any => {
        if (depth > 10) return null
        const tag = el.tagName.toLowerCase()
        const cls = el.className || ''
        const role = el.getAttribute('role') || ''
        const text = el.textContent || ''
        const children: any[] = []
        for (const c of Array.from(el.children)) {
          const r = walk(c, depth + 1)
          if (r) children.push(r)
        }
        return {
          tag,
          cls: typeof cls === 'string' ? cls.slice(0, 120) : '',
          role,
          text: text.slice(0, 300),
          childCount: el.children.length,
          children: children.slice(0, 12),
        }
      }
      // Also: dump every element with a class containing 'message' or 'markdown'
      const matches: any[] = []
      main.querySelectorAll('*').forEach((el) => {
        const cls = (typeof el.className === 'string' ? el.className : '') || ''
        if (/message|markdown|answer|response|content-body/i.test(cls)) {
          matches.push({
            cls: cls.slice(0, 200),
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || '').slice(0, 300),
            childCount: el.children.length,
          })
        }
      })
      return { tree: walk(main, 0), messageElements: matches.slice(0, 30) }
    })
    return sendJSON(res, 200, { ok: true, message: msg, dom: domInfo })
  } catch (e: any) {
    return sendJSON(res, 500, { error: e.message })
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    })
    return res.end()
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/health') return handleHealth(res)
    if (req.method === 'GET' && url.pathname === '/v1/models') return handleModels(res)
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions')
      return await handleChatCompletions(req, res)
    if (req.method === 'POST' && url.pathname === '/debug/send')
      return await handleDebugSend(req, res)
    sendJSON(res, 404, { error: { message: `No route for ${req.method} ${url.pathname}` } })
  } catch (e: any) {
    console.error('[server] unhandled:', e)
    state.lastError = e.message
    if (!res.headersSent) sendJSON(res, 500, { error: { message: e.message } })
    else res.end()
  }
})

server.listen(PORT, async () => {
  console.log(`[qwen-proxy] HTTP server on :${PORT}`)
  try {
    await bootstrapBrowser()
  } catch (e: any) {
    console.error('[boot] FAILED:', e)
    state.lastError = e.message
    // Keep server alive so /health can report the error
  }
})

// Graceful shutdown
const shutdown = async (sig: string) => {
  console.log(`\n[${sig}] shutting down…`)
  try {
    await context?.close()
  } catch {}
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Prevent crashes from unhandled rejections (e.g. client aborts mid-stream).
process.on('unhandledRejection', (reason) => {
  console.log('[unhandledRejection]', String(reason).slice(0, 200))
})
process.on('uncaughtException', (err) => {
  console.log('[uncaughtException]', err.message.slice(0, 200))
})
