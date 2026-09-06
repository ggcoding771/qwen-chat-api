/**
 * DeepSeek Chat Proxy — OpenAI-compatible API gateway for chat.deepseek.com
 *
 * Architecture (same as Qwen proxy):
 * - Persistent Playwright browser session
 * - Fetch interceptor captures SSE responses from DeepSeek's API
 * - Drives the UI to send messages (DeepSeek's JS handles PoW + WAF)
 *
 * DeepSeek-specific:
 * - AWS WAF captcha on login (solved manually on first run in headed mode)
 * - Proof of Work (PoW) challenge on chat (auto-solved by DeepSeek's JS)
 * - Chat endpoint: POST /api/v0/chat/completion (SSE)
 * - Modes: Instant / Expert / Vision
 * - Toggles: DeepThink (thinking) / Search
 *
 * Port: 3032 (different from Qwen proxy's 3030)
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const PORT = 3032
const DS_HOME = 'https://chat.deepseek.com'
const DS_AUTH = 'https://chat.deepseek.com/sign_in'

const DS_EMAIL = process.env.QWEN_EMAIL || process.env.DS_EMAIL || ''
const DS_PASSWORD = process.env.QWEN_PASSWORD || process.env.DS_PASSWORD || ''

if (!DS_EMAIL || !DS_PASSWORD) {
  console.error('[FATAL] QWEN_EMAIL / QWEN_PASSWORD (or DS_EMAIL / DS_PASSWORD) env vars required.')
  process.exit(1)
}

// Pass through any deepseek model ID, map common aliases
function mapModel(model: string | undefined): string {
  if (!model) return 'deepseek-chat'
  if (model.startsWith('deepseek')) return model
  if (model === 'gpt-4' || model === 'gpt-4o') return 'deepseek-chat'
  return 'deepseek-chat'
}

const BROWSER_DATA_DIR = `${import.meta.dir}/.browser-data`

let context: BrowserContext | null = null
let page: Page | null = null
let ready = false

// State
interface ChatState {
  currentChatId: string | null
  firstUserMessageHash: string | null
  lastUserMessage: string | null
  mode: { thinking: boolean; search: boolean }
  model: string
}

const proxyState = {
  startedAt: Date.now(),
  requestsHandled: 0,
  chat: {
    currentChatId: null,
    firstUserMessageHash: null,
    lastUserMessage: null,
    mode: { thinking: false, search: false },
    model: 'deepseek-chat',
  } as ChatState,
  logs: [] as any[],
}

function log(entry: any) {
  entry.id = 'log_' + Math.random().toString(36).slice(2, 12)
  entry.timestamp = Date.now()
  proxyState.logs.push(entry)
  if (proxyState.logs.length > 2000) proxyState.logs.shift()
  console.log(`[log:${entry.type}] ${entry.prompt?.slice(0, 60) || ''} ${entry.error ? 'ERR:' + entry.error.slice(0, 80) : 'ok'}`)
}

// Mutex for serializing page interactions
const pageMutex = new (class {
  private chain: Promise<unknown> = Promise.resolve()
  acquire<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => {})
    return run
  }
})()

// ---------------------------------------------------------------------------
// Browser bootstrap + login
// ---------------------------------------------------------------------------
async function bootstrapBrowser() {
  console.log('[boot] launching persistent chromium context…')
  context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  })

  page = await context.newPage()
  page.on('console', (msg) => {
    const t = msg.type()
    if (t === 'error' || t === 'warning' || t === 'log') {
      console.log(`[page:${t}] ${msg.text()}`)
    }
  })
  page.on('pageerror', (err) => console.log('[pageerror]', err.message))

  // Load saved session (cookies + localStorage) if available.
  // This bypasses the WAF captcha — the user logs in once manually,
  // exports their session, and the proxy reuses it.
  const sessionPath = `${import.meta.dir}/session.json`
  let sessionLoaded = false
  try {
    if (existsSync(sessionPath)) {
      const session = JSON.parse(readFileSync(sessionPath, 'utf-8'))
      console.log('[boot] loading saved session (cookies + localStorage)…')

      // Add cookies
      if (session.cookies && Array.isArray(session.cookies)) {
        await context.addCookies(session.cookies)
        console.log(`[boot] added ${session.cookies.length} cookies`)
      }

      // Navigate to the domain first so localStorage can be set
      await page.goto(DS_HOME, { waitUntil: 'domcontentloaded' })

      // Set localStorage
      if (session.localStorage) {
        await page.evaluate((ls) => {
          for (const [key, value] of Object.entries(ls)) {
            try { localStorage.setItem(key, String(value)) } catch {}
          }
        }, session.localStorage)
        console.log(`[boot] set ${Object.keys(session.localStorage).length} localStorage items`)
      }

      // Reload to apply the session
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(5000)

      const isLoggedIn = !page.url().includes('sign_in')
      if (isLoggedIn) {
        console.log('[boot] session valid — logged in via saved session')
        sessionLoaded = true
      } else {
        console.log('[boot] saved session expired — need manual re-login')
      }
    }
  } catch (e: any) {
    console.log(`[boot] session load failed: ${e.message}`)
  }

  if (!sessionLoaded) {
    // Check if we're already authenticated (persistent context)
    if (page.url().includes('sign_in') || !page.url().includes('deepseek.com')) {
      await page.goto(DS_HOME, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(3000)
    }

    const isLoggedIn = !page.url().includes('sign_in')
    if (!isLoggedIn) {
      console.log('[boot] ⚠️  NOT AUTHENTICATED')
      console.log('[boot] ────────────────────────────────────────────────────────────')
      console.log('[boot] DeepSeek requires a WAF captcha that can\'t be solved headless.')
      console.log('[boot] To fix this:')
      console.log('[boot] 1. Log into chat.deepseek.com in your own browser')
      console.log('[boot] 2. Export cookies + localStorage (browser DevTools → Application)')
      console.log('[boot] 3. Save them to: mini-services/deepseek-proxy/session.json')
      console.log('[boot] 4. Restart the proxy: ./manage.sh restart')
      console.log('[boot] ────────────────────────────────────────────────────────────')
      console.log('[boot] Continuing in unauthenticated mode (chat will fail)…')
    } else {
      console.log('[boot] already authenticated (persistent context).')
    }
  }

  // Inject the fetch interceptor
  await injectFetchInterceptor()

  ready = true
  console.log('[boot] proxy ready.')
}

async function performLogin() {
  if (!page) throw new Error('page missing')

  // Make sure we're on the sign-in page
  if (!page.url().includes('sign_in')) {
    await page.goto(DS_AUTH, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(5000)
  }

  // Fill email and password
  await page.getByPlaceholder('Phone number / email address').fill(DS_EMAIL).catch(() => {})
  await page.getByPlaceholder('Password').fill(DS_PASSWORD).catch(() => {})
  await page.waitForTimeout(500)

  // Click "Log in" — this triggers a WAF captcha challenge
  console.log('[boot] clicking Log in (WAF captcha may appear)…')
  await page.getByRole('button', { name: 'Log in' }).click().catch(() => {})
  await page.waitForTimeout(5000)

  // Try to solve WAF captcha using VLM (vision AI)
  for (let attempt = 0; attempt < 8; attempt++) {
    // Check if logged in already
    if (!page.url().includes('sign_in')) {
      console.log('[boot] login successful!')
      return
    }

    // Check if captcha is visible
    const hasCaptcha = await page.evaluate(() => {
      const captcha = document.querySelector('awswaf-captcha')
      if (!captcha) return false
      const sr = (captcha as any).shadowRoot
      if (!sr) return false
      const modal = sr.querySelector('.amzn-captcha-modal')
      return modal && modal.getBoundingClientRect().width > 0
    }).catch(() => false)

    if (!hasCaptcha) {
      console.log(`[boot] no captcha visible (attempt ${attempt + 1}) — waiting…`)
      await page.waitForTimeout(3000)
      continue
    }

    console.log(`[boot] WAF captcha detected (attempt ${attempt + 1}/8) — solving with VLM…`)

    // Take a screenshot of the captcha
    const screenshotPath = `${import.meta.dir}/captcha_screenshot.png`
    await page.screenshot({ path: screenshotPath, fullPage: false })

    // Use VLM (z-ai CLI) to analyze the captcha
    let cellNums: number[] = []
    try {
      const vlmOutput = execSync(
        `z-ai vision -p "This is an AWS WAF captcha with a 3x3 grid. What is the instruction and which cells (1-9, left-to-right top-to-bottom) should be clicked? Reply ONLY in this format: CELLS:1,2,3" -i "${screenshotPath}" -o /tmp/ds_captcha_analysis.json 2>/dev/null && cat /tmp/ds_captcha_analysis.json`,
        { timeout: 30000, encoding: 'utf-8' }
      )
      const vlmJson = JSON.parse(vlmOutput.trim())
      const content = vlmJson?.choices?.[0]?.message?.content || ''
      console.log(`[boot] VLM says: ${content.slice(0, 200)}`)

      // Extract cell numbers
      const match = content.match(/CELLS:(\d+(?:,\d+)*)/i)
      if (match) {
        cellNums = match[1].split(',').map((n) => parseInt(n.trim()))
      } else {
        // Try to find numbers in the content
        const nums = content.match(/\b([1-9])\b/g)
        if (nums) cellNums = nums.map((n) => parseInt(n))
      }
      console.log(`[boot] cells to click: ${JSON.stringify(cellNums)}`)
    } catch (e: any) {
      console.log(`[boot] VLM analysis failed: ${e.message.slice(0, 100)}`)
    }

    if (cellNums.length === 0) {
      console.log('[boot] could not identify captcha cells — waiting and retrying…')
      await page.waitForTimeout(5000)
      continue
    }

    // Click the cells via JavaScript (shadow DOM .click())
    await page.evaluate((cells) => {
      const captcha = document.querySelector('awswaf-captcha')
      if (!captcha) return
      const sr = (captcha as any).shadowRoot
      if (!sr) return
      const buttons = sr.querySelectorAll('button')
      for (const cellNum of cells) {
        const idx = cellNum - 1 // convert to 0-indexed
        if (buttons[idx]) {
          buttons[idx].click()
        }
      }
    }, cellNums).catch(() => {})

    await page.waitForTimeout(1000)

    // Click the Confirm button
    await page.evaluate(() => {
      const captcha = document.querySelector('awswaf-captcha')
      if (!captcha) return
      const sr = (captcha as any).shadowRoot
      if (!sr) return
      const buttons = sr.querySelectorAll('button')
      for (const btn of buttons) {
        if (btn.textContent.includes('Confirm')) {
          btn.click()
          break
        }
      }
    }).catch(() => {})

    console.log('[boot] captcha submitted — waiting for response…')
    await page.waitForTimeout(8000)
  }

  // Final check
  if (page.url().includes('sign_in')) {
    console.log('[boot] login may have failed — continuing anyway (session might still be valid)')
  } else {
    console.log('[boot] login successful!')
  }
}

// ---------------------------------------------------------------------------
// Fetch + XHR interceptor (same approach as Qwen proxy)
// ---------------------------------------------------------------------------
async function injectFetchInterceptor() {
  if (!page) return
  await page.evaluate(() => {
    if ((window as any).__dsInterceptorInstalled) return
    ;(window as any).__dsInterceptorInstalled = true
    ;(window as any).__dsStreamCallback = null
    ;(window as any).__dsStreamDone = null
    ;(window as any).__dsStreamError = null

    // --- Patch window.fetch ---
    const originalFetch = window.fetch
    window.fetch = async function (input: any, init?: any) {
      const urlString = typeof input === 'string' ? input : input?.url || ''
      const response = await originalFetch.call(this, input, init)

      if (urlString.includes('/chat/completion') &&
          (window as any).__dsStreamCallback &&
          response.body && response.body.tee) {
        try {
          const [stream1, stream2] = response.body.tee()
          const reader = stream2.getReader()
          const decoder = new TextDecoder()
          const cb = (window as any).__dsStreamCallback
          const doneCb = (window as any).__dsStreamDone
          const errCb = (window as any).__dsStreamError
          ;(window as any).__dsFetchDelivered = true

          ;(async () => {
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                const text = decoder.decode(value, { stream: true })
                if (cb) cb(text)
              }
              if (doneCb) doneCb()
            } catch (e: any) {
              if (errCb) errCb(String(e?.message || e))
            }
          })()

          return new Response(stream1, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          })
        } catch (e) {
          console.log('[interceptor] fetch tee failed:', e)
          return response
        }
      }
      return response
    } as any

    // --- Patch XMLHttpRequest (DeepSeek uses XHR for chat completions) ---
    const OriginalXHR = window.XMLHttpRequest
    const originalOpen = OriginalXHR.prototype.open
    const originalSend = OriginalXHR.prototype.send

    OriginalXHR.prototype.open = function (method: string, url: string, ...rest: any[]) {
      (this as any).__dsUrl = url
      ;(this as any).__dsDelivered = false
      return originalOpen.call(this, method, url, ...rest)
    }

    OriginalXHR.prototype.send = function (body: any) {
      const url = (this as any).__dsUrl || ''
      if (url.includes('/chat/completion') && (window as any).__dsStreamCallback) {
        // Skip if fetch already handled it (avoid duplicates)
        if ((window as any).__dsFetchDelivered) {
          return originalSend.call(this, body)
        }

        const cb = (window as any).__dsStreamCallback
        const doneCb = (window as any).__dsStreamDone
        const xhr = this
        const originalOnReady = (this as any).onreadystatechange
        let lastLen = 0

        ;(this as any).onreadystatechange = function () {
          // Read streaming response text (XHR supports this in readyState 3+)
          if (xhr.readyState >= 3) {
            try {
              const full = xhr.responseText || ''
              if (full.length > lastLen) {
                const newPart = full.slice(lastLen)
                if (newPart && cb) cb(newPart)
                lastLen = full.length
              }
            } catch (e) {}
          }
          if (xhr.readyState === 4 && !xhr.__dsDelivered) {
            xhr.__dsDelivered = true
            if (doneCb) doneCb()
          }
          if (originalOnReady) originalOnReady.call(xhr)
        }
      }
      return originalSend.call(this, body)
    }

    console.log('[interceptor] DeepSeek fetch + XHR interceptor installed')
  })
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function simpleHash(s: string): string {
  const { createHash } = require('node:crypto')
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

async function clickNewChat() {
  if (!page) return
  try {
    await page.getByText('New chat').click({ timeout: 3000 })
    await page.waitForTimeout(1000)
  } catch {
    console.log('[ui] New Chat button not found — assuming fresh state')
  }
  await injectFetchInterceptor()
  proxyState.chat.currentChatId = null
  proxyState.chat.firstUserMessageHash = null
  proxyState.chat.lastUserMessage = null
}

async function setMode(desired: { thinking: boolean; search: boolean }) {
  if (!page) return
  try {
    // DeepThink toggle
    const deepThink = page.getByText('DeepThink', { exact: true })
    const isThinkingActive = await deepThink.evaluate((el: any) => {
      const parent = el.closest('[class*="active"], [class*="selected"]')
      return !!parent || el.getAttribute('aria-checked') === 'true'
    }).catch(() => false)

    if (desired.thinking !== isThinkingActive) {
      await deepThink.click({ timeout: 2000 }).catch(() => {})
      await page.waitForTimeout(300)
    }

    // Search toggle
    const search = page.getByText('Search', { exact: true })
    const isSearchActive = await search.evaluate((el: any) => {
      const parent = el.closest('[class*="active"], [class*="selected"]')
      return !!parent || el.getAttribute('aria-checked') === 'true'
    }).catch(() => false)

    if (desired.search !== isSearchActive) {
      await search.click({ timeout: 2000 }).catch(() => {})
      await page.waitForTimeout(300)
    }
  } catch (e: any) {
    console.log(`[ui] mode toggle skipped: ${e.message}`)
  }
  proxyState.chat.mode = { ...desired }
}

async function fillAndSend(text: string) {
  if (!page) throw new Error('page not available')
  const input = page.getByPlaceholder('Message DeepSeek')
  await input.click()
  await page.waitForTimeout(150)
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(100)
  await input.fill(text)
  await page.waitForTimeout(300)

  // Press Enter to send (DeepSeek uses Enter, not a button)
  console.log('[ui] pressing Enter to send…')
  await input.press('Enter')
}

// ---------------------------------------------------------------------------
// Stream response (same approach as Qwen — intercept SSE via window vars)
// ---------------------------------------------------------------------------
async function streamResponse(
  onText: (delta: string) => void,
  onDone: () => void,
  callbackName: string
) {
  if (!page) throw new Error('page not available')

  let streamDone = false
  const startTime = Date.now()
  const HARD_TIMEOUT_MS = 300000
  let lastProcessedLen = 0
  let fullText = ''

  while (!streamDone) {
    const state = await page.evaluate((cbName: string) => {
      const arr = (window as any)[cbName] || []
      return {
        chunks: arr.slice(),
        chunkCount: arr.length,
        done: !!(window as any).__dsStreamDoneFlag,
        error: (window as any).__dsStreamError || null,
      }
    }, callbackName)

    if (state.chunkCount > lastProcessedLen) {
      const newChunks = state.chunks.slice(lastProcessedLen)
      for (const chunk of newChunks) {
        // DeepSeek uses SSE format: data: {json}
        const lines = chunk.split('\n')
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') {
            streamDone = true
            continue
          }
          try {
            const json = JSON.parse(payload)
            // DeepSeek SSE format: choices[0].delta.content
            const choices = json.choices
            if (Array.isArray(choices) && choices[0]?.delta?.content) {
              fullText += choices[0].delta.content
              onText(choices[0].delta.content)
            }
            // Also check for content field
            if (!fullText && typeof json.content === 'string') {
              fullText += json.content
              onText(json.content)
            }
          } catch {
            // ignore non-JSON keep-alive
          }
        }
      }
      lastProcessedLen = state.chunkCount
    }

    if (state.error) break
    if (state.done) { streamDone = true; break }
    if (Date.now() - startTime > HARD_TIMEOUT_MS) break

    await new Promise((r) => setTimeout(r, 20))
  }

  // Cleanup
  await page.evaluate((cbName: string) => {
    ;(window as any).__dsStreamCallback = null
    ;(window as any).__dsStreamDone = null
    ;(window as any).__dsStreamError = null
    ;(window as any).__dsStreamDoneFlag = false
    ;(window as any).__dsStreamError = null
    delete (window as any)[cbName]
  }, callbackName).catch(() => {})

  const elapsed = Date.now() - startTime
  console.log(`[stream] done after ${elapsed}ms (${fullText.length} chars)`)
  onDone()
  return fullText
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJSON(res: ServerResponse, status: number, body: any) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
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

// ---------------------------------------------------------------------------
// Chat handler
// ---------------------------------------------------------------------------
async function handleChatCompletions(req: IncomingMessage, res: ServerResponse) {
  proxyState.requestsHandled++
  if (!ready || !page) {
    return sendJSON(res, 503, { error: { message: 'Proxy not ready' } })
  }

  const raw = await readBody(req)
  let parsed: any
  try { parsed = JSON.parse(raw) } catch { return sendJSON(res, 400, { error: { message: 'Invalid JSON' } }) }

  const model = mapModel(parsed.model)
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  const stream = parsed.stream !== false
  const desiredMode = {
    thinking: parsed.thinking ?? proxyState.chat.mode.thinking,
    search: parsed.search ?? proxyState.chat.mode.search,
  }

  if (messages.length === 0) return sendJSON(res, 400, { error: { message: 'messages required' } })

  // Chat continuity
  const userMsgs = messages.filter((m: any) => m.role === 'user')
  const firstUserContent = userMsgs[0]?.content || ''
  const lastUserContent = userMsgs[userMsgs.length - 1]?.content || ''
  const firstMsgHash = simpleHash(firstUserContent)
  const isContinuation = proxyState.chat.currentChatId !== null &&
    proxyState.chat.firstUserMessageHash === firstMsgHash &&
    proxyState.chat.lastUserMessage !== lastUserContent
  const isNewChat = !isContinuation
  const promptToSend = isNewChat ? firstUserContent : lastUserContent

  console.log(`[req #${proxyState.requestsHandled}] model=${model} msgs=${messages.length} stream=${stream} continuation=${isContinuation}`)

  const completionId = generateId()
  const created = Math.floor(Date.now() / 1000)
  const startTime = Date.now()

  const executeSend = async (): Promise<string> => {
    await setMode(desiredMode)
    if (isNewChat) await clickNewChat()

    // Register stream callback BEFORE sending
    const callbackName = '__dsChunk_' + Math.random().toString(36).slice(2, 10)
    await page!.evaluate((cbName: string) => {
      ;(window as any).__dsStreamCallback = (text: string) => {
        const arr = (window as any)[cbName] = (window as any)[cbName] || []
        arr.push(text)
      }
      ;(window as any).__dsStreamDone = () => { ;(window as any).__dsStreamDoneFlag = true }
      ;(window as any).__dsStreamError = (err: string) => { ;(window as any).__dsStreamError = err }
      ;(window as any).__dsStreamDoneFlag = false
      ;(window as any).__dsStreamError = null
      ;(window as any).__dsFetchDelivered = false
    }, callbackName)

    await fillAndSend(promptToSend)
    proxyState.chat.lastUserMessage = lastUserContent
    proxyState.chat.model = model
    return callbackName
  }

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no',
    })
    res.write(makeChunk({ id: completionId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }))

    let fullText = ''
    try {
      await pageMutex.acquire(async () => {
        const cbName = await executeSend() as any
        fullText = await streamResponse(
          (text) => { res.write(makeChunk({ id: completionId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })) },
          () => {},
          cbName
        )
      })
      res.write(makeChunk({ id: completionId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }))
      res.write('data: [DONE]\n\n')
      res.end()
      log({ type: 'chat', model, prompt: promptToSend.slice(0, 200), response: fullText.slice(0, 200), durationMs: Date.now() - startTime, mode: desiredMode, isContinuation, tokensIn: Math.ceil(promptToSend.length / 4), tokensOut: Math.ceil(fullText.length / 4) })
    } catch (e: any) {
      log({ type: 'error', error: e.message, prompt: promptToSend.slice(0, 200) })
      res.write(makeChunk({ id: completionId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], error: { message: e.message } }))
      res.write('data: [DONE]\n\n')
      res.end()
    }
    return
  }

  // Non-streaming
  let fullText = ''
  try {
    await pageMutex.acquire(async () => {
      const cbName = await executeSend() as any
      fullText = await streamResponse(() => {}, () => {}, cbName)
    })
  } catch (e: any) {
    return sendJSON(res, 502, { error: { message: 'DeepSeek error: ' + e.message } })
  }
  log({ type: 'chat', model, prompt: promptToSend.slice(0, 200), response: fullText.slice(0, 200), durationMs: Date.now() - startTime, mode: desiredMode, isContinuation })
  return sendJSON(res, 200, {
    id: completionId, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: fullText }, finish_reason: 'stop' }],
    usage: { prompt_tokens: Math.ceil(promptToSend.length / 4), completion_tokens: Math.ceil(fullText.length / 4), total_tokens: Math.ceil((promptToSend.length + fullText.length) / 4) },
  })
}

// ---------------------------------------------------------------------------
// Other endpoints
// ---------------------------------------------------------------------------
function handleHealth(res: ServerResponse) {
  return sendJSON(res, 200, {
    status: ready ? 'ok' : 'booting',
    uptime_s: Math.floor((Date.now() - proxyState.startedAt) / 1000),
    requests_handled: proxyState.requestsHandled,
    browser_url: page?.url() || null,
    provider: 'deepseek',
  })
}

function handleModels(res: ServerResponse) {
  return sendJSON(res, 200, {
    object: 'list',
    data: [
      { id: 'deepseek-chat', object: 'model', created: 1732711466, owned_by: 'deepseek', permission: [], root: 'deepseek-chat', parent: null },
      { id: 'deepseek-reasoner', object: 'model', created: 1732711466, owned_by: 'deepseek', permission: [], root: 'deepseek-reasoner', parent: null },
    ],
  })
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' })
    return res.end()
  }
  const url = new URL(req.url || '/', `http://localhost:${PORT}`)
  try {
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) return handleHealth(res)
    if (req.method === 'GET' && url.pathname === '/v1/models') return handleModels(res)
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return await handleChatCompletions(req, res)
    sendJSON(res, 404, { error: { message: `No route for ${req.method} ${url.pathname}` } })
  } catch (e: any) {
    if (!res.headersSent) sendJSON(res, 500, { error: { message: e.message } })
    else res.end()
  }
})

server.listen(PORT, async () => {
  console.log(`[deepseek-proxy] HTTP server on :${PORT}`)
  try { await bootstrapBrowser() } catch (e: any) { console.error('[boot] FAILED:', e) }
})

const shutdown = async (sig: string) => {
  console.log(`\n[${sig}] shutting down…`)
  try { await context?.close() } catch {}
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (r) => console.log('[unhandledRejection]', String(r).slice(0, 200)))
process.on('uncaughtException', (e) => console.log('[uncaughtException]', e.message.slice(0, 200)))
