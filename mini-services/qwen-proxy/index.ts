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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = 3030
const QWEN_HOME = 'https://chat.qwen.ai'
const QWEN_AUTH = 'https://chat.qwen.ai/auth'

const QWEN_EMAIL = process.env.QWEN_EMAIL || ''
const QWEN_PASSWORD = process.env.QWEN_PASSWORD || ''

if (!QWEN_EMAIL || !QWEN_PASSWORD) {
  console.error('[FATAL] QWEN_EMAIL / QWEN_PASSWORD env vars are required.')
  process.exit(1)
}

// Map common OpenAI model names -> Qwen model ids.
// For models not in this map, we pass them through as-is so any model
// returned by /v1/models works automatically.
const MODEL_ALIASES: Record<string, string> = {
  'qwen-plus': 'qwen3.7-plus',
  'qwen-max': 'qwen3.8-max',
  'gpt-4': 'qwen3.7-plus',
  'gpt-4o': 'qwen3.7-plus',
  'gpt-3.5-turbo': 'qwen3.7-plus',
  default: 'qwen3.7-plus',
}

const BROWSER_DATA_DIR = `${import.meta.dir}/.browser-data`

// Persistent log storage — survives proxy restarts.
// Stored as JSON in the proxy directory.
const LOG_FILE = join(import.meta.dir, 'logs.json')
const LOG_MAX = 2000 // keep last 2000 entries on disk

// Debounced file writer — avoids writing on every log entry (which would
// be slow during streaming). Writes at most once per 2 seconds.
let logWritePending = false
let logWriteTimer: any = null
function scheduleLogWrite() {
  if (logWriteTimer) return
  logWriteTimer = setTimeout(() => {
    logWriteTimer = null
    try {
      const data = JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        logs: proxyState.logs.slice(-LOG_MAX),
      })
      writeFileSync(LOG_FILE, data)
    } catch (e: any) {
      console.log(`[persist] failed to write logs: ${e.message}`)
    }
  }, 2000)
}

// Load persisted logs on startup
function loadPersistedLogs() {
  try {
    if (!existsSync(LOG_FILE)) return
    const raw = readFileSync(LOG_FILE, 'utf-8')
    const data = JSON.parse(raw)
    if (data?.logs && Array.isArray(data.logs)) {
      proxyState.logs = data.logs
      console.log(`[persist] loaded ${data.logs.length} logs from ${LOG_FILE}`)
    }
  } catch (e: any) {
    console.log(`[persist] failed to load logs: ${e.message}`)
  }
}

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
  // Keep more logs in memory now that we persist to disk (2000 vs 500)
  if (proxyState.logs.length > 2000) proxyState.logs.shift()
  console.log(`[log:${full.type}] ${full.prompt?.slice(0, 60) || ''} ${full.error ? 'ERR:' + full.error.slice(0, 80) : 'ok'}`)
  scheduleLogWrite() // persist to disk (debounced)
  return full
}

