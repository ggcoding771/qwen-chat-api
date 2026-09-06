'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
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
  MessageSquare,
  BarChart3,
  Settings as SettingsIcon,
  List,
  KeyRound,
  Terminal,
  RefreshCw,
  ExternalLink,
  Plus,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  streaming?: boolean
  error?: boolean
}

interface QwenChat {
  id: string
  title: string
  preview: string
}

interface LogEntry {
  id: string
  timestamp: number
  type: string
  model?: string
  chatId?: string
  prompt?: string
  response?: string
  durationMs?: number
  isContinuation?: boolean
  tokensIn?: number
  tokensOut?: number
  error?: string
}

interface Analytics {
  totals: {
    requests: number
    chat_requests: number
    errors: number
    new_chats: number
    continuations: number
    tokens_in: number
    tokens_out: number
    total_tokens: number
    avg_duration_ms: number
    uptime_s: number
  }
  by_model: Array<{ model: string; count: number; tokensIn: number; tokensOut: number }>
  hourly: Array<{ hour: string; requests: number; tokens: number }>
  current_chat: string | null
}

type Tab = 'setup' | 'chats' | 'playground' | 'logs' | 'analytics' | 'settings'

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
const STORAGE_KEY = 'qwen_proxy_config'

function loadConfig(): { email: string; apiKey: string; proxyUrl: string } {
  if (typeof window === 'undefined') return { email: '', apiKey: '', proxyUrl: '' }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { email: '', apiKey: '', proxyUrl: '' }
}

function saveConfig(cfg: { email: string; apiKey: string; proxyUrl: string }) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch {}
}

