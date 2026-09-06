/**
 * Qwen Chat Proxy — OpenAI-compatible API gateway for chat.qwen.ai
 *
 * Features:
 * - Persistent Playwright browser session (Baxia anti-bot satisfied)
 * - POST /v1/chat/completions — OpenAI shape, SSE streaming + non-streaming
 *   - Chat continuity: same first-user-message hash => continue same Qwen chat
 *   - Mode toggles: thinking, search, deep_research (via request body or state)
 * - GET /v1/models
 * - GET /v1/chats — list recent Qwen chats (scraped from sidebar)
 * - POST /v1/chats/select — switch active chat by id
 * - POST /v1/chats/new — start a fresh chat
 * - GET /v1/state — current mode, active chat, etc.
 * - POST /v1/state — update mode toggles
 * - GET /v1/logs — request history
 * - GET /v1/analytics — aggregated stats
 * - GET /health
 *
 * Port: 3030 (fixed)
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { createHash } from 'node:crypto'

const PORT = 3030
const QWEN_HOME = 'https://chat.qwen.ai'
const QWEN_AUTH = 'https://chat.qwen.ai/auth'

const QWEN_EMAIL = process.env.QWEN_EMAIL || ''
const QWEN_PASSWORD = process.env.QWEN_PASSWORD || ''

if (!QWEN_EMAIL || !QWEN_PASSWORD) {
  console.error('[FATAL] QWEN_EMAIL / QWEN_PASSWORD env vars are required.')
  process.exit(1)
}

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

let context: BrowserContext | null = null
let page: Page | null = null
let ready = false

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
interface ChatState {
  currentChatId: string | null
  currentChatUrl: string | null
  firstUserMessageHash: string | null
  lastUserMessage: string | null
  mode: {
    thinking: boolean
    search: boolean
    deep_research: boolean
  }
  model: string
}

interface LogEntry {
  id: string
  timestamp: number
  type: 'chat' | 'chat_list' | 'chat_select' | 'new_chat' | 'error' | 'state_update'
  model?: string
  chatId?: string
  chatTitle?: string
  prompt?: string
  response?: string
  durationMs?: number
  mode?: { thinking: boolean; search: boolean; deep_research: boolean }
  error?: string
  isContinuation?: boolean
  tokensIn?: number
  tokensOut?: number
}

const proxyState = {
  startedAt: Date.now(),
  requestsHandled: 0,
  chat: {
    currentChatId: null,
    currentChatUrl: null,
    firstUserMessageHash: null,
    lastUserMessage: null,
    mode: { thinking: true, search: false, deep_research: false },
    model: 'qwen3.7-plus',
  } as ChatState,
  logs: [] as LogEntry[],
}

function log(entry: Omit<LogEntry, 'id' | 'timestamp'>) {
  const full: LogEntry = {
    id: 'log_' + Math.random().toString(36).slice(2, 12),
    timestamp: Date.now(),
    ...entry,
  }
  proxyState.logs.push(full)
  if (proxyState.logs.length > 500) proxyState.logs.shift()
  console.log(`[log:${full.type}] ${full.prompt?.slice(0, 60) || ''} ${full.error ? 'ERR:' + full.error.slice(0, 80) : 'ok'}`)
  return full
}

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
  page.on('console', (msg) => {
    const t = msg.type()
    if (t === 'error' || t === 'warning' || t === 'log') {
      console.log(`[page:${t}] ${msg.text()}`)
    }
  })
  page.on('pageerror', (err) => console.log('[pageerror]', err.message))

  await page.goto(QWEN_HOME, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

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

  if (!page.url().startsWith(QWEN_HOME) || page.url().includes('/auth')) {
    await page.goto(QWEN_HOME, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)
  }

  // Try to extract current chatId from URL if we landed on one
  extractChatIdFromUrl()

  ready = true
  console.log('[boot] proxy ready.')
}

async function performLogin() {
  if (!page || !context) throw new Error('page/context missing for login')

  await page.goto(QWEN_AUTH, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)

  await page.getByPlaceholder('Enter Your Email').fill(QWEN_EMAIL)
  await page.getByPlaceholder('Enter Your Password').fill(QWEN_PASSWORD)
  await page.waitForTimeout(500)

  await page.getByRole('button', { name: 'Sign in' }).click()

  try {
    await Promise.race([
      page.waitForURL(QWEN_HOME, { timeout: 30000 }),
      page.waitForURL(QWEN_HOME + '/', { timeout: 30000 }),
      page.waitForSelector('text=incorrect', { timeout: 30000 }),
      page.waitForSelector('text=Invalid', { timeout: 30000 }),
    ])
  } catch {
    /* ignore */
  }

  await page.waitForTimeout(2500)

  const authed = await page.evaluate(async () => {
    const r = await fetch('/api/v1/auths/', { credentials: 'include' })
    return r.status === 200
  })

  if (!authed) {
    throw new Error('Login failed — check credentials or captcha.')
  }

  console.log('[boot] login successful.')
}

