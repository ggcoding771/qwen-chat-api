import { NextRequest } from 'next/server'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'

const QWEN_PORT = 3030
const DEEPSEEK_PORT = 3032

/**
 * Catch-all proxy with model-based routing:
 *
 * - qwen* models → Qwen proxy (port 3030)
 * - deepseek* models → DeepSeek proxy (port 3032)
 * - Non-chat endpoints (models, chats, logs, etc.) → Qwen proxy (default)
 *
 * Supports streaming (SSE) responses.
 * Uses Edge runtime for Cloudflare Pages compatibility.
 */
async function handler(req: NextRequest) {
  const path = req.nextUrl.pathname.replace(/^\/api\/v1/, '')
  const search = req.nextUrl.search

  // Determine which proxy to route to
  let port = QWEN_PORT // default

  if (path === '/chat/completions' && req.method === 'POST') {
    // Read the body to check the model
    const body = await req.text()
    try {
      const parsed = JSON.parse(body)
      const model = parsed.model || ''
      if (model.startsWith('deepseek')) {
        port = DEEPSEEK_PORT
      }
    } catch {}
    // Forward the body
    return proxyTo(req, port, path, search, body)
  }

  return proxyTo(req, port, path, search)
}

async function proxyTo(
  req: NextRequest,
  port: number,
  path: string,
  search: string,
  bodyOverride?: string
) {
  const target = `http://localhost:${port}/v1${path}${search}`

  const headers = new Headers()
  headers.set('Content-Type', req.headers.get('content-type') || 'application/json')
  headers.set('X-Accel-Buffering', 'no')

  const init: RequestInit = {
    method: req.method,
    headers,
    // @ts-expect-error - duplex is needed for streaming request bodies
    duplex: 'half',
  }

  if (bodyOverride !== undefined) {
    init.body = bodyOverride
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.text()
  }

  try {
    const upstream = await fetch(target, init)
    const respHeaders = new Headers()
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase()
      if (lk !== 'transfer-encoding' && lk !== 'content-length') {
        respHeaders.set(k, v)
      }
    })
    respHeaders.set('X-Accel-Buffering', 'no')
    respHeaders.set('Cache-Control', 'no-cache')

    if (!upstream.body) {
      return new Response(null, { status: upstream.status, headers: respHeaders })
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: respHeaders,
    })
  } catch (e: any) {
    const provider = port === DEEPSEEK_PORT ? 'DeepSeek' : 'Qwen'
    return Response.json(
      { error: { message: `${provider} proxy unreachable: ${e.message}. Is the proxy running on port ${port}?`, type: 'proxy_error' } },
      { status: 502 }
    )
  }
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
