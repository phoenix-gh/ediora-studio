'use client'

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, FileSearch, Loader2, MessageSquarePlus, Plus, Send, Wrench } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { ChatMarkdown } from '@/components/features/chat/ChatMarkdown'
import {
  type ChatMessage,
  type ChatPart,
  type ChatRole,
  type ChatSession,
  type UIChatMessage,
  createChatSession,
  getChatSession,
  listChatSessions,
  streamChatReply,
} from '@/lib/api/chat'
import { cn } from '@/lib/utils'

import { chatComposerColumn, chatConversationColumn } from './chat-layout'

type DisplayMessage = Omit<ChatMessage, 'id'> & { id: string | number }

type ToolEventPart = ChatPart & {
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  state?: string
}

const toolLabels: Record<string, string> = {
  searchInformationSources: '检索信息源',
  readInformationSource: '读取信息源',
}

function displayTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function isToolPart(part: ChatPart) {
  return part.type === 'tool-event' || part.type === 'tool-result' || part.type.startsWith('tool-')
}

function toolName(part: ToolEventPart) {
  if (typeof part.toolName === 'string') return part.toolName
  return part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : '工具调用'
}

function toolDetails(part: ToolEventPart) {
  const details: Record<string, unknown> = {}
  if (part.state) details.state = part.state
  if (part.input !== undefined) details.input = part.input
  if (part.output !== undefined) details.output = part.output
  const extra = Object.fromEntries(Object.entries(part).filter(([key]) => ![
    'type', 'toolCallId', 'toolName', 'state', 'input', 'output',
  ].includes(key)))
  if (Object.keys(extra).length > 0) details.details = extra
  return details
}

function ToolEvent({ part }: { part: ToolEventPart }) {
  const name = toolName(part)
  const details = toolDetails(part)
  const label = toolLabels[name] ?? name

  return (
    <details className="rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-950 dark:border-indigo-950 dark:bg-indigo-950/30 dark:text-indigo-100">
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
        <Wrench className="h-3.5 w-3.5 text-indigo-500" />
        <span>{label}</span>
        <span className="text-indigo-500">{part.state === 'running' ? '正在执行…' : part.state === 'completed' ? '已完成' : '已调用'}</span>
        <ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform [[open]_&]:rotate-180" />
      </summary>
      {Object.keys(details).length > 0 && (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-white/70 p-2 font-mono text-[11px] leading-relaxed text-zinc-600 dark:bg-zinc-950/70 dark:text-zinc-300">
          {JSON.stringify(details, null, 2)}
        </pre>
      )}
    </details>
  )
}

function MessageBubble({ message }: { message: DisplayMessage }) {
  const isUser = message.role === 'user'
  const textParts = message.parts.filter(part => part.type === 'text')
  const toolParts = message.parts.filter(isToolPart)
  const fallbackText = textParts.length === 0 && message.text ? message.text : ''

  if (message.role === 'tool') {
    const auditParts = toolParts.length > 0 ? toolParts : message.parts
    return <div className="max-w-3xl space-y-2">{auditParts.map((part, index) => <ToolEvent key={`${message.id}-${index}`} part={part} />)}</div>
  }

  return (
    <article className={cn('flex', isUser && 'justify-end')}>
      <div className={isUser ? 'min-w-0 max-w-3xl space-y-2' : 'w-full min-w-0 space-y-2'}>
        {(textParts.length > 0 || fallbackText) && (
          <div className={cn(
            'break-words rounded-2xl px-3 py-2 text-sm leading-6',
            isUser && 'whitespace-pre-wrap',
            isUser
              ? 'rounded-tr-sm bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'text-zinc-800 dark:text-zinc-100',
          )}>
            {isUser
              ? (textParts.length > 0 ? textParts.map((part, index) => <span key={`${message.id}-text-${index}`}>{String(part.text ?? '')}</span>) : fallbackText)
              : (textParts.length > 0
                  ? textParts.map((part, index) => <ChatMarkdown key={`${message.id}-text-${index}`} content={String(part.text ?? '')} />)
                  : <ChatMarkdown content={fallbackText} />)}
          </div>
        )}
        {toolParts.map((part, index) => <ToolEvent key={`${message.id}-tool-${index}`} part={part} />)}
        <time className={cn('block px-1 text-[11px] text-zinc-400', isUser && 'text-right')}>{displayTime(message.created_at)}</time>
      </div>
    </article>
  )
}