// ---------------------------------------------------------------------------
// Browser bootstrap + login
// ---------------------------------------------------------------------------
async function bootstrapBrowser() {
  // Load persisted logs from disk before starting the browser
  loadPersistedLogs()

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
  if (!openaiModel) return MODEL_ALIASES.default
  // Pass through Qwen model IDs as-is (qwen3.7-plus, qwen3-max-coder, etc.)
  if (openaiModel.startsWith('qwen') || openaiModel.startsWith('qvq')) {
    return openaiModel
  }
  // Map common aliases
  return MODEL_ALIASES[openaiModel] || MODEL_ALIASES.default
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
  if (!page) return
  // Map our thinking flag to Qwen's three UI modes:
  //   thinking=true  → "Thinking" (deep reasoning)
  //   thinking=false → "Fast"      (no thinking)
  //   (search/deep_research override to "Auto" which handles everything)
  //
  // The Qwen mode selector is a dropdown with class
  // `qwen-chat-v2-dropdown-menu-select`. Items are `qwen-chat-v2-dropdown-menu-item`.
  const wantMode = desired.deep_research || desired.search ? 'Auto' : desired.thinking ? 'Thinking' : 'Fast'

  try {
    // Read current mode from the label
    const currentMode = await page.evaluate(() => {
      const el = document.querySelector('.qwen-chat-v2-dropdown-menu-select-label')
      return el?.textContent?.trim() || null
    })

    if (currentMode === wantMode) {
      console.log(`[ui] mode already '${wantMode}' — no change needed`)
      proxyState.chat.mode = { ...desired }
      return
    }

    console.log(`[ui] switching mode: ${currentMode} → ${wantMode}`)

    // Click the mode selector to open the dropdown
    const selector = page.locator('.qwen-chat-v2-dropdown-menu-select').first()
    await selector.click({ timeout: 3000 })
    await page.waitForTimeout(500)

    // Click the desired mode item.
    // We use text matching on the dropdown item label.
    const modeItem = page.locator('.qwen-chat-v2-dropdown-menu-item', { hasText: wantMode }).first()
    await modeItem.click({ timeout: 3000 })
    await page.waitForTimeout(500)

    // Verify the mode changed
    const newMode = await page.evaluate(() => {
      const el = document.querySelector('.qwen-chat-v2-dropdown-menu-select-label')
      return el?.textContent?.trim() || null
    })
    console.log(`[ui] mode is now '${newMode}'`)

    // Close any dropdown that might still be open
    await page.keyboard.press('Escape').catch(() => {})
  } catch (e: any) {
    console.log(`[ui] mode switch failed: ${e.message} — continuing with current mode`)
    // Make sure no dropdown is left open (would block the Send button)
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(300)
  }
  proxyState.chat.mode = { ...desired }
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
 *
 * Two improvements over the original polling approach:
 * 1. **MutationObserver** — instead of polling every 150ms, we observe DOM
 *    mutations on the assistant message container. This gives us real-time
 *    text changes (word-by-word) instead of batched 150ms-late deltas.
 * 2. **Feedback modal detection** — Qwen sometimes shows an A/B "Which
 *    response do you prefer?" modal instead of a clean response. We detect
 *    this and auto-dismiss it (click "skip" or the first response) so the
 *    stream completes normally.
 */
async function streamResponse(
  onText: (delta: string) => void,
  onDone: () => void,
  existingCount = 0
) {
  if (!page) throw new Error('page not available')

  // Wait for a NEW assistant message to appear (count > existingCount).
  // Also check for the feedback modal — if Qwen shows "Which response do
  // you prefer?" instead of a new message, we need to handle that.
  try {
    await page.waitForFunction(
      (prev: number) => {
        // Check for new assistant message OR feedback modal
        const msgCount = document.querySelectorAll('.qwen-chat-message-assistant').length
        if (msgCount > prev) return true

        // Also check for feedback modal (A/B response selection)
        const feedbackText = document.body.textContent || ''
        if (feedbackText.includes('Which response do you prefer') ||
            feedbackText.includes('Select one to continue') ||
            feedbackText.includes('prefer this response')) {
          return true
        }
        return false
      },
      existingCount,
      { timeout: 25000 }
    )
  } catch {
    throw new Error('new assistant message did not appear within 25s')
  }

  // Auto-dismiss feedback modal if it appeared (Qwen's A/B response testing).
  // We click the first "prefer this response" button or any dismiss button.
  await page.evaluate(() => {
    const body = document.body.textContent || ''
    if (body.includes('Which response do you prefer') ||
        body.includes('Select one to continue') ||
        body.includes('prefer this response')) {
      console.log('[stream] feedback modal detected — auto-selecting first response')
      // Look for response preference buttons and click the first one
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      const preferBtn = buttons.find((b) => {
        const t = (b.textContent || '').trim().toLowerCase()
        return t.includes('prefer') || t.includes('response 1') || t.includes('select') || t === '1'
      })
      if (preferBtn) {
        (preferBtn as HTMLElement).click()
        return 'clicked-prefer'
      }
      // Fallback: look for a close/dismiss button
      const closeBtn = buttons.find((b) => {
        const t = (b.textContent || '').trim().toLowerCase()
        return t === 'close' || t === 'skip' || t === 'dismiss' || t === '×'
      })
      if (closeBtn) {
        (closeBtn as HTMLElement).click()
        return 'clicked-close'
      }
      return 'modal-detected-no-button'
    }
    return 'no-modal'
  }).then((r) => {
    if (r !== 'no-modal') console.log(`[stream] feedback modal handled: ${r}`)
  }).catch(() => {})

  // Give the modal dismissal a moment to take effect
  await page.waitForTimeout(500).catch(() => {})

  // Set up a MutationObserver for real-time text detection.
  // This is much faster than polling (instant vs 150ms delay).
  let lastText = ''
  let done = false
  const donePromise = page.evaluate(
    (existingCount) => {
      return new Promise<void>((resolve) => {
        let stableTicks = 0
        let lastLen = 0
        let thinking = false
        const POLL_MS = 60          // fast poll for near-real-time streaming
        const STABLE_LIMIT = 40     // ~2.4s of no change → done (high to avoid code-block re-render false positives)
        const HARD_TIMEOUT_MS = 300000
        const startTime = Date.now()

        const check = () => {
          const msgs = document.querySelectorAll('.qwen-chat-message-assistant')
          if (msgs.length === 0) {
            ;(window as any).__streamText = ''
            ;(window as any).__streamThinking = false
            setTimeout(check, POLL_MS)
            return
          }
          const last = msgs[msgs.length - 1]

          // Check for "Skip" button (thinking in progress)
          let isThinking = false
          const allEls = last.querySelectorAll('*')
          for (const el of allEls) {
            if (el.children.length === 0) {
              const t = (el.textContent || '').trim().toLowerCase()
              if (t === 'skip' && el.offsetWidth > 0 && el.offsetHeight > 0) {
                isThinking = true
                break
              }
            }
          }

          // Read the answer phase
          let text = ''
          for (const sel of [
            '.response-message-content.phase-answer .custom-qwen-markdown',
            '.response-message-content.phase-answer',
          ]) {
            const el = last.querySelector(sel)
            if (el && el.textContent && el.textContent.trim()) {
              text = el.textContent
              break
            }
          }

          if (isThinking) {
            stableTicks = 0
            ;(window as any).__streamText = ''
            ;(window as any).__streamThinking = true
          } else {
            ;(window as any).__streamThinking = false
            if (text.length > lastLen) {
              ;(window as any).__streamText = text
              stableTicks = 0
              lastLen = text.length
            } else if (lastLen > 0) {
              stableTicks++
            }
          }

          const elapsed = Date.now() - startTime
          if (lastLen > 0 && !isThinking && stableTicks >= STABLE_LIMIT) {
            ;(window as any).__streamDone = true
            resolve()
            return
          }
          if (elapsed > HARD_TIMEOUT_MS) {
            ;(window as any).__streamDone = true
            resolve()
            return
          }
          setTimeout(check, POLL_MS)
        }

        // Also set up a MutationObserver for instant text changes
        const observer = new MutationObserver(() => {
          // The poll loop will pick up the change on next tick, but
          // the observer ensures we don't miss anything between polls.
        })
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        })

        check()
      })
    },
    existingCount
  )

  // Poll the window variables set by the page-side check loop
  // and emit deltas in real-time.
  const streamStart = Date.now()
  while (!done) {
    const state = await page.evaluate(() => ({
      text: (window as any).__streamText || '',
      thinking: (window as any).__streamThinking || false,
      done: (window as any).__streamDone || false,
    }))

    if (state.text && state.text.length > lastText.length) {
      onText(state.text.slice(lastText.length))
      lastText = state.text
    }

    if (state.done) {
      done = true
      break
    }

    // Check hard timeout
    if (Date.now() - streamStart > 310000) {
      console.log('[stream] outer hard timeout (310s)')
      done = true
      break
    }

    // Fast poll — 30ms gives near-real-time streaming
    await new Promise((r) => setTimeout(r, 30))
  }

  // Clean up window variables
  await page.evaluate(() => {
    delete (window as any).__streamText
    delete (window as any).__streamThinking
    delete (window as any).__streamDone
  }).catch(() => {})

  const elapsed = Date.now() - streamStart
  console.log(`[stream] done after ${elapsed}ms (${lastText.length} chars)`)
  onDone()
  return lastText
}

