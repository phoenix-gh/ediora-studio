'use client'

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Bot, FileSearch, Loader2, Maximize2, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'
import type { ChatModelSelection } from '@/lib/ai/chat-model-catalog'
import type { ChatComposerMessagePart } from '@/lib/api/chat'

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
  const {
    state,
    sessions,
    activeSessionId,
    messages,
    isActiveLoading,
    isActiveRunning,
    isActiveControlling,
    activeError,
    skills,
    drafts,
    refreshSessions,
    openSession,
    startNewConversation,
    renameSession,
    removeSession,
    submit,
    stop,
    respondToApproval,
    setSkillName,
    setDraftId,
    setPipelineInvocations,
    retrySession,
  } = useChatWorkspace()
  const [listLoading, setListLoading] = useState(true)
  const [input, setInput] = useState('')
  const [pendingDelete, setPendingDelete] = useState<{ id: number; title: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
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
    void openSession(sessionId).catch(error => toast.error(errorText(error, '加载会话失败')))
  }

  function handleNewConversation() {
    initializedRef.current = true
    startNewConversation()
    setInput('')
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
    const session = sessions.find(item => item.id === sessionId)
    if (session) setPendingDelete({ id: session.id, title: session.title || '新对话' })
  }

  async function confirmDeleteSession() {
    if (!pendingDelete || deleting) return
    setDeleting(true)
    try {
      await removeSession(pendingDelete.id)
      setPendingDelete(null)
    } catch (error) {
      toast.error(errorText(error, '删除会话失败'))
    } finally {
      setDeleting(false)
    }
  }

  async function handleSubmit(
    value: string,
    messageParts: ChatComposerMessagePart[],
    modelSelection: ChatModelSelection,
  ) {
    if (!value.trim()) return false
    initializedRef.current = true
    try {
      return await submit(value, messageParts, modelSelection)
    } catch (error) {
      toast.error(errorText(error, '发送消息失败'))
      return false
    }
  }

  function handleApproval(runId: string, toolCallId: string, approvalId: string, approved: boolean) {
    if (activeSessionId === null) return
    void respondToApproval({
      sessionId: activeSessionId,
      runId,
      toolCallId,
      approvalId,
      approved,
    })
  }

  const isFloating = variant === 'floating'
  const showEmptyState = messages.length === 0 && !isActiveLoading
  const latestMessage = messages.at(-1)
  const hasInlineAssistantActivity = latestMessage?.role === 'assistant'
    && latestMessage.parts.length > 0

  return (
    <div className="flex h-full min-h-0 min-w-0 bg-surface">
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
            'flex items-center justify-between gap-3 border-border',
            isFloating
              ? 'min-h-14 cursor-move select-none border-b px-3 py-2'
              : 'h-[var(--app-header-height)] min-h-[var(--app-header-height)] py-4',
          )}
        >
          <div className={cn(
            chatConversationColumn,
            'flex min-w-0 items-center gap-2',
            isFloating ? 'mx-0 max-w-none px-0' : 'justify-between gap-3',
          )}>
            <div className={cn('flex min-w-0 items-center gap-2', isFloating && 'flex-1')}>
              <FileSearch className="h-4 w-4 shrink-0 text-indigo-600" />
              {isFloating ? (
                <h2 className="shrink-0 truncate font-medium text-foreground">AI 助手</h2>
              ) : (
                <div className="min-w-0">
                  <h2 className="truncate font-medium text-foreground">全局研究助手</h2>
                  <p className="truncate text-xs text-muted-foreground">可检索写作方案；所有工具调用均会记录。</p>
                </div>
              )}
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
                      size="icon-sm"
                      data-testid="floating-chat-reset-size"
                      aria-label="恢复聊天窗口默认大小"
                      title="恢复默认大小"
                      onClick={onResetSize}
                    >
                      <RotateCcw aria-hidden="true" />
                    </Button>
                  )}
                </>
              )}
              {isFloating && onClose && (
                <Button type="button" variant="ghost" size="icon-sm" aria-label="关闭聊天助手" title="关闭聊天助手" onClick={onClose}>
                  <X />
                </Button>
              )}
            </div>
          </div>
        </header>

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
              <ChatMessageView
                key={String(message.id)}
                message={message}
                onApproval={handleApproval}
                onPipelineTerminal={activeSessionId === null ? undefined : () => void retrySession(activeSessionId)}
              />
            ))}
            {isActiveRunning && !hasInlineAssistantActivity && (
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
          pipelineInvocations={state.composer.pipelineInvocations}
          disabled={isActiveControlling}
          running={isActiveRunning}
          onStop={() => void stop()}
          variant={variant}
          onChange={setInput}
          onSkillNameChange={skillName => setSkillName(skillName ?? '')}
          onDraftIdChange={draftId => setDraftId(draftId ?? null)}
          onPipelineInvocationsChange={setPipelineInvocations}
          onSubmit={handleSubmit}
        />
      </section>
      <AlertDialog open={pendingDelete !== null} onOpenChange={open => {
        if (!open && !deleting) setPendingDelete(null)
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除会话？</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除会话“{pendingDelete?.title}”？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void confirmDeleteSession()}>
              {deleting ? '删除中…' : '删除'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
