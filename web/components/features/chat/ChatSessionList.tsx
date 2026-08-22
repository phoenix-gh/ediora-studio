'use client'

import { useState } from 'react'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ChatSession } from '@/lib/api/chat'
import { cn } from '@/lib/utils'

export type ChatSessionListProps = {
  sessions: ChatSession[]
  activeSessionId: number | null
  runningBySession: Record<string, boolean>
  loading: boolean
  variant: 'page' | 'floating'
  onOpenSession: (sessionId: number) => void
  onNewConversation: () => void
  onRenameSession: (sessionId: number, title: string) => Promise<void>
  onDeleteSession: (sessionId: number) => Promise<void>
}

function displayTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

export function ChatSessionList({
  sessions,
  activeSessionId,
  runningBySession,
  loading,
  variant,
  onOpenSession,
  onNewConversation,
  onRenameSession,
  onDeleteSession,
}: ChatSessionListProps) {
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const isFloating = variant === 'floating'

  async function saveSessionTitle(session: ChatSession) {
    if (editingSessionId !== session.id) return
    await onRenameSession(session.id, editingTitle.trim() || '新对话')
    setEditingSessionId(null)
    setEditingTitle('')
  }

  async function removeSession(session: ChatSession) {
    if (typeof window !== 'undefined' && !window.confirm(`删除会话“${session.title || '新对话'}”？此操作不可恢复。`)) return
    await onDeleteSession(session.id)
  }

  return (
    <aside
      data-slot="chat-session-list"
      className={cn(
        'flex min-h-0 shrink-0 flex-col bg-surface',
        isFloating ? 'max-h-56 border-b border-border' : 'w-72 border-r border-border',
      )}
    >
      <div className={cn(
        'flex items-center justify-between gap-3 border-border px-4 py-3',
        isFloating ? 'min-h-14' : 'h-[var(--app-header-height)] min-h-[var(--app-header-height)] border-b',
      )}>
        <div className="min-w-0">
          <h1 className="font-semibold text-foreground">AI 助手</h1>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">搜索并阅读本地信息源</p>
        </div>
        <Button
          type="button"
          size="icon-sm"
          title="新建对话"
          aria-label="新建对话"
          onClick={onNewConversation}
        >
          <Plus />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />加载会话…
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            还没有对话。<br />开始提问即可新建。
          </div>
        ) : sessions.map(session => {
          const title = session.title || '新对话'
          const isRunning = Boolean(runningBySession[String(session.id)])
          return (
            <div key={session.id} className="group relative mb-1">
              {editingSessionId === session.id ? (
                <div className="rounded-lg px-2 py-2">
                  <Input
                    autoFocus
                    value={editingTitle}
                    onChange={event => setEditingTitle(event.target.value)}
                    onBlur={() => void saveSessionTitle(session)}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void saveSessionTitle(session)
                      }
                      if (event.key === 'Escape') {
                        setEditingSessionId(null)
                        setEditingTitle('')
                      }
                    }}
                    aria-label="会话名称"
                    className="h-8 text-sm"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onOpenSession(session.id)}
                  aria-label={title}
                  className={cn(
                    'w-full rounded-lg px-3 py-2.5 pr-16 text-left transition-colors',
                    activeSessionId === session.id
                      ? 'bg-indigo-50 text-indigo-950 dark:bg-indigo-950/40 dark:text-indigo-100'
                      : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="block min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
                    {isRunning && <Loader2 aria-label="运行中" className="h-3.5 w-3.5 shrink-0 animate-spin text-indigo-500" />}
                  </span>
                  <span className="mt-1 block text-[11px] text-foreground-subtle">{displayTime(session.updated_at)}</span>
                </button>
              )}
              {editingSessionId !== session.id && (
                <button
                  type="button"
                  title="重命名会话"
                  aria-label={`重命名会话：${title}`}
                  onClick={event => {
                    event.stopPropagation()
                    setEditingSessionId(session.id)
                    setEditingTitle(session.title || '')
                  }}
                  className="absolute right-8 top-1/2 -translate-y-1/2 rounded p-1 text-foreground-subtle opacity-0 transition hover:bg-muted hover:text-indigo-600 group-hover:opacity-100 focus:opacity-100"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                title="删除会话"
                aria-label={`删除会话：${title}`}
                onClick={event => {
                  event.stopPropagation()
                  void removeSession(session)
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-foreground-subtle opacity-0 transition hover:bg-muted hover:text-red-600 group-hover:opacity-100 focus:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
