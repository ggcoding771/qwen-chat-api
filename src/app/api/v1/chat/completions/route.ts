import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PROXY_PORT = 3030

/**
 * OpenAI-compatible chat completions endpoint that proxies to the
 * qwen-proxy mini-service (which drives a logged-in browser session
 * on chat.qwen.ai to satisfy Baxia anti-bot).
 *
 * Usage:
 *   POST /api/v1/chat/completions?XTransformPort=3030
 *   Body: { model, messages, stream? }
 */
export async function POST(req: NextRequest) {
  const body = await req.text()

  const upstream = await fetch(
    `http://localhost:${PROXY_PORT}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Accel-Buffering': 'no',
      },
      body,
      // @ts-expect-error - allow streaming duplex in undici
      duplex: 'half',
    }
  )

  // Forward streaming response headers
  const headers = new Headers()
  upstream.headers.forEach((v, k) => {
    if (k.toLowerCase() !== 'transfer-encoding' && k.toLowerCase() !== 'content-length') {
      headers.set(k, v)
    }
  })
  headers.set('X-Accel-Buffering', 'no')
  headers.set('Cache-Control', 'no-cache')

  if (!upstream.body) {
    return new Response('upstream empty', { status: 502 })
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  })
}

export async function GET() {
  return Response.json({
    ok: true,
    endpoints: {
      chat: 'POST /api/v1/chat/completions',
      models: 'GET /api/v1/models?XTransformPort=3030',
    },
  })
}
