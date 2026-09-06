import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes — allows long essays

const PROXY_PORT = 3030

/**
 * Catch-all proxy: forwards any /api/v1/* request to the qwen-proxy
 * mini-service on localhost:3030. Supports streaming (SSE) responses.
 *
 * Uses Node.js runtime (not Edge) because Edge runtime has a ~25s CPU
 * time limit that kills long-running streams (e.g. 1000-word essays).
 */
async function handler(req: NextRequest) {
  const path = req.nextUrl.pathname.replace(/^\/api\/v1/, '')
  const search = req.nextUrl.search
  const target = `http://localhost:${PROXY_PORT}/v1${path}${search}`

  const headers = new Headers()
  headers.set('Content-Type', req.headers.get('content-type') || 'application/json')
  headers.set('X-Accel-Buffering', 'no')

  const init: RequestInit = {
    method: req.method,
    headers,
    // @ts-expect-error - duplex is needed for streaming request bodies in undici
    duplex: 'half',
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
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
    return Response.json(
      { error: { message: `Proxy unreachable: ${e.message}`, type: 'proxy_error' } },
      { status: 502 }
    )
  }
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const DELETE = handler
