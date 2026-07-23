'use client'

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Bot, ChevronDown, FileSearch, Loader2, MessageSquarePlus, Plus, Send, Trash2, Wrench } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ChatContextPicker } from '@/components/features/chat/ChatContextPicker'
import { ChatMarkdown } from '@/components/features/chat/ChatMarkdown'
import {
  type ChatMessage,
  type ChatPart,
  type ChatRole,
  type ChatSession,
  type ChatSkill,
  type ChatDraft,
  type UIChatMessage,
  createChatSession,
  deleteChatSession,
  getChatSession,
  listChatDrafts,
  listChatSkills,
  listChatSessions,
  streamChatReply,
} from '@/lib/api/chat'
import { getJob, imageUrlsForJob, type JobStatus } from '@/lib/api/jobs'
import { cn } from '@/lib/utils'

import { chatComposerColumn, chatConversationColumn } from './chat-layout'

type DisplayMessage = Omit<ChatMessage, 'id'> & { id: string | number }

type ToolEventPart = ChatPart & {
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  state?: string
  approval?: { id?: string; approved?: boolean }
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

function activitySummary(parts: ToolEventPart[]) {
  const searches = parts.filter(part => toolName(part) === 'searchInformationSources').length
  const reads = parts.filter(part => toolName(part) === 'readInformationSource').length
  if (searches && reads) return `已检索本地资料，并阅读 ${reads} 条相关内容`
  if (searches) return '已检索本地资料'
  if (reads) return `已阅读 ${reads} 条资料`
  return `已调用 ${parts.length} 项工具`
}

function imageJobId(part: ToolEventPart) {
  if (toolName(part) !== 'generateImage' || !part.output || typeof part.output !== 'object') return null
  const jobId = (part.output as { jobId?: unknown }).jobId
  return typeof jobId === 'number' ? jobId : null
}

function ImageJobPreview({ jobId }: { jobId: number }) {
  const [status, setStatus] = useState<JobStatus | 'loading'>('loading')
  const [urls, setUrls] = useState<string[]>([])
  const [selectedImage, setSelectedImage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined
    const refresh = async () => {
      try {
        const job = await getJob(jobId)
        if (cancelled) return
        setStatus(job.status)
        setUrls(imageUrlsForJob(job))
        if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
          if (timer) clearInterval(timer)
        }
      } catch {
        if (!cancelled) setStatus('failed')
      }
    }
    void refresh()
    timer = setInterval(() => void refresh(), 2_000)
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [jobId])

  return <>
    {urls.length > 0 ? <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {urls.map(url => <button type="button" onClick={() => setSelectedImage(url)} key={url} className="block overflow-hidden rounded-lg border border-indigo-100 bg-white text-left dark:border-indigo-900 dark:bg-zinc-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="AI 生成图片" className="aspect-video w-full object-cover" />
      </button>)}
    </div> : status === 'failed' || status === 'cancelled'
      ? <p className="mt-2 text-xs text-red-600">图片生成失败</p>
      : <p className="mt-2 text-xs text-indigo-600">图片生成中…</p>}
    <Dialog open={selectedImage !== null} onOpenChange={open => !open && setSelectedImage(null)}>
      <DialogContent className="max-w-5xl p-3">
        <DialogHeader className="sr-only">
          <DialogTitle>AI 生成图片预览</DialogTitle>
          <DialogDescription>点击遮罩或关闭按钮返回聊天。</DialogDescription>
        </DialogHeader>
        {selectedImage && <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={selectedImage} alt="AI 生成图片预览" className="max-h-[80vh] w-full object-contain" />
        </>}
      </DialogContent>
    </Dialog>
  </>
}

function ToolActivityGroup({ parts, onApproval }: { parts: ToolEventPart[]; onApproval?: (toolCallId: string, approvalId: string, approved: boolean) => void }) {
  const imageJobIds = [...new Set(parts.map(imageJobId).filter((jobId): jobId is number => jobId !== null))]
  return (
    <div>
      <details className="rounded-lg bg-indigo-50/60 px-3 py-2 text-xs text-indigo-950 dark:bg-indigo-950/30 dark:text-indigo-100">
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
          <Wrench className="h-3.5 w-3.5 text-indigo-500" />
          <span>{activitySummary(parts)}</span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform [[open]_&]:rotate-180" />
        </summary>
        <ul className="mt-2 space-y-1 text-indigo-700 dark:text-indigo-200">
          {parts.map((part, index) => {
            const label = toolLabels[toolName(part)] ?? toolName(part)
            const pending = part.state === 'approval-requested' && part.toolCallId && part.approval?.id
            const status = pending ? '等待确认' : part.state === 'running' ? '进行中' : part.state === 'approval-responded' ? (part.approval?.approved ? '已批准' : '已拒绝') : '已完成'
            return <li key={part.toolCallId ?? `${part.type}-${index}`} className="flex flex-wrap items-center justify-between gap-3"><span>{label}</span>{pending && onApproval ? <span className="flex items-center gap-1"><Button type="button" size="xs" onClick={() => onApproval(part.toolCallId!, part.approval!.id!, true)}>批准</Button><Button type="button" size="xs" variant="outline" onClick={() => onApproval(part.toolCallId!, part.approval!.id!, false)}>拒绝</Button></span> : <span className="text-indigo-500">{status}</span>}</li>
          })}
        </ul>
      </details>
      {imageJobIds.map(jobId => <ImageJobPreview key={jobId} jobId={jobId} />)}
    </div>
  )
}

