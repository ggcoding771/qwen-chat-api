'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Send,
  Square,
  Trash2,
  Zap,
  Activity,
  Code2,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  streaming?: boolean
  error?: boolean
}

const MODELS = [
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', desc: 'High-performance multimodal' },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', desc: 'Flagship reasoning' },
]

const API_EXAMPLE = `# Streaming (SSE)
curl -N -X POST /api/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "qwen3.7-plus",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": true
  }'

# Non-streaming
curl -X POST /api/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "qwen3.8-max",
    "messages": [{"role": "user", "content": "Hi"}],
    "stream": false
  }'

# List models
curl /api/v1/models`

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [model, setModel] = useState('qwen3.7-plus')
  const [streaming, setStreaming] = useState(false)
  const [proxyStatus, setProxyStatus] = useState<'unknown' | 'ok' | 'down'>('unknown')
  const [showApi, setShowApi] = useState(false)
  const [copied, setCopied] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Check proxy health on mount
  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        const r = await fetch('/api/v1/models', { method: 'GET' })
        if (!active) return
        setProxyStatus(r.ok ? 'ok' : 'down')
      } catch {
        if (active) setProxyStatus('down')
      }
    }
    check()
    const interval = setInterval(check, 15000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'
  }, [input])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    setMessages((prev) =>
      prev.map((m) => (m.streaming ? { ...m, streaming: false, content: m.content + '\n\n_[stopped]_' } : m))
    )
  }, [])

  const send = useCallback(async () => {
    const content = input.trim()
    if (!content || streaming) return

    const userMsg: Message = { id: crypto.randomUUID(), role: 'user', content }
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      streaming: true,
    }
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput('')
    setStreaming(true)

    const ac = new AbortController()
    abortRef.current = ac

    try {
      const res = await fetch('/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], stream: true }),
        signal: ac.signal,
      })

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => 'request failed')
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, streaming: false, error: true, content: `Error: ${errText.slice(0, 300)}` }
              : m
          )
        )
        setStreaming(false)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m))
            )
            continue
          }
          try {
            const json = JSON.parse(payload)
            const delta = json.choices?.[0]?.delta?.content
            if (delta) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id ? { ...m, content: m.content + delta } : m
                )
              )
            }
          } catch {
            /* ignore */
          }
        }
      }
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m))
      )
    } catch (e: any) {
      if (e.name === 'AbortError') return
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id
            ? { ...m, streaming: false, error: true, content: `Error: ${e.message}` }
            : m
        )
      )
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [input, streaming, model])

  const clearChat = () => {
    if (streaming) return
    setMessages([])
  }

  const copyApi = () => {
    navigator.clipboard.writeText(API_EXAMPLE).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-emerald-50 via-white to-teal-50 dark:from-zinc-950 dark:via-zinc-900 dark:to-emerald-950">
      {/* Header */}
      <header className="border-b border-zinc-200/60 dark:border-zinc-800/60 bg-white/70 dark:bg-zinc-950/70 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-sm">
              <Zap className="w-5 h-5 text-white" fill="white" />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
                Qwen Chat API
              </h1>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                OpenAI-compatible gateway for chat.qwen.ai
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className={`gap-1.5 ${
                proxyStatus === 'ok'
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800'
                  : proxyStatus === 'down'
                    ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800'
                    : 'bg-zinc-50 text-zinc-500 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:border-zinc-800'
              }`}
            >
              <Activity className={`w-3 h-3 ${proxyStatus === 'ok' ? 'animate-pulse' : ''}`} />
              {proxyStatus === 'ok' ? 'Proxy online' : proxyStatus === 'down' ? 'Proxy offline' : 'Checking…'}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowApi((s) => !s)}
              className="gap-1.5 text-zinc-600 dark:text-zinc-300"
            >
              <Code2 className="w-4 h-4" />
              <span className="hidden sm:inline">API</span>
              {showApi ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </Button>
          </div>
        </div>
      </header>

      {/* API docs (collapsible) */}
      {showApi && (
        <div className="border-b border-zinc-200/60 dark:border-zinc-800/60 bg-zinc-50/70 dark:bg-zinc-900/70">
          <div className="max-w-5xl mx-auto px-4 py-3">
            <Card className="p-4 bg-zinc-950 border-zinc-800 relative">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Quickstart</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={copyApi}
                  className="h-7 px-2 text-zinc-400 hover:text-zinc-200"
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <pre className="text-xs text-emerald-300 font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto">
                {API_EXAMPLE}
              </pre>
            </Card>
          </div>
        </div>
      )}

      {/* Chat area */}
      <main className="flex-1 overflow-hidden flex flex-col">
        <div className="flex-1 overflow-y-auto" ref={scrollRef}>
          <div className="max-w-3xl mx-auto px-4 py-6">
            {messages.length === 0 ? (
              <EmptyState model={model} />
            ) : (
              <div className="space-y-5">
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-zinc-200/60 dark:border-zinc-800/60 bg-white/80 dark:bg-zinc-950/80 backdrop-blur-sm">
          <div className="max-w-3xl mx-auto px-4 py-3">
            <div className="flex items-end gap-2">
              <Select value={model} onValueChange={setModel} disabled={streaming}>
                <SelectTrigger className="w-[160px] shrink-0 bg-white dark:bg-zinc-900">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODELS.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      <div className="flex flex-col">
                        <span className="font-medium">{m.name}</span>
                        <span className="text-xs text-zinc-500">{m.desc}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <div className="flex-1 relative">
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      send()
                    }
                  }}
                  placeholder="Send a message…  (Enter to send, Shift+Enter for newline)"
                  rows={1}
                  className="min-h-[44px] max-h-[200px] resize-none bg-white dark:bg-zinc-900 pr-12"
                  disabled={streaming}
                />
                {messages.length > 0 && !streaming && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={clearChat}
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8 text-zinc-400 hover:text-red-500"
                    title="Clear chat"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>

              {streaming ? (
                <Button
                  onClick={stop}
                  variant="destructive"
                  className="shrink-0 gap-1.5"
                  size="icon"
                >
                  <Square className="w-4 h-4" fill="currentColor" />
                </Button>
              ) : (
                <Button
                  onClick={send}
                  disabled={!input.trim() || proxyStatus !== 'ok'}
                  className="shrink-0 bg-gradient-to-br from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-sm"
                  size="icon"
                >
                  <Send className="w-4 h-4" />
                </Button>
              )}
            </div>
            <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1.5 text-center">
              Each request drives a real browser session on chat.qwen.ai. Stream latency ≈ Qwen UI latency.
            </p>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-200/60 dark:border-zinc-800/60 bg-white/50 dark:bg-zinc-950/50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          <span>
            POST <code className="text-emerald-600 dark:text-emerald-400">/api/v1/chat/completions</code>
            <span className="mx-1.5 opacity-40">·</span>
            GET <code className="text-emerald-600 dark:text-emerald-400">/api/v1/models</code>
          </span>
          <span className="hidden sm:flex items-center gap-1.5">
            <Separator orientation="vertical" className="h-3" />
            OpenAI-compatible
          </span>
        </div>
      </footer>
    </div>
  )
}