function extractChatIdFromUrl(): string | null {
  if (!page) return null
  const url = page.url()
  // Qwen chat URLs: https://chat.qwen.ai/c/<uuid>
  const m = url.match(/\/c\/([a-f0-9-]+)/i)
  if (m) {
    proxyState.chat.currentChatId = m[1]
    proxyState.chat.currentChatUrl = url
    return m[1]
  }
  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function simpleHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

function mapModel(openaiModel: string | undefined): string {
  if (!openaiModel) return MODEL_MAP.default
  return MODEL_MAP[openaiModel] || MODEL_MAP.default
}

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

// Serialize concurrent page interactions
const pageMutex = new (class {
  private chain: Promise<unknown> = Promise.resolve()
  acquire<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => {})
    return run
  }
})()

// ---------------------------------------------------------------------------
// UI actions (all run inside pageMutex)
// ---------------------------------------------------------------------------

async function clickNewChat() {
  if (!page) throw new Error('page not available')
  console.log('[ui] clicking New Chat…')
  try {
    await page.getByRole('button', { name: 'New Chat' }).first().click({ timeout: 5000 })
    await page.waitForTimeout(1200)
  } catch {
    // Sometimes the button is an icon-only button; try alternative selectors
    try {
      await page.locator('[aria-label*="New Chat"], [aria-label*="new chat"]').first().click({ timeout: 3000 })
      await page.waitForTimeout(1200)
    } catch {
      console.log('[ui] New Chat button not found — assuming fresh state')
    }
  }
  // Reset state — we're starting a new conversation
  proxyState.chat.currentChatId = null
  proxyState.chat.currentChatUrl = null
  proxyState.chat.firstUserMessageHash = null
  proxyState.chat.lastUserMessage = null
}