function MessageBubble({ message, onApproval }: { message: DisplayMessage; onApproval?: (messageId: number, toolCallId: string, approvalId: string, approved: boolean) => void }) {
  const isUser = message.role === 'user'
  const textParts = message.parts.filter(part => part.type === 'text')
  const toolParts = message.parts.filter(isToolPart) as ToolEventPart[]
  const fallbackText = textParts.length === 0 && message.text ? message.text : ''
  const persistedMessageId = typeof message.id === 'number' ? message.id : undefined

  if (message.role === 'tool') {
    return null
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
        {toolParts.length > 0 && <ToolActivityGroup parts={toolParts} onApproval={persistedMessageId ? (toolCallId, approvalId, approved) => onApproval?.(persistedMessageId, toolCallId, approvalId, approved) : undefined} />}
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
  const [skills, setSkills] = useState<ChatSkill[]>([])
  const [drafts, setDrafts] = useState<ChatDraft[]>([])
  const [skillName, setSkillName] = useState('')
  const [draftId, setDraftId] = useState('')
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
    void Promise.all([listChatSkills(), listChatDrafts()])
      .then(([nextSkills, nextDrafts]) => { setSkills(nextSkills); setDrafts(nextDrafts) })
      .catch(error => toast.error(error instanceof Error ? error.message : '加载技能或草稿失败'))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: sending ? 'smooth' : 'auto' })
  }, [messages, sending])

  function startNewConversation() {
    setActiveSessionId(null)
    setMessages([])
    setInput('')
    setSkillName('')
    setDraftId('')
  }

  async function removeSession(session: ChatSession) {
    if (!window.confirm(`删除会话“${session.title || '新对话'}”？此操作不可恢复。`)) return
    try {
      await deleteChatSession(session.id)
      setSessions(current => current.filter(currentSession => currentSession.id !== session.id))
      if (activeSessionId === session.id) startNewConversation()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除会话失败')
    }
  }

  async function respondToApproval(messageId: number, toolCallId: string, approvalId: string, approved: boolean) {
    if (!activeSessionId || sending) return
    setSending(true)
    try {
      await streamChatReply({
        sessionId: activeSessionId,
        messages: [],
        skillName: skillName || undefined,
        draftId: draftId ? Number(draftId) : undefined,
        approval: { messageId, toolCallId, approvalId, approved },
        onEvent: () => undefined,
      })
      const session = await getChatSession(activeSessionId)
      setMessages(session.messages)
      await refreshSessions()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '处理工具确认失败')
    } finally {
      setSending(false)
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
        skillName: skillName || undefined,
        draftId: draftId ? Number(draftId) : undefined,
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
            <Button size="icon-sm" title="新建对话" onClick={startNewConversation}><Plus /></Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? <div className="flex items-center gap-2 px-3 py-4 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />加载会话…</div> : sessions.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-zinc-500">还没有对话。<br />开始提问即可新建。</div>
          ) : sessions.map(session => (
            <div key={session.id} className="group relative mb-1">
              <button type="button" onClick={() => void openSession(session.id)}
                className={cn('w-full rounded-lg px-3 py-2.5 pr-9 text-left transition-colors', activeSessionId === session.id ? 'bg-indigo-50 text-indigo-950 dark:bg-indigo-950/40 dark:text-indigo-100' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900')}>
                <span className="block truncate text-sm font-medium">{session.title || '新对话'}</span>
                <span className="mt-1 block text-[11px] text-zinc-400">{displayTime(session.updated_at)}</span>
              </button>
              <button type="button" title="删除会话" aria-label={`删除会话：${session.title || '新对话'}`} onClick={event => { event.stopPropagation(); void removeSession(session) }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-400 opacity-0 transition hover:bg-zinc-200 hover:text-red-600 group-hover:opacity-100 focus:opacity-100 dark:hover:bg-zinc-800">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
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
            {messages.map(message => <MessageBubble key={String(message.id)} message={message} onApproval={respondToApproval} />)}
            {sending && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />正在思考并检索资料…</div>}
            <div ref={bottomRef} />
          </div>
        </div>

        <form onSubmit={submit} className="py-4">
          <div className={chatComposerColumn}>
            <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-3 transition-colors focus-within:border-indigo-400 dark:border-zinc-700 dark:bg-zinc-900">
              <div className="flex">
                <textarea value={input} onChange={event => setInput(event.target.value)} disabled={sending} rows={2}
                  placeholder="问问本地信息源里的内容…"
                  className="max-h-40 min-h-12 flex-1 resize-none bg-transparent py-1 text-sm leading-6 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed" />
              </div>
              <ChatContextPicker
                skills={skills}
                drafts={drafts}
                skillName={skillName || undefined}
                draftId={draftId ? Number(draftId) : undefined}
                disabled={sending}
                footerAction={<Button type="submit" size="icon" disabled={!input.trim() || sending} title="发送消息">
                  {sending ? <Loader2 className="animate-spin" /> : <Send />}
                </Button>}
                onSkillNameChange={skill => setSkillName(skill ?? '')}
                onDraftIdChange={draft => setDraftId(draft ? String(draft) : '')}
              />
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-400"><MessageSquarePlus className="h-3 w-3" />新对话会在发送第一条消息时创建。</p>
          </div>
        </form>
      </section>
    </div>
  )
}