function EmptyState({ model }: { model: string }) {
  const examples = [
    'Explain quantum entanglement in 2 sentences',
    'Write a haiku about the ocean',
    'Debug: why is my regex /\\d{3}-\\d{4}/ not matching 123-4567?',
    'Compare REST vs GraphQL with a real example',
  ]
  return (
    <div className="text-center py-16 px-4">
      <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 items-center justify-center shadow-lg shadow-emerald-500/20 mb-5">
        <Zap className="w-8 h-8 text-white" fill="white" />
      </div>
      <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50 mb-2">
        Qwen, behind an OpenAI API
      </h2>
      <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-md mx-auto mb-8">
        Powered by a headless browser session on chat.qwen.ai ({model}). The gateway
        handles Baxia anti-bot so you can use it like any OpenAI-compatible client.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-md mx-auto text-left">
        {examples.map((ex) => (
          <div
            key={ex}
            className="text-xs text-zinc-600 dark:text-zinc-300 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg px-3 py-2"
          >
            {ex}
          </div>
        ))}
      </div>
    </div>
  )
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-xs font-semibold ${
          isUser
            ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
            : 'bg-gradient-to-br from-emerald-500 to-teal-600 text-white'
        }`}
      >
        {isUser ? 'You' : 'Q'}
      </div>
      <div
        className={`flex-1 min-w-0 rounded-2xl px-4 py-2.5 ${
          isUser
            ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
            : message.error
              ? 'bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-100 border border-red-200 dark:border-red-800'
              : 'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100'
        }`}
      >
        <div className="text-sm whitespace-pre-wrap break-words leading-relaxed">
          {message.content || (message.streaming ? <TypingDots /> : '')}
        </div>
        {message.streaming && message.content && (
          <span className="inline-block w-1.5 h-4 bg-emerald-500 ml-0.5 align-middle animate-pulse" />
        )}
      </div>
    </div>
  )
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1 py-1.5">
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  )
}