function toModelMessages(messages: DisplayMessage[]): UIChatMessage[] {
  return messages
    .filter((message): message is DisplayMessage & { role: Exclude<ChatRole, 'tool'> } => message.role !== 'tool')
    .map(message => ({ id: String(message.id), role: message.role, parts: message.parts }))
}

function makeLocalMessage(role: Exclude<ChatRole, 'tool'>, parts: ChatPart[]): DisplayMessage {
  return {
    id: `local-${crypto.randomUUID()}`,
    role,
    parts,
    text: parts.filter(part => part.type === 'text').map(part => String(part.text ?? '')).join(''),
    created_at: new Date().toISOString(),
  }
}

export function ChatClient() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null)
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const refreshSessions = useCallback(async () => {
    const nextSessions = await listChatSessions()
    setSessions(nextSessions)
    return nextSessions
  }, [])

  const openSession = useCallback(async (sessionId: number) => {
    setActiveSessionId(sessionId)
    try {
      const session = await getChatSession(sessionId)
      setMessages(session.messages)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '加载会话失败')
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
      .catch(error => toast.error(error instanceof Error ? error.message : '加载会话列表失败'))
      .finally(() => setLoading(false))
  }, [refreshSessions])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: sending ? 'smooth' : 'auto' })
  }, [messages, sending])

  async function createSession() {
    try {
      const session = await createChatSession()
      setSessions(current => [session, ...current])
      setActiveSessionId(session.id)
      setMessages([])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建会话失败')
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = input.trim()
    if (!text || sending) return

    let sessionId = activeSessionId
    if (!sessionId) {
      try {
        const session = await createChatSession()
        setSessions(current => [session, ...current])
        setActiveSessionId(session.id)
        sessionId = session.id
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '创建会话失败')
        return
      }
    }

    const userMessage = makeLocalMessage('user', [{ type: 'text', text }])
    const assistantMessage = makeLocalMessage('assistant', [])
    const requestMessages = toModelMessages([...messages, userMessage])
    setMessages(current => [...current, userMessage, assistantMessage])
    setInput('')
    setSending(true)

    const updateAssistant = (update: (parts: ChatPart[]) => ChatPart[]) => {
      setMessages(current => current.map(message => message.id === assistantMessage.id
        ? { ...message, parts: update(message.parts) }
        : message))
    }

    try {
      await streamChatReply({
        sessionId,
        messages: requestMessages,
        onEvent: event => {
          if (event.type === 'text-delta') {
            const partId = typeof event.id === 'string' ? event.id : 'text'
            const delta = typeof event.delta === 'string' ? event.delta : ''
            updateAssistant(parts => {
              const index = parts.findIndex(part => part.type === 'text' && part.id === partId)
              if (index < 0) return [...parts, { type: 'text', id: partId, text: delta }]
              return parts.map((part, currentIndex) => currentIndex === index
                ? { ...part, text: `${String(part.text ?? '')}${delta}` }
                : part)
            })
          }
          if (event.type === 'tool-input-start' || event.type === 'tool-input-available' || event.type === 'tool-output-available') {
            const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : crypto.randomUUID()
            updateAssistant(parts => {
              const current = parts.find(part => part.type === 'tool-event' && part.toolCallId === toolCallId) as ToolEventPart | undefined
              const next: ToolEventPart = {
                ...(current ?? { type: 'tool-event', toolCallId }),
                toolName: typeof event.toolName === 'string' ? event.toolName : current?.toolName,
                input: event.type === 'tool-input-available' ? event.input : current?.input,
                output: event.type === 'tool-output-available' ? event.output : current?.output,
                state: event.type === 'tool-output-available' ? 'completed' : 'running',
              }
              return current ? parts.map(part => part === current ? next : part) : [...parts, next]
            })
          }
          if (event.type === 'error') {
            const detail = typeof event.errorText === 'string' ? event.errorText : '聊天响应失败'
            updateAssistant(parts => [...parts, { type: 'text', text: `\n${detail}` }])
          }
        },
      })
      const session = await getChatSession(sessionId)
      setMessages(session.messages)
      await refreshSessions()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '发送消息失败')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 bg-white dark:bg-zinc-950">
      <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="border-b border-zinc-100 px-4 py-4 dark:border-zinc-800">
          <div className="flex items-center justify-between gap-3">
            <div><h1 className="font-semibold text-zinc-900 dark:text-zinc-100">AI 助手</h1><p className="mt-0.5 text-xs text-zinc-500">搜索并阅读本地信息源</p></div>
            <Button size="icon-sm" title="新建对话" onClick={() => void createSession()}><Plus /></Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />加载会话…</div> : sessions.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-zinc-500">还没有对话。<br />开始提问即可新建。</div>
          ) : sessions.map(session => (
            <button key={session.id} type="button" onClick={() => void openSession(session.id)}
              className={cn('mb-1 w-full rounded-lg px-3 py-2.5 text-left transition-colors', activeSessionId === session.id ? 'bg-indigo-50 text-indigo-950 dark:bg-indigo-950/40 dark:text-indigo-100' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900')}>
              <span className="block truncate text-sm font-medium">{session.title || '新对话'}</span>
              <span className="mt-1 block text-[11px] text-zinc-400">{displayTime(session.updated_at)}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="py-4">
          <div className={cn(chatConversationColumn, 'flex items-center gap-3')}>
            <FileSearch className="h-5 w-5 text-indigo-600" />
            <div><h2 className="font-medium text-zinc-900 dark:text-zinc-100">全局研究助手</h2><p className="text-xs text-zinc-500">可检索写作方案与参考素材；所有工具调用均会记录。</p></div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto py-6">
          <div className={cn(chatConversationColumn, 'flex flex-col gap-5')}>
            {messages.length === 0 && !loading && (
              <div className="rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
                <Bot className="mx-auto h-8 w-8 text-indigo-500" />
                <h3 className="mt-3 font-medium text-zinc-900 dark:text-zinc-100">从本地信息源开始研究</h3>
                <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-zinc-500">例如：“素材库里有哪些适合 AI 编程主题的观点？” 我会在需要时调用只读搜索工具。</p>
              </div>
            )}
            {messages.map(message => <MessageBubble key={String(message.id)} message={message} />)}
            {sending && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />正在思考并检索资料…</div>}
            <div ref={bottomRef} />
          </div>
        </div>

        <form onSubmit={submit} className="py-4">
          <div className={chatComposerColumn}>
            <div className="flex items-end gap-3 rounded-xl border border-zinc-200 bg-white p-3 transition-colors focus-within:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900">
              <textarea value={input} onChange={event => setInput(event.target.value)} disabled={sending} rows={2}
                placeholder="问问本地信息源里的内容…"
                className="max-h-40 min-h-12 flex-1 resize-none bg-transparent py-1 text-sm leading-6 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed" />
              <Button type="submit" size="icon" disabled={!input.trim() || sending} title="发送消息">
                {sending ? <Loader2 className="animate-spin" /> : <Send />}
              </Button>
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-400"><MessageSquarePlus className="h-3 w-3" />新对话会在发送第一条消息时创建。</p>
          </div>
        </form>
      </section>
    </div>
  )
}