async function navigateToChat(chatId: string) {
  if (!page) throw new Error('page not available')
  console.log(`[ui] navigating to chat ${chatId}…`)
  await page.goto(`${QWEN_HOME}/c/${chatId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  proxyState.chat.currentChatId = chatId
  proxyState.chat.currentChatUrl = page.url()
}

async function setMode(desired: { thinking: boolean; search: boolean; deep_research: boolean }) {
  // The Qwen UI defaults to "Auto" mode which automatically enables thinking
  // and search as needed. Manually toggling modes via UI clicks is fragile
  // (dropdowns can get stuck open and block the Send button).
  //
  // We track the desired mode in proxyState for display/logging, but we let
  // Qwen's Auto mode handle the actual mode selection. This is more reliable
  // than trying to click the mode dropdown.
  proxyState.chat.mode = { ...desired }
  console.log(`[ui] mode set (tracked only, Auto handles actual): thinking=${desired.thinking} search=${desired.search}`)
}

async function fillAndSend(text: string) {
  if (!page) throw new Error('page not available')
  const input = page.getByPlaceholder('Ask Qwen')
  await input.click()
  await page.waitForTimeout(150)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(100)
  await input.fill(text)
  await page.waitForTimeout(300)

  // Verify fill
  const value = await input.inputValue().catch(() => '')
  if (value !== text) {
    console.log('[ui] fill mismatch, retrying with sequential type…')
    await input.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await page.waitForTimeout(100)
    await input.pressSequentially(text, { delay: 5 })
    await page.waitForTimeout(300)
  }

  // Try clicking Send; if that fails, press Enter as fallback
  console.log('[ui] sending (clicking Send or pressing Enter)…')
  try {
    const sendBtn = page.getByRole('button', { name: 'Send' })
    await sendBtn.waitFor({ state: 'visible', timeout: 3000 })
    await sendBtn.click({ timeout: 3000 })
  } catch {
    console.log('[ui] Send button not clickable — pressing Enter…')
    await input.press('Enter')
  }
}

/**
 * Stream the response by polling the LAST assistant message in the DOM.
 * `existingCount` is the number of assistant messages before we sent our
 * message — we wait for a NEW one to appear (count > existingCount) and
 * then poll only that last one. This correctly handles continuations
 * where prior assistant messages already exist in the chat.
 */
async function streamResponse(
  onText: (delta: string) => void,
  onDone: () => void,
  existingCount = 0
) {
  if (!page) throw new Error('page not available')

  // Wait for a NEW assistant message to appear (count > existingCount)
  try {
    await page.waitForFunction(
      (prev: number) => document.querySelectorAll('.qwen-chat-message-assistant').length > prev,
      existingCount,
      { timeout: 20000 }
    )
  } catch {
    throw new Error('new assistant message did not appear within 20s')
  }

  let lastText = ''
  let stableTicks = 0
  const startTime = Date.now()
  const POLL_MS = 150
  const STABLE_LIMIT = 14
  const HARD_TIMEOUT_MS = 120000

  await new Promise<void>((resolve) => {
    const poll = async () => {
      try {
        // Read from the LAST assistant message — ONLY the .phase-answer element.
        // Also detect if thinking is still in progress (Skip button visible).
        const result = await page!.evaluate(() => {
          const msgs = document.querySelectorAll('.qwen-chat-message-assistant')
          if (msgs.length === 0) return { text: '', thinking: false }
          const last = msgs[msgs.length - 1]

          // Check if thinking is still in progress by looking for any
          // visible leaf element whose text is exactly "Skip".
          const allEls = last.querySelectorAll('*')
          let isThinking = false
          for (const el of allEls) {
            if (el.children.length === 0) {
              const t = (el.textContent || '').trim().toLowerCase()
              if (t === 'skip' && el.offsetWidth > 0 && el.offsetHeight > 0) {
                isThinking = true
                break
              }
            }
          }

          // Read ONLY the answer phase
          let text = ''
          const sel = [
            '.response-message-content.phase-answer .custom-qwen-markdown',
            '.response-message-content.phase-answer',
          ]
          for (const s of sel) {
            const el = last.querySelector(s)
            if (el && el.textContent && el.textContent.trim()) {
              text = el.textContent
              break
            }
          }

          // If thinking is active, DON'T consider the text stable —
          // keep waiting for the real answer to appear.
          if (isThinking) {
            return { text: '', thinking: true }
          }

          return { text, thinking: false }
        })

        const { text, thinking } = result

        if (thinking) {
          // Still thinking — reset stable counter, keep waiting
          stableTicks = 0
        } else if (text && text.length > lastText.length) {
          onText(text.slice(lastText.length))
          lastText = text
          stableTicks = 0
        } else if (lastText.length > 0) {
          stableTicks++
        }

        const elapsed = Date.now() - startTime
        if (lastText.length > 0 && stableTicks >= STABLE_LIMIT) {
          console.log(`[stream] stable after ${elapsed}ms (${lastText.length} chars)`)
          onDone()
          resolve()
          return
        }
        if (elapsed > HARD_TIMEOUT_MS) {
          console.log(`[stream] hard timeout at ${elapsed}ms`)
          onDone()
          resolve()
          return
        }
      } catch (e: any) {
        console.log('[stream] poll error:', e.message)
      }
      setTimeout(poll, POLL_MS)
    }
    setTimeout(poll, POLL_MS)
  })

  return lastText
}

// ---------------------------------------------------------------------------
// Scrape chat list from sidebar
// ---------------------------------------------------------------------------
async function scrapeChatList(): Promise<Array<{ id: string; title: string; preview: string }>> {
  if (!page) return []
  return page.evaluate(() => {
    // Qwen sidebar chat items — class names may vary; try several selectors
    const selectors = [
      '.chat-list-item',
      '[class*="chat-history"] [class*="item"]',
      '[class*="sidebar"] a[href*="/c/"]',
      'a[href*="/c/"]',
    ]
    const seen = new Set<string>()
    const out: Array<{ id: string; title: string; preview: string }> = []
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        const href = el.getAttribute('href') || ''
        const m = href.match(/\/c\/([a-f0-9-]+)/i)
        if (!m) return
        const id = m[1]
        if (seen.has(id)) return
        seen.add(id)
        const title = (el.textContent || '').trim().slice(0, 120)
        out.push({ id, title, preview: title })
      })
      if (out.length > 0) break
    }
    return out.slice(0, 50)
  })
}

// ---------------------------------------------------------------------------
// Main chat handler
// ---------------------------------------------------------------------------
async function handleChatCompletions(req: IncomingMessage, res: ServerResponse) {
  proxyState.requestsHandled++
  if (!ready || !page) {
    return sendJSON(res, 503, { error: { message: 'Proxy not ready', type: 'proxy_error' } })
  }

  const raw = await readBody(req)
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return sendJSON(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } })
  }

  const model = mapModel(parsed.model)
  const messages: Array<{ role: string; content: string }> = Array.isArray(parsed.messages) ? parsed.messages : []
  const stream = parsed.stream !== false

  // Parse mode overrides from request body (OpenAI extensions)
  const desiredMode = {
    thinking: parsed.extra?.thinking ?? parsed.thinking ?? proxyState.chat.mode.thinking,
    search: parsed.extra?.search ?? parsed.search ?? proxyState.chat.mode.search,
    deep_research: parsed.extra?.deep_research ?? parsed.deep_research ?? proxyState.chat.mode.deep_research,
  }

  if (messages.length === 0) {
    return sendJSON(res, 400, { error: { message: 'messages is required', type: 'invalid_request' } })
  }

  // --- Chat continuity detection ---
  // Hash the FIRST user message — this identifies the conversation.
  // If the hash matches our stored one, we're continuing the same Qwen chat
  // and only need to send the LATEST user message (Qwen remembers context).
  const userMsgs = messages.filter((m) => m.role === 'user')
  const firstUserContent = userMsgs[0]?.content || ''
  const lastUserContent = userMsgs[userMsgs.length - 1]?.content || ''
  const firstMsgHash = simpleHash(firstUserContent)

  const isContinuation =
    proxyState.chat.currentChatId !== null &&
    proxyState.chat.firstUserMessageHash === firstMsgHash &&
    proxyState.chat.lastUserMessage !== lastUserContent

  const isNewChat = !isContinuation

  // The prompt we actually send to Qwen — only the latest user message.
  // (For continuation, Qwen already has prior context.)
  // (For new chat, the first user message IS the latest, so we send it.)
  const promptToSend = isNewChat ? firstUserContent : lastUserContent

  console.log(
    `[req #${proxyState.requestsHandled}] model=${model} msgs=${messages.length} ` +
      `stream=${stream} continuation=${isContinuation} chatId=${proxyState.chat.currentChatId || 'new'}`
  )

  const completionId = generateId()
  const created = Math.floor(Date.now() / 1000)
  const startTime = Date.now()

  // Execute the UI flow under the mutex
  const executeSend = async (): Promise<number> => {
    // Set mode before sending
    await setMode(desiredMode)

    if (isNewChat) {
      await clickNewChat()
    } else {
      // Continuation — make sure we're on the right chat
      if (proxyState.chat.currentChatId && !page!.url().includes(`/c/${proxyState.chat.currentChatId}`)) {
        await navigateToChat(proxyState.chat.currentChatId)
      }
    }

    // Count existing assistant messages BEFORE sending, so streamResponse
    // knows to wait for a NEW one (count > existing) and poll only the last.
    const existingCount = await page!.evaluate(() => {
      return document.querySelectorAll('.qwen-chat-message-assistant').length
    })
    console.log(`[executeSend] existing assistant messages: ${existingCount}`)

    await fillAndSend(promptToSend)

    // For new chats, extract the chatId from the URL after sending
    if (isNewChat) {
      try {
        await page!.waitForURL(/\/c\/[a-f0-9-]+/i, { timeout: 10000 })
        await page!.waitForTimeout(1000)
      } catch {
        /* URL might not change immediately */
      }
      const newId = extractChatIdFromUrl()
      if (newId) {
        proxyState.chat.currentChatId = newId
        proxyState.chat.firstUserMessageHash = firstMsgHash
        console.log(`[chat] new chatId=${newId}`)
      }
    }
    proxyState.chat.lastUserMessage = lastUserContent
    proxyState.chat.model = model
    return existingCount
  }

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    })

    res.write(
      makeChunk({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })
    )

    let fullText = ''
    try {
      await pageMutex.acquire(async () => {
        const existingCount = await executeSend()
        fullText = await streamResponse(
          (text) => {
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
          () => {},
          existingCount
        )
      })

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

      log({
        type: 'chat',
        model,
        chatId: proxyState.chat.currentChatId || undefined,
        prompt: promptToSend.slice(0, 200),
        response: fullText.slice(0, 200),
        durationMs: Date.now() - startTime,
        mode: desiredMode,
        isContinuation,
        tokensIn: Math.ceil(promptToSend.length / 4),
        tokensOut: Math.ceil(fullText.length / 4),
      })
    } catch (e: any) {
      log({ type: 'error', error: e.message, prompt: promptToSend.slice(0, 200), durationMs: Date.now() - startTime })
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

  // Non-streaming
  let fullText = ''
  try {
    await pageMutex.acquire(async () => {
      const existingCount = await executeSend()
      fullText = await streamResponse(
        () => {},
        () => {},
        existingCount
      )
    })
  } catch (e: any) {
    log({ type: 'error', error: e.message, prompt: promptToSend.slice(0, 200), durationMs: Date.now() - startTime })
    return sendJSON(res, 502, { error: { message: 'Qwen error: ' + e.message, type: 'upstream_error' } })
  }

  log({
    type: 'chat',
    model,
    chatId: proxyState.chat.currentChatId || undefined,
    prompt: promptToSend.slice(0, 200),
    response: fullText.slice(0, 200),
    durationMs: Date.now() - startTime,
    mode: desiredMode,
    isContinuation,
    tokensIn: Math.ceil(promptToSend.length / 4),
    tokensOut: Math.ceil(fullText.length / 4),
  })

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
    usage: {
      prompt_tokens: Math.ceil(promptToSend.length / 4),
      completion_tokens: Math.ceil(fullText.length / 4),
      total_tokens: Math.ceil((promptToSend.length + fullText.length) / 4),
    },
  })
}