function genApiKey() {
  return 'sk-qwen-' + Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Home() {
  const [tab, setTab] = useState<Tab>('setup')
  const [config, setConfig] = useState(loadConfig)
  const [proxyStatus, setProxyStatus] = useState<'unknown' | 'ok' | 'down'>('unknown')
  const [proxyInfo, setProxyInfo] = useState<any>(null)

  // Poll proxy health
  useEffect(() => {
    let active = true
    const check = async () => {
      try {
        const r = await fetch('/api/v1/health')
        if (!active) return
        if (r.ok) {
          const data = await r.json()
          setProxyStatus(data.status === 'ok' ? 'ok' : 'down')
          setProxyInfo(data)
        } else {
          setProxyStatus('down')
        }
      } catch {
        if (active) setProxyStatus('down')
      }
    }
    check()
    const interval = setInterval(check, 10000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  const tabs: Array<{ id: Tab; label: string; icon: any }> = [
    { id: 'setup', label: 'Setup', icon: KeyRound },
    { id: 'chats', label: 'Chats', icon: MessageSquare },
    { id: 'playground', label: 'Playground', icon: Terminal },
    { id: 'logs', label: 'Logs', icon: List },
    { id: 'analytics', label: 'Analytics', icon: BarChart3 },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ]

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-emerald-50 via-white to-teal-50 dark:from-zinc-950 dark:via-zinc-900 dark:to-emerald-950">
      {/* Header */}
      <header className="border-b border-zinc-200/60 dark:border-zinc-800/60 bg-white/70 dark:bg-zinc-950/70 backdrop-blur-sm sticky top-0 z-30">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between gap-3 mb-2">
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
              {proxyStatus === 'ok' ? 'Online' : proxyStatus === 'down' ? 'Offline' : 'Checking…'}
            </Badge>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 overflow-x-auto -mb-px">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  tab === t.id
                    ? 'border-emerald-500 text-emerald-600 dark:text-emerald-400'
                    : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
                }`}
              >
                <t.icon className="w-4 h-4" />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Tab content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-4 py-6">
          {tab === 'setup' && <SetupTab config={config} setConfig={setConfig} proxyInfo={proxyInfo} />}
          {tab === 'chats' && <ChatsTab proxyInfo={proxyInfo} />}
          {tab === 'playground' && <PlaygroundTab />}
          {tab === 'logs' && <LogsTab />}
          {tab === 'analytics' && <AnalyticsTab proxyInfo={proxyInfo} />}
          {tab === 'settings' && <SettingsTab proxyInfo={proxyInfo} />}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-200/60 dark:border-zinc-800/60 bg-white/50 dark:bg-zinc-950/50">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
          <span>
            Base URL: <code className="text-emerald-600 dark:text-emerald-400">http://localhost:3000/api/v1</code>
          </span>
          <span className="hidden sm:flex items-center gap-1.5">
            <Separator orientation="vertical" className="h-3" />
            OpenAI-compatible · Cline-ready
          </span>
        </div>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Setup Tab
// ---------------------------------------------------------------------------
function SetupTab({
  config,
  setConfig,
  proxyInfo,
}: {
  config: { email: string; apiKey: string; proxyUrl: string }
  setConfig: (c: any) => void
  proxyInfo: any
}) {
  const [email, setEmail] = useState(config.email)
  const [apiKey, setApiKey] = useState(() => config.apiKey || genApiKey())
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)

  const save = () => {
    saveConfig({ email, apiKey, proxyUrl: '' })
    setConfig({ email, apiKey, proxyUrl: '' })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const copyApiKey = () => {
    navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const baseUrl = typeof window !== 'undefined' ? `${window.location.origin}/api/v1` : ''

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center mb-6">
        <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 items-center justify-center shadow-lg shadow-emerald-500/20 mb-4">
          <Zap className="w-8 h-8 text-white" fill="white" />
        </div>
        <h2 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50 mb-2">
          Qwen, behind an OpenAI API
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Configure your credentials and get an API key for Cline, LangChain, or any OpenAI-compatible client.
        </p>
      </div>

      <Card className="p-6 space-y-4">
        <div>
          <Label htmlFor="email" className="text-sm font-medium">
            Qwen Account Email
          </Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="your-email@gmail.com"
            className="mt-1.5"
          />
          <p className="text-xs text-zinc-400 mt-1">
            The Qwen account that the proxy browser session uses to log into chat.qwen.ai
          </p>
        </div>

        <div>
          <Label className="text-sm font-medium">Your API Key</Label>
          <div className="flex gap-2 mt-1.5">
            <Input value={apiKey} readOnly className="font-mono text-xs" />
            <Button variant="outline" size="icon" onClick={copyApiKey}>
              {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-xs text-zinc-400 mt-1">
            Use this as the <code className="text-emerald-600 dark:text-emerald-400">Authorization: Bearer</code> token
          </p>
        </div>

        <div>
          <Label className="text-sm font-medium">Base URL for Cline</Label>
          <div className="flex gap-2 mt-1.5">
            <Input value={baseUrl} readOnly className="font-mono text-xs" />
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                navigator.clipboard.writeText(baseUrl)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        <Button onClick={save} className="w-full bg-gradient-to-br from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white">
          {saved ? <Check className="w-4 h-4 mr-2" /> : <KeyRound className="w-4 h-4 mr-2" />}
          {saved ? 'Saved!' : 'Save Configuration'}
        </Button>
      </Card>

      {/* Cline setup instructions */}
      <Card className="p-6 bg-zinc-950 border-zinc-800">
        <div className="flex items-center gap-2 mb-3">
          <Code2 className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-medium text-zinc-300">Cline (VS Code) Setup</span>
        </div>
        <pre className="text-xs text-emerald-300 font-mono whitespace-pre-wrap leading-relaxed">
{`1. Open Cline settings in VS Code
2. API Provider: OpenAI Compatible
3. Base URL: ${baseUrl}
4. API Key: ${apiKey}
5. Model: qwen3.7-plus (or qwen3.8-max)

# Or test with curl:
curl -N ${baseUrl}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{"model":"qwen3.7-plus",
       "messages":[{"role":"user","content":"Hi"}],
       "stream":true}'`}
        </pre>
      </Card>

      {proxyInfo && (
        <Card className="p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-500">Proxy Status</span>
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
              {proxyInfo.status}
            </Badge>
          </div>
          {proxyInfo.current_chat && (
            <div className="flex items-center justify-between text-sm mt-2">
              <span className="text-zinc-500">Active Chat</span>
              <code className="text-xs text-zinc-600 dark:text-zinc-300">{proxyInfo.current_chat.slice(0, 12)}…</code>
            </div>
          )}
          {proxyInfo.uptime_s != null && (
            <div className="flex items-center justify-between text-sm mt-2">
              <span className="text-zinc-500">Uptime</span>
              <span className="text-zinc-600 dark:text-zinc-300">
                {Math.floor(proxyInfo.uptime_s / 60)}m {proxyInfo.uptime_s % 60}s
              </span>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chats Tab
// ---------------------------------------------------------------------------
function ChatsTab({ proxyInfo }: { proxyInfo: any }) {
  const [chats, setChats] = useState<QwenChat[]>([])
  const [loading, setLoading] = useState(false)
  const [currentChat, setCurrentChat] = useState<string | null>(null)
  const [error, setError] = useState('')

  const fetchChats = async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetch('/api/v1/chats')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setChats(data.data || [])
      setCurrentChat(data.current || null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchChats()
  }, [])

  const selectChat = async (chatId: string) => {
    try {
      await fetch('/api/v1/chats/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId }),
      })
      setCurrentChat(chatId)
    } catch (e: any) {
      setError(e.message)
    }
  }

  const newChat = async () => {
    try {
      await fetch('/api/v1/chats/new', { method: 'POST' })
      setCurrentChat(null)
      setChats([])
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Qwen Chats</h2>
          <p className="text-sm text-zinc-500">
            Select an existing chat to continue, or start a new one. The active chat is used for all API requests.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchChats} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={newChat} className="bg-emerald-500 hover:bg-emerald-600 text-white">
            <Plus className="w-4 h-4 mr-1.5" />
            New Chat
          </Button>
        </div>
      </div>

      {error && (
        <Card className="p-3 border-red-200 bg-red-50 dark:bg-red-950/30">
          <p className="text-sm text-red-600 dark:text-red-400">Error: {error}</p>
        </Card>
      )}

      <div className="space-y-2">
        {chats.length === 0 && !loading ? (
          <Card className="p-8 text-center">
            <MessageSquare className="w-8 h-8 text-zinc-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">No chats found. Send a message in the Playground to create one.</p>
          </Card>
        ) : (
          chats.map((chat) => (
            <Card
              key={chat.id}
              className={`p-4 cursor-pointer transition-colors hover:border-emerald-300 ${
                currentChat === chat.id ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20' : ''
              }`}
              onClick={() => selectChat(chat.id)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
                    {chat.title || 'Untitled Chat'}
                  </p>
                  <p className="text-xs text-zinc-400 mt-0.5 font-mono">{chat.id.slice(0, 12)}…</p>
                </div>
                {currentChat === chat.id && (
                  <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 shrink-0">
                    Active
                  </Badge>
                )}
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Playground Tab
// ---------------------------------------------------------------------------
function PlaygroundTab() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [model, setModel] = useState('qwen3.7-plus')
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

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
    const assistantMsg: Message = { id: crypto.randomUUID(), role: 'assistant', content: '', streaming: true }
    // Build messages array including prior context for the API
    const apiMessages = [...messages, userMsg].map((m) => ({ role: m.role, content: m.content }))
    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setInput('')
    setStreaming(true)

    const ac = new AbortController()
    abortRef.current = ac

    try {
      const res = await fetch('/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: apiMessages, stream: true }),
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
            setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m)))
            continue
          }
          try {
            const json = JSON.parse(payload)
            const delta = json.choices?.[0]?.delta?.content
            if (delta) {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantMsg.id ? { ...m, content: m.content + delta } : m))
              )
            }
          } catch {}
        }
      }
      setMessages((prev) => prev.map((m) => (m.id === assistantMsg.id ? { ...m, streaming: false } : m)))
    } catch (e: any) {
      if (e.name === 'AbortError') return
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id ? { ...m, streaming: false, error: true, content: `Error: ${e.message}` } : m
        )
      )
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [input, streaming, model, messages])

  const clearChat = () => {
    if (streaming) return
    setMessages([])
    // Also tell the proxy to start a new chat
    fetch('/api/v1/chats/new', { method: 'POST' }).catch(() => {})
  }

  return (
    <div className="flex flex-col h-[calc(100vh-220px)]">
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Select value={model} onValueChange={setModel} disabled={streaming}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="qwen3.7-plus">Qwen3.7-Plus</SelectItem>
              <SelectItem value="qwen3.8-max">Qwen3.8-Max</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {messages.length > 0 && !streaming && (
          <Button variant="ghost" size="sm" onClick={clearChat} className="gap-1.5 text-zinc-500">
            <Trash2 className="w-4 h-4" />
            Clear
          </Button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto" ref={scrollRef}>
        <div className="space-y-4">
          {messages.length === 0 ? (
            <div className="text-center py-12">
              <Terminal className="w-10 h-10 text-zinc-300 mx-auto mb-3" />
              <p className="text-sm text-zinc-500">Send a message to start chatting with Qwen.</p>
              <p className="text-xs text-zinc-400 mt-1">
                Messages are sent through the proxy API — same flow as Cline.
              </p>
            </div>
          ) : (
            messages.map((m) => <MessageBubble key={m.id} message={m} />)
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="mt-3 flex items-end gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Send a message… (Enter to send, Shift+Enter for newline)"
          rows={1}
          className="min-h-[44px] max-h-[150px] resize-none"
          disabled={streaming}
        />
        {streaming ? (
          <Button onClick={stop} variant="destructive" size="icon" className="shrink-0">
            <Square className="w-4 h-4" fill="currentColor" />
          </Button>
        ) : (
          <Button
            onClick={send}
            disabled={!input.trim()}
            className="shrink-0 bg-gradient-to-br from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white"
            size="icon"
          >
            <Send className="w-4 h-4" />
          </Button>
        )}
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
        className={`flex-1 min-w-0 rounded-2xl px-4 py-2.5 max-w-[85%] ${
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

// ---------------------------------------------------------------------------
// Logs Tab
// ---------------------------------------------------------------------------
function LogsTab() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('all')

  const fetchLogs = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/v1/logs?limit=100')
      if (!r.ok) return
      const data = await r.json()
      setLogs(data.data || [])
    } catch {} finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLogs()
    const interval = setInterval(fetchLogs, 5000)
    return () => clearInterval(interval)
  }, [])

  const filtered = filter === 'all' ? logs : logs.filter((l) => l.type === filter)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Request Logs</h2>
          <p className="text-sm text-zinc-500">Live request history. Auto-refreshes every 5s.</p>
        </div>
        <div className="flex gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="chat">Chat</SelectItem>
              <SelectItem value="error">Errors</SelectItem>
              <SelectItem value="chat_select">Chat Select</SelectItem>
              <SelectItem value="new_chat">New Chat</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={fetchLogs} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="space-y-2 max-h-[calc(100vh-300px)] overflow-y-auto">
        {filtered.length === 0 ? (
          <Card className="p-8 text-center">
            <List className="w-8 h-8 text-zinc-300 mx-auto mb-2" />
            <p className="text-sm text-zinc-500">No logs yet. Send a message to see activity.</p>
          </Card>
        ) : (
          filtered.map((log) => <LogRow key={log.id} log={log} />)
        )}
      </div>
    </div>
  )
}

function LogRow({ log }: { log: LogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const time = new Date(log.timestamp).toLocaleTimeString()
  const isError = log.type === 'error'

  return (
    <Card className={`p-3 ${isError ? 'border-red-200 dark:border-red-800' : ''}`}>
      <div
        className="flex items-center justify-between gap-3 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Badge
            variant="outline"
            className={`shrink-0 text-xs ${
              isError
                ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-300'
                : log.type === 'chat'
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300'
                  : 'bg-zinc-50 text-zinc-600 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-400'
            }`}
          >
            {log.type}
          </Badge>
          {log.isContinuation != null && (
            <span className="text-xs text-zinc-400">
              {log.isContinuation ? '↳ continued' : '✦ new chat'}
            </span>
          )}
          <span className="text-xs text-zinc-400 truncate">
            {log.prompt || log.error || ''}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-xs text-zinc-400">
          {log.durationMs != null && <span>{(log.durationMs / 1000).toFixed(1)}s</span>}
          <span>{time}</span>
          {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </div>
      </div>
      {expanded && (
        <div className="mt-3 space-y-2 text-xs">
          {log.model && (
            <div className="flex gap-2">
              <span className="text-zinc-400 w-16">Model</span>
              <code className="text-emerald-600 dark:text-emerald-400">{log.model}</code>
            </div>
          )}
          {log.chatId && (
            <div className="flex gap-2">
              <span className="text-zinc-400 w-16">Chat</span>
              <code className="text-zinc-600 dark:text-zinc-300">{log.chatId.slice(0, 12)}…</code>
            </div>
          )}
          {log.prompt && (
            <div className="flex gap-2">
              <span className="text-zinc-400 w-16">Prompt</span>
              <span className="text-zinc-600 dark:text-zinc-300 break-all">{log.prompt}</span>
            </div>
          )}
          {log.response && (
            <div className="flex gap-2">
              <span className="text-zinc-400 w-16">Response</span>
              <span className="text-zinc-600 dark:text-zinc-300 break-all">{log.response}</span>
            </div>
          )}
          {log.error && (
            <div className="flex gap-2">
              <span className="text-red-400 w-16">Error</span>
              <span className="text-red-600 dark:text-red-400 break-all">{log.error}</span>
            </div>
          )}
          {(log.tokensIn != null || log.tokensOut != null) && (
            <div className="flex gap-2">
              <span className="text-zinc-400 w-16">Tokens</span>
              <span className="text-zinc-600 dark:text-zinc-300">
                ↑{log.tokensIn || 0} ↓{log.tokensOut || 0}
              </span>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Analytics Tab
// ---------------------------------------------------------------------------
function AnalyticsTab({ proxyInfo }: { proxyInfo: any }) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchAnalytics = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/v1/analytics')
      if (!r.ok) return
      const data = await r.json()
      setAnalytics(data)
    } catch {} finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAnalytics()
    const interval = setInterval(fetchAnalytics, 10000)
    return () => clearInterval(interval)
  }, [])

  if (!analytics) {
    return (
      <div className="text-center py-12">
        <BarChart3 className="w-8 h-8 text-zinc-300 mx-auto mb-2" />
        <p className="text-sm text-zinc-500">{loading ? 'Loading…' : 'No analytics data yet.'}</p>
      </div>
    )
  }

  const t = analytics.totals
  const maxHourly = Math.max(...analytics.hourly.map((h) => h.requests), 1)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Analytics</h2>
          <p className="text-sm text-zinc-500">Token usage and request stats. Auto-refreshes every 10s.</p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchAnalytics} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Requests" value={t.requests} icon={Activity} color="emerald" />
        <StatCard label="New Chats" value={t.new_chats} icon={Plus} color="teal" />
        <StatCard label="Continuations" value={t.continuations} icon={RefreshCw} color="cyan" />
        <StatCard label="Errors" value={t.errors} icon={Square} color="red" />
        <StatCard label="Tokens In" value={t.tokens_in} icon={ChevronDown} color="emerald" />
        <StatCard label="Tokens Out" value={t.tokens_out} icon={ChevronUp} color="teal" />
        <StatCard label="Total Tokens" value={t.total_tokens} icon={Zap} color="cyan" />
        <StatCard label="Avg Duration" value={`${(t.avg_duration_ms / 1000).toFixed(1)}s`} icon={Activity} color="emerald" />
      </div>

      {/* Hourly chart */}
      <Card className="p-6">
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-4">Requests (last 24h)</h3>
        <div className="flex items-end gap-1 h-32">
          {analytics.hourly.map((h, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
              <div
                className="w-full bg-gradient-to-t from-emerald-400 to-teal-400 rounded-t group-hover:from-emerald-500 group-hover:to-teal-500 transition-colors"
                style={{ height: `${(h.requests / maxHourly) * 100}%`, minHeight: h.requests > 0 ? '4px' : '0' }}
                title={`${h.hour}: ${h.requests} requests`}
              />
              {i % 4 === 0 && (
                <span className="text-[9px] text-zinc-400 -rotate-45 origin-left">{h.hour.slice(11)}</span>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* By model */}
      {analytics.by_model.length > 0 && (
        <Card className="p-6">
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-4">By Model</h3>
          <div className="space-y-2">
            {analytics.by_model.map((m) => (
              <div key={m.model} className="flex items-center justify-between">
                <code className="text-sm text-emerald-600 dark:text-emerald-400">{m.model}</code>
                <div className="flex items-center gap-4 text-sm text-zinc-600 dark:text-zinc-300">
                  <span>{m.count} reqs</span>
                  <span className="text-zinc-400">↑{m.tokensIn} ↓{m.tokensOut}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string
  value: number | string
  icon: any
  color: string
}) {
  const colors: Record<string, string> = {
    emerald: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30',
    teal: 'text-teal-600 dark:text-teal-400 bg-teal-50 dark:bg-teal-950/30',
    cyan: 'text-cyan-600 dark:text-cyan-400 bg-cyan-50 dark:bg-cyan-950/30',
    red: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30',
  }
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-zinc-500">{label}</span>
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${colors[color]}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
      </div>
      <p className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </p>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Settings Tab
// ---------------------------------------------------------------------------
function SettingsTab({ proxyInfo }: { proxyInfo: any }) {
  const [mode, setMode] = useState({
    thinking: true,
    search: false,
    deep_research: false,
  })
  const [saved, setSaved] = useState(false)

  // Sync mode from proxy info
  useEffect(() => {
    if (proxyInfo?.mode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMode(proxyInfo.mode)
    }
  }, [proxyInfo?.mode])

  const updateMode = async (key: string, value: boolean) => {
    const newMode = { ...mode, [key]: value }
    setMode(newMode)
    try {
      await fetch('/api/v1/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } catch {}
  }

  const newChat = async () => {
    await fetch('/api/v1/chats/new', { method: 'POST' })
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Settings</h2>
        <p className="text-sm text-zinc-500">Configure chat modes and active session.</p>
      </div>

      <Card className="p-6 space-y-4">
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Chat Modes</h3>
        <p className="text-xs text-zinc-400 -mt-2">
          Qwen's "Auto" mode handles mode selection automatically. These toggles are tracked for logging.
        </p>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">Thinking Mode</Label>
            <p className="text-xs text-zinc-400">Enable deep reasoning before answering</p>
          </div>
          <Switch checked={mode.thinking} onCheckedChange={(v) => updateMode('thinking', v)} />
        </div>
        <Separator />
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">Web Search</Label>
            <p className="text-xs text-zinc-400">Search the web for current information</p>
          </div>
          <Switch checked={mode.search} onCheckedChange={(v) => updateMode('search', v)} />
        </div>
        <Separator />
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">Deep Research</Label>
            <p className="text-xs text-zinc-400">Extended multi-step research mode</p>
          </div>
          <Switch checked={mode.deep_research} onCheckedChange={(v) => updateMode('deep_research', v)} />
        </div>

        {saved && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1">
            <Check className="w-3 h-3" /> Settings saved
          </p>
        )}
      </Card>

      <Card className="p-6 space-y-3">
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Session</h3>
        {proxyInfo?.current_chat && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-500">Active Chat</span>
            <code className="text-xs text-zinc-600 dark:text-zinc-300">
              {proxyInfo.current_chat.slice(0, 12)}…
            </code>
          </div>
        )}
        <Button onClick={newChat} variant="outline" className="w-full gap-2">
          <Plus className="w-4 h-4" />
          Start New Chat
        </Button>
      </Card>

      <Card className="p-6 space-y-3">
        <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Proxy Info</h3>
        {proxyInfo && (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">Status</span>
              <span className="text-emerald-600 dark:text-emerald-400">{proxyInfo.status}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Uptime</span>
              <span className="text-zinc-600 dark:text-zinc-300">
                {Math.floor((proxyInfo.uptime_s || 0) / 60)}m {(proxyInfo.uptime_s || 0) % 60}s
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Requests handled</span>
              <span className="text-zinc-600 dark:text-zinc-300">{proxyInfo.requests_handled}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-500">Browser URL</span>
              <code className="text-xs text-zinc-600 dark:text-zinc-300 truncate max-w-[200px]">
                {proxyInfo.browser_url}
              </code>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