// ---------------------------------------------------------------------------
// Fetch chat list from Qwen API (via browser, with auth cookies)
// ---------------------------------------------------------------------------
async function fetchChatList(): Promise<Array<{ id: string; title: string; preview: string; updated_at?: number }>> {
  if (!page) return []
  // Try Qwen's /api/v2/chats endpoint first (proper way).
  // It's on the Baxia protected list, but GET requests from the page
  // context often work because Baxia primarily intercepts mutations (POST).
  const result = await page.evaluate(async () => {
    try {
      const res = await fetch('/api/v2/chats/?page=1&page_size=50', {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      })
      const text = await res.text()
      return { status: res.status, body: text, method: 'api' }
    } catch (e: any) {
      return { status: 0, body: String(e?.message || e), method: 'api-error' }
    }
  })

  if (result.status === 200) {
    try {
      const json = JSON.parse(result.body)
      // The API returns { data: { data: [...] } } or { data: [...] }
      const rawChats = json?.data?.data || json?.data || []
      const chats = rawChats.map((c: any) => ({
        id: c.id,
        title: c.title || c.chat_title || 'Untitled',
        preview: (c.title || c.chat_title || '').slice(0, 120),
        updated_at: c.updated_at || c.create_time || undefined,
      }))
      console.log(`[chats] fetched ${chats.length} chats from Qwen API`)
      return chats.slice(0, 50)
    } catch (e: any) {
      console.log(`[chats] API parse failed: ${e.message}`)
    }
  } else {
    console.log(`[chats] API returned ${result.status}, falling back to DOM scrape`)
  }

  // Fallback: scrape the sidebar DOM.
  // Qwen doesn't use <a href> tags — chats are rendered as divs with click
  // handlers. We look for elements that contain chat IDs in their data
  // attributes or have chat-like class names.
  return page.evaluate(() => {
    const out: Array<{ id: string; title: string; preview: string }> = []
    const seen = new Set<string>()

    // Strategy 1: Find elements with data attributes containing chat IDs
    document.querySelectorAll('[data-id], [data-chat-id], [data-key]').forEach((el) => {
      const id = el.getAttribute('data-id') || el.getAttribute('data-chat-id') || el.getAttribute('data-key') || ''
      if (/^[a-f0-9-]{8,}$/i.test(id) && !seen.has(id)) {
        seen.add(id)
        const title = (el.textContent || '').trim().slice(0, 120)
        out.push({ id, title, preview: title })
      }
    })

    // Strategy 2: Find clickable elements in the sidebar that navigate to /c/
    const sidebar = document.querySelector('[class*="sidebar"], [class*="chat-list"], [class*="history"]')
    if (sidebar) {
      sidebar.querySelectorAll('[class*="item"], [class*="chat-row"], [role="button"], [class*="list-item"]').forEach((el) => {
        // Check if this element has an onClick that navigates, or contains text
        const text = (el.textContent || '').trim()
        if (text.length > 0 && text.length < 200) {
          // Look for a UUID pattern in any nested element's attributes
          const inner = el.querySelector('[class*="id"], [class*="key"]')
          const allEls = [el, ...(inner ? [inner] : [])]
          for (const e of allEls) {
            for (const attr of ['data-id', 'data-key', 'id']) {
              const v = e.getAttribute(attr) || ''
              const m = v.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i)
              if (m && !seen.has(m[1])) {
                seen.add(m[1])
                out.push({ id: m[1], title: text.slice(0, 120), preview: text.slice(0, 120) })
                break
              }
            }
          }
        }
      })
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

// Cache the real model list fetched from Qwen (refreshed every 5 min)
let modelsCache: { data: any[]; fetchedAt: number } | null = null
const MODELS_CACHE_MS = 5 * 60 * 1000

async function fetchQwenModels(): Promise<any[]> {
  if (!page) throw new Error('page not available')
  // Fetch via the browser so Baxia tokens + auth cookies are attached.
  // /api/v2/models/ is NOT on the protected list, so even a plain fetch
  // from the page context works.
  const result = await page.evaluate(async () => {
    const res = await fetch('/api/v2/models/', { credentials: 'include' })
    const text = await res.text()
    return { status: res.status, body: text }
  })
  if (result.status >= 400) {
    throw new Error(`fetchQwenModels failed ${result.status}: ${result.body.slice(0, 200)}`)
  }
  const json = JSON.parse(result.body)
  const rawModels = json?.data?.data || json?.data || []
  // Normalize to OpenAI shape, preserving Qwen metadata in `info`
  return rawModels.map((m: any) => ({
    id: m.id,
    object: 'model',
    created: m.info?.meta?.updated_at || m.created || 1732711466,
    owned_by: m.owned_by || 'qwen',
    permission: [],
    root: m.id,
    parent: null,
    // Qwen-specific metadata (capabilities, context length, etc.)
    info: {
      name: m.name || m.id,
      description: m.info?.meta?.description || '',
      short_description: m.info?.meta?.short_description || '',
      capabilities: m.info?.meta?.capabilities || {},
      max_context_length: m.info?.meta?.max_context_length || 0,
      max_summary_generation_length: m.info?.meta?.max_summary_generation_length || 0,
      chat_type: m.info?.meta?.chat_type || [],
      thinking_format: m.info?.meta?.thinking_format || null,
      auto_thinking: m.info?.meta?.auto_thinking || false,
      preset: m.info?.preset || false,
      is_active: m.info?.is_active ?? true,
    },
  }))
}

async function handleModels(res: ServerResponse) {
  // Return cached if fresh
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_MS) {
    return sendJSON(res, 200, { object: 'list', data: modelsCache.data })
  }
  // Otherwise fetch fresh from Qwen
  if (!ready || !page) {
    // Fallback to a minimal hardcoded list if proxy isn't ready
    return sendJSON(res, 200, {
      object: 'list',
      data: [
        { id: 'qwen3.7-plus', object: 'model', created: 1732711466, owned_by: 'qwen', permission: [], root: 'qwen3.7-plus', parent: null, info: { name: 'Qwen3.7-Plus' } },
        { id: 'qwen3.8-max', object: 'model', created: 1732711466, owned_by: 'qwen', permission: [], root: 'qwen3.8-max', parent: null, info: { name: 'Qwen3.8-Max' } },
      ],
    })
  }
  try {
    const models = await fetchQwenModels()
    modelsCache = { data: models, fetchedAt: Date.now() }
    console.log(`[models] fetched ${models.length} models from Qwen`)
    return sendJSON(res, 200, { object: 'list', data: models })
  } catch (e: any) {
    console.log(`[models] fetch failed: ${e.message} — using fallback`)
    // Return cached (even if stale) or fallback list
    if (modelsCache) return sendJSON(res, 200, { object: 'list', data: modelsCache.data })
    return sendJSON(res, 200, {
      object: 'list',
      data: [
        { id: 'qwen3.7-plus', object: 'model', created: 1732711466, owned_by: 'qwen', permission: [], root: 'qwen3.7-plus', parent: null, info: { name: 'Qwen3.7-Plus' } },
        { id: 'qwen3.8-max', object: 'model', created: 1732711466, owned_by: 'qwen', permission: [], root: 'qwen3.8-max', parent: null, info: { name: 'Qwen3.8-Max' } },
      ],
    })
  }
}

async function handleChatsList(res: ServerResponse) {
  if (!ready || !page) return sendJSON(res, 503, { error: 'not ready' })
  try {
    const chats = await pageMutex.acquire(() => fetchChatList())
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

function handleLogs(req: IncomingMessage, res: ServerResponse) {
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

// Debug endpoint: inspect DOM for generating/loading indicators
async function handleDebugInspectGenerating(res: ServerResponse) {
  if (!ready || !page) return sendJSON(res, 503, { error: 'not ready' })
  try {
    const info = await page.evaluate(() => {
      const out: any = { stopButtons: [], loadingIndicators: [], allButtons: [] }
      // Find ALL buttons and elements with stop/loading/spinner classes
      document.querySelectorAll('button, [role="button"], [class*="stop"], [class*="loading"], [class*="spinner"], [class*="generating"], svg[class*="stop"], svg[class*="load"]').forEach((el) => {
        const t = (el.textContent || '').trim().slice(0, 50)
        const cls = (el.className || '').toString().slice(0, 150)
        const tag = el.tagName.toLowerCase()
        const visible = el.offsetWidth > 0 && el.offsetHeight > 0
        if (visible && (cls.includes('stop') || cls.includes('load') || cls.includes('spin') || cls.includes('generat') || t.toLowerCase().includes('stop'))) {
          out.stopButtons.push({ tag, cls, text: t, visible })
        }
      })
      // Also find the last assistant message and dump its structure
      const msgs = document.querySelectorAll('.qwen-chat-message-assistant')
      if (msgs.length > 0) {
        const last = msgs[msgs.length - 1]
        out.lastMsgClasses = last.className.slice(0, 200)
        // Look for action buttons (copy, regenerate, stop) in the message footer
        const actions = last.querySelectorAll('[class*="action"], [class*="footer"], [class*="toolbar"] button, [class*="action"] svg')
        actions.forEach((a) => {
          out.allButtons.push({
            tag: a.tagName.toLowerCase(),
            cls: (a.className || '').toString().slice(0, 100),
            text: (a.textContent || '').trim().slice(0, 30),
            ariaLabel: a.getAttribute('aria-label') || '',
          })
        })
      }
      return out
    })
    return sendJSON(res, 200, { ok: true, url: page.url(), info })
  } catch (e: any) {
    return sendJSON(res, 500, { error: e.message })
  }
}
async function handleDebugInspectMode(res: ServerResponse) {
  if (!ready || !page) return sendJSON(res, 503, { error: 'not ready' })
  try {
    // First, click the mode selector to open the dropdown
    const modeSelector = page.locator('.qwen-chat-v2-dropdown-menu-select').first()
    await modeSelector.click({ timeout: 3000 }).catch((e) => {
      console.log(`[debug] mode selector click failed: ${e.message}`)
    })
    await page.waitForTimeout(800)

    const info = await page.evaluate(() => {
      const out: any = { modeElements: [], dropdownItems: [], currentMode: null }
      // Find current mode label
      const label = document.querySelector('.qwen-chat-v2-dropdown-menu-select-label')
      if (label) out.currentMode = label.textContent?.trim()

      // Find dropdown menu items (these appear after clicking)
      document.querySelectorAll('.qwen-chat-v2-dropdown-menu-item, [class*="dropdown-menu-item"], [role="menuitem"], [role="option"]').forEach((el) => {
        const t = (el.textContent || '').trim()
        if (t && t.length < 50) {
          out.dropdownItems.push({
            cls: el.className.slice(0, 150),
            text: t,
            visible: el.offsetWidth > 0,
            clickable: el.tagName === 'BUTTON' || el.getAttribute('role') === 'menuitem' || el.getAttribute('role') === 'option',
          })
        }
      })
      // Also find elements with Auto/Thinking/Fast text (might be in dropdown)
      document.querySelectorAll('*').forEach((el) => {
        if (el.children.length === 0) {
          const t = (el.textContent || '').trim()
          if ((t === 'Auto' || t === 'Thinking' || t === 'Fast' || t === '搜索' || t === '思考' || t === '自动' || t === '快速') && el.offsetWidth > 0) {
            out.modeElements.push({
              tag: el.tagName,
              cls: el.className.slice(0, 150),
              text: t,
              parentCls: el.parentElement?.className?.slice(0, 150) || '',
            })
          }
        }
      })
      return out
    })

    // Close the dropdown by pressing Escape
    await page.keyboard.press('Escape').catch(() => {})

    return sendJSON(res, 200, { ok: true, url: page.url(), info })
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
    if (req.method === 'GET' && url.pathname === '/v1/logs') return handleLogs(req, res)
    if (req.method === 'GET' && url.pathname === '/v1/analytics') return handleAnalytics(res)
    if (req.method === 'POST' && url.pathname === '/debug/send') return await handleDebugSend(req, res)
    if (req.method === 'GET' && url.pathname === '/debug/inspect-mode') return await handleDebugInspectMode(res)
    if (req.method === 'GET' && url.pathname === '/debug/inspect-generating') return await handleDebugInspectGenerating(res)
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
  // Flush logs to disk immediately
  try {
    const data = JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      logs: proxyState.logs.slice(-LOG_MAX),
    })
    writeFileSync(LOG_FILE, data)
    console.log(`[persist] flushed ${proxyState.logs.length} logs to disk`)
  } catch (e: any) {
    console.log(`[persist] flush failed: ${e.message}`)
  }
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