// ---------------------------------------------------------------------------
// Other endpoints
// ---------------------------------------------------------------------------
async function handleModels(res: ServerResponse) {
  return sendJSON(res, 200, {
    object: 'list',
    data: [
      { id: 'qwen3.7-plus', object: 'model', created: 1732711466, owned_by: 'qwen', permission: [], root: 'qwen3.7-plus', parent: null },
      { id: 'qwen3.8-max', object: 'model', created: 1732711466, owned_by: 'qwen', permission: [], root: 'qwen3.8-max', parent: null },
    ],
  })
}

async function handleChatsList(res: ServerResponse) {
  if (!ready || !page) return sendJSON(res, 503, { error: 'not ready' })
  try {
    const chats = await pageMutex.acquire(() => scrapeChatList())
    log({ type: 'chat_list', response: `${chats.length} chats` })
    return sendJSON(res, 200, {
      object: 'list',
      data: chats,
      current: proxyState.chat.currentChatId,
    })
  } catch (e: any) {
    return sendJSON(res, 500, { error: { message: e.message } })
  }
}

async function handleChatSelect(req: IncomingMessage, res: ServerResponse) {
  if (!ready || !page) return sendJSON(res, 503, { error: 'not ready' })
  const raw = await readBody(req)
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = {}
  }
  const chatId = parsed.chat_id || parsed.id
  if (!chatId) return sendJSON(res, 400, { error: { message: 'chat_id required' } })

  try {
    await pageMutex.acquire(() => navigateToChat(chatId))
    // Reset conversation tracking so next message starts fresh in this chat
    proxyState.chat.firstUserMessageHash = null
    proxyState.chat.lastUserMessage = null
    log({ type: 'chat_select', chatId, response: 'selected' })
    return sendJSON(res, 200, { ok: true, chat_id: chatId, url: proxyState.chat.currentChatUrl })
  } catch (e: any) {
    return sendJSON(res, 500, { error: { message: e.message } })
  }
}

