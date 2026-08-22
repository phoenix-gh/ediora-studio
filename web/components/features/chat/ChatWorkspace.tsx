'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Activity, Bot, FileSearch, Loader2, Maximize2, X } from 'lucide-react'
import { toast } from 'sonner'

import { ChatAgentLogDialog } from '@/components/features/chat/ChatAgentLogDialog'
import { useDeveloperMode } from '@/components/providers/DeveloperModeProvider'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { chatConversationColumn } from '@/app/chat/chat-layout'

import { ChatComposer } from './ChatComposer'
import { ChatMessageView } from './ChatMessageView'
import { ChatSessionList } from './ChatSessionList'
import { useChatWorkspace } from './ChatWorkspaceProvider'

export type ChatWorkspaceProps = {
  variant: 'page' | 'floating'
  onClose?: () => void
  onOpenFullChat?: () => void
  onResetSize?: () => void
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function ChatWorkspace({ variant, onClose, onOpenFullChat, onResetSize, onHeaderPointerDown }: ChatWorkspaceProps) {
  const developerModeEnabled = useDeveloperMode()
  const {
    state,
    sessions,
    activeSessionId,
    messages,
    isActiveLoading,
    isActiveRunning,
    activeError,
    skills,
    drafts,
    refreshSessions,
    openSession,
    startNewConversation,
    renameSession,
    removeSession,
    submit,
    respondToApproval,
    setSkillName,
    setDraftId,
    retrySession,
  } = useChatWorkspace()
  const [listLoading, setListLoading] = useState(true)
  const [input, setInput] = useState('')
  const [showTrace, setShowTrace] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)
  const initialActiveSessionIdRef = useRef(activeSessionId)

  useEffect(() => {
    let cancelled = false
    void refreshSessions()
      .then(nextSessions => {
        if (cancelled || initializedRef.current || initialActiveSessionIdRef.current !== null) return
        initializedRef.current = true
        if (nextSessions[0]) {
          void openSession(nextSessions[0].id).catch(error => {
            if (!cancelled) toast.error(errorText(error, '加载会话失败'))
          })
        }
      })
      .catch(error => {
        if (!cancelled) toast.error(errorText(error, '加载会话列表失败'))
      })
      .finally(() => {
        if (!cancelled) setListLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [openSession, refreshSessions])

  useEffect(() => {
    if (!bottomRef.current) return
    bottomRef.current.scrollIntoView?.({ behavior: isActiveRunning ? 'smooth' : 'auto' })
  }, [isActiveRunning, messages])

  function handleOpenSession(sessionId: number) {
    initializedRef.current = true
    setShowTrace(false)
    void openSession(sessionId).catch(error => toast.error(errorText(error, '加载会话失败')))
  }

  function handleNewConversation() {
    initializedRef.current = true
    startNewConversation()
    setInput('')
    setShowTrace(false)
  }

  async function handleRenameSession(sessionId: number, title: string) {
    try {
      await renameSession(sessionId, title)
    } catch (error) {
      toast.error(errorText(error, '修改会话名称失败'))
      throw error
    }
  }

  async function handleDeleteSession(sessionId: number) {
    try {
      await removeSession(sessionId)
    } catch (error) {
      toast.error(errorText(error, '删除会话失败'))
    }
  }

  async function handleSubmit(value: string) {
    if (!value.trim() || isActiveRunning) return
    initializedRef.current = true
    setInput('')
    await submit(value)
  }

  function handleApproval(messageId: number, toolCallId: string, approvalId: string, approved: boolean) {
    if (activeSessionId === null) return
    void respondToApproval({
      sessionId: activeSessionId,
      messageId,
      toolCallId,
      approvalId,
      approved,
    })
  }

  const isFloating = variant === 'floating'
  const showEmptyState = messages.length === 0 && !isActiveLoading

  return (
    <div className="flex h-full min-h-0 bg-surface">
      {!isFloating && (
        <ChatSessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          runningBySession={state.runningBySession}
          loading={listLoading}
          variant="page"
          onOpenSession={handleOpenSession}
          onNewConversation={handleNewConversation}
          onRenameSession={handleRenameSession}
          onDeleteSession={handleDeleteSession}
        />
      )}

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          data-slot="page-header"
          data-testid={isFloating ? 'floating-chat-drag-handle' : undefined}
          onPointerDown={isFloating ? onHeaderPointerDown : undefined}
          className={cn(
            'flex items-center justify-between gap-3 border-border py-4',
            isFloating ? 'min-h-14 cursor-move select-none border-b px-3' : 'h-[var(--app-header-height)] min-h-[var(--app-header-height)]',
          )}
        >
          <div className={cn(chatConversationColumn, 'flex min-w-0 items-center justify-between gap-3', isFloating && 'mx-0 max-w-none px-0')}>
            <div className="flex min-w-0 items-center gap-3">
              <FileSearch className="h-5 w-5 shrink-0 text-indigo-600" />
              <div className="min-w-0">
                <h2 className="truncate font-medium text-foreground">{isFloating ? 'AI 助手' : '全局研究助手'}</h2>
                <p className="truncate text-xs text-muted-foreground">可检索写作方案；所有工具调用均会记录。</p>
              </div>
              {isFloating && (
                <ChatSessionList
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  runningBySession={state.runningBySession}
                  loading={listLoading}
                  variant="floating"
                  onOpenSession={handleOpenSession}
                  onNewConversation={handleNewConversation}
                  onRenameSession={handleRenameSession}
                  onDeleteSession={handleDeleteSession}
                />
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {isFloating && (
                <>
                  {onOpenFullChat && (
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="打开完整聊天" title="打开完整聊天" onClick={onOpenFullChat}>
                      <Maximize2 />
                    </Button>
                  )}
                  {onResetSize && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      data-testid="floating-chat-reset-size"
                      aria-label="恢复聊天窗口默认大小"
                      title="恢复默认大小"
                      onClick={onResetSize}
                    >
                      默认大小
                    </Button>
                  )}
                </>
              )}
              {developerModeEnabled && (
                <Button
                  type="button"
                  variant={showTrace ? 'secondary' : 'outline'}
                  size="sm"
                  disabled={activeSessionId === null}
                  onClick={() => setShowTrace(value => !value)}
                  title="查看本会话的 LLM、Skill 和工具运行轨迹"
                >
                  <Activity data-icon="inline-start" />运行轨迹
                </Button>
              )}
              {isFloating && onClose && (
                <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭聊天助手" title="关闭聊天助手" onClick={onClose}>
                  <X />
                </Button>
              )}
            </div>
          </div>
        </header>

        {developerModeEnabled && (
          <ChatAgentLogDialog
            key={activeSessionId ?? 'none'}
            sessionId={activeSessionId}
            open={showTrace}
            developerModeEnabled={developerModeEnabled}
            onOpenChange={setShowTrace}
          />
        )}

        <div className={cn('min-h-0 flex-1 overflow-y-auto', isFloating ? 'py-4' : 'py-6')}>
          <div className={cn(chatConversationColumn, 'flex flex-col gap-5', isFloating && 'px-3 sm:px-3')}>
            {showEmptyState && (
              <div className="rounded-2xl border border-dashed border-border bg-surface px-6 py-10 text-center">
                <Bot className="mx-auto h-8 w-8 text-indigo-500" />
                <h3 className="mt-3 font-medium text-foreground">还没有对话</h3>
                <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">从本地信息源开始研究，发送第一条消息即可创建会话。</p>
              </div>
            )}
            {isActiveLoading && messages.length === 0 && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />加载会话…
              </div>
            )}
            {messages.map(message => (
              <ChatMessageView key={String(message.id)} message={message} onApproval={handleApproval} />
            ))}
            {isActiveRunning && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />正在思考并检索资料…
              </div>
            )}
            {activeError && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
                <p>{activeError}</p>
                {activeSessionId !== null && (
                  <Button type="button" variant="outline" size="xs" className="mt-2" onClick={() => void retrySession(activeSessionId)}>
                    重试加载
                  </Button>
                )}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <ChatComposer
          value={input}
          skills={skills}
          drafts={drafts}
          skillName={state.composer.skillName}
          draftId={state.composer.draftId}
          disabled={isActiveRunning}
          variant={variant}
          onChange={setInput}
          onSkillNameChange={skillName => setSkillName(skillName ?? '')}
          onDraftIdChange={draftId => setDraftId(draftId ?? null)}
          onSubmit={handleSubmit}
        />
      </section>
    </div>
  )
}
