import { NextRequest } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PROXY_PORT = 3030

export async function GET(_req: NextRequest) {
  const upstream = await fetch(`http://localhost:${PROXY_PORT}/v1/models`, {
    method: 'GET',
  })
  const text = await upstream.text()
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  })
}