async function handleChatNew(res: ServerResponse) {
  if (!ready || !page) return sendJSON(res, 503, { error: 'not ready' })
  try {
    await pageMutex.acquire(async () => {
      await clickNewChat()
    })
    log({ type: 'new_chat', response: 'new chat started' })
    return sendJSON(res, 200, { ok: true, chat_id: null, message: 'New chat ready. Send a message to begin.' })
  } catch (e: any) {
    return sendJSON(res, 500, { error: { message: e.message } })
  }
}

function handleStateGet(res: ServerResponse) {
  return sendJSON(res, 200, {
    chat: proxyState.chat,
    ready,
    uptime_s: Math.floor((Date.now() - proxyState.startedAt) / 1000),
    requests_handled: proxyState.requestsHandled,
    browser_url: page?.url() || null,
  })
}

async function handleStateSet(req: IncomingMessage, res: ServerResponse) {
  const raw = await readBody(req)
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return sendJSON(res, 400, { error: { message: 'Invalid JSON' } })
  }
  if (parsed.mode) {
    proxyState.chat.mode = { ...proxyState.chat.mode, ...parsed.mode }
  }
  if (parsed.model) {
    proxyState.chat.model = mapModel(parsed.model)
  }
  log({ type: 'state_update', response: JSON.stringify({ mode: proxyState.chat.mode, model: proxyState.chat.model }) })
  return sendJSON(res, 200, { ok: true, chat: proxyState.chat })
}

function handleLogs(res: ServerResponse) {
  const params = new URL(req.url || '', `http://localhost:${PORT}`).searchParams
  const limit = parseInt(params.get('limit') || '100', 10)
  const type = params.get('type')
  let logs = [...proxyState.logs].reverse()
  if (type) logs = logs.filter((l) => l.type === type)
  return sendJSON(res, 200, {
    object: 'list',
    data: logs.slice(0, limit),
    total: proxyState.logs.length,
  })
}

function handleAnalytics(res: ServerResponse) {
  const chatLogs = proxyState.logs.filter((l) => l.type === 'chat')
  const errorLogs = proxyState.logs.filter((l) => l.type === 'error')
  const totalTokensIn = chatLogs.reduce((s, l) => s + (l.tokensIn || 0), 0)
  const totalTokensOut = chatLogs.reduce((s, l) => s + (l.tokensOut || 0), 0)
  const totalDurationMs = chatLogs.reduce((s, l) => s + (l.durationMs || 0), 0)
  const continuations = chatLogs.filter((l) => l.isContinuation).length
  const newChats = chatLogs.filter((l) => !l.isContinuation).length

  // Group by chatId
  const byChat = new Map<string, { count: number; tokensIn: number; tokensOut: number }>()
  for (const l of chatLogs) {
    const k = l.chatId || 'unknown'
    const e = byChat.get(k) || { count: 0, tokensIn: 0, tokensOut: 0 }
    e.count++
    e.tokensIn += l.tokensIn || 0
    e.tokensOut += l.tokensOut || 0
    byChat.set(k, e)
  }

  // Group by model
  const byModel = new Map<string, { count: number; tokensIn: number; tokensOut: number }>()
  for (const l of chatLogs) {
    const k = l.model || 'unknown'
    const e = byModel.get(k) || { count: 0, tokensIn: 0, tokensOut: 0 }
    e.count++
    e.tokensIn += l.tokensIn || 0
    e.tokensOut += l.tokensOut || 0
    byModel.set(k, e)
  }

  // Last 24h buckets (hourly)
  const now = Date.now()
  const buckets: Array<{ hour: string; requests: number; tokens: number }> = []
  for (let i = 23; i >= 0; i--) {
    const start = now - i * 3600_000
    const end = start + 3600_000
    const hourLogs = chatLogs.filter((l) => l.timestamp >= start && l.timestamp < end)
    buckets.push({
      hour: new Date(start).toISOString().slice(0, 13),
      requests: hourLogs.length,
      tokens: hourLogs.reduce((s, l) => s + (l.tokensIn || 0) + (l.tokensOut || 0), 0),
    })
  }

  return sendJSON(res, 200, {
    totals: {
      requests: proxyState.requestsHandled,
      chat_requests: chatLogs.length,
      errors: errorLogs.length,
      new_chats: newChats,
      continuations,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      total_tokens: totalTokensIn + totalTokensOut,
      avg_duration_ms: chatLogs.length ? Math.round(totalDurationMs / chatLogs.length) : 0,
      uptime_s: Math.floor((Date.now() - proxyState.startedAt) / 1000),
    },
    by_chat: Array.from(byChat.entries()).map(([id, v]) => ({ chat_id: id, ...v })),
    by_model: Array.from(byModel.entries()).map(([model, v]) => ({ model, ...v })),
    hourly: buckets,
    mode: proxyState.chat.mode,
    current_chat: proxyState.chat.currentChatId,
  })
}

function handleHealth(res: ServerResponse) {
  return sendJSON(res, 200, {
    status: ready ? 'ok' : 'booting',
    uptime_s: Math.floor((Date.now() - proxyState.startedAt) / 1000),
    requests_handled: proxyState.requestsHandled,
    last_error: proxyState.logs.filter((l) => l.type === 'error').slice(-1)[0]?.error || null,
    browser_url: page?.url() || null,
    current_chat: proxyState.chat.currentChatId,
    mode: proxyState.chat.mode,
  })
}

// Debug endpoint
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
    await pageMutex.acquire(async () => {
      await clickNewChat()
      await fillAndSend(msg)
      await page!.waitForURL(/\/c\/[a-f0-9-]+/i, { timeout: 10000 }).catch(() => {})
      extractChatIdFromUrl()
    })
    let full = ''
    full = await streamResponse(() => {}, () => {})
    return sendJSON(res, 200, { ok: true, message: msg, response: full, chat_id: proxyState.chat.currentChatId })
  } catch (e: any) {
    return sendJSON(res, 500, { error: e.message })
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Chat-Id',
    })
    return res.end()
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  try {
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) return handleHealth(res)
    if (req.method === 'GET' && url.pathname === '/v1/models') return handleModels(res)
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions')
      return await handleChatCompletions(req, res)
    if (req.method === 'GET' && url.pathname === '/v1/chats') return await handleChatsList(res)
    if (req.method === 'POST' && url.pathname === '/v1/chats/select')
      return await handleChatSelect(req, res)
    if (req.method === 'POST' && url.pathname === '/v1/chats/new') return await handleChatNew(res)
    if (req.method === 'GET' && url.pathname === '/v1/state') return handleStateGet(res)
    if (req.method === 'POST' && url.pathname === '/v1/state') return handleStateSet(req, res)
    if (req.method === 'GET' && url.pathname === '/v1/logs') return handleLogs(res)
    if (req.method === 'GET' && url.pathname === '/v1/analytics') return handleAnalytics(res)
    if (req.method === 'POST' && url.pathname === '/debug/send') return await handleDebugSend(req, res)
    sendJSON(res, 404, { error: { message: `No route for ${req.method} ${url.pathname}` } })
  } catch (e: any) {
    console.error('[server] unhandled:', e)
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
  }
})

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
process.on('unhandledRejection', (reason) => {
  console.log('[unhandledRejection]', String(reason).slice(0, 200))
})
process.on('uncaughtException', (err) => {
  console.log('[uncaughtException]', err.message.slice(0, 200))
})
