'use client'

import { useEffect, useState } from 'react'
import { ChevronDown, Wrench } from 'lucide-react'

import { ChatMarkdown } from '@/components/features/chat/ChatMarkdown'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getJob, imageUrlsForJob, type JobStatus } from '@/lib/api/jobs'
import {
  chatToolName,
  chatToolStatus,
  generatedImageUrls,
  imageGenerationSummary,
  isChatToolPart,
  legacyImageJobId,
} from '@/app/chat/chat-tool-parts'
import { cn } from '@/lib/utils'

import type { DisplayMessage, ToolEventPart } from './chat-workspace-types'

const toolLabels: Record<string, string> = {
  searchInformationSources: '检索信息源',
  readInformationSource: '读取信息源',
  generateImage: '生成图片',
}

export type ChatApprovalHandler = (
  messageId: number,
  toolCallId: string,
  approvalId: string,
  approved: boolean,
) => void

function displayTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function activitySummary(parts: ToolEventPart[]) {
  const searches = parts.filter(part => chatToolName(part) === 'searchInformationSources').length
  const reads = parts.filter(part => chatToolName(part) === 'readInformationSource').length
  const images = imageGenerationSummary(parts)
  if (searches && reads) return '已检索本地资料，并阅读 ' + reads + ' 条相关内容'
  if (searches) return '已检索本地资料'
  if (reads) return '已阅读 ' + reads + ' 条资料'
  if (images) return images
  return '已调用 ' + parts.length + ' 项工具'
}

function GeneratedImagePreview({ urls }: { urls: string[] }) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null)
  if (urls.length === 0) return null

  return <>
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {urls.map(url => (
        <button
          type="button"
          onClick={() => setSelectedImage(url)}
          key={url}
          className="block overflow-hidden rounded-lg border border-indigo-100 bg-surface text-left dark:border-indigo-900"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="AI 生成图片" className="aspect-video w-full object-cover" />
        </button>
      ))}
    </div>
    <Dialog open={selectedImage !== null} onOpenChange={open => !open && setSelectedImage(null)}>
      <DialogContent className="max-w-5xl p-3">
        <DialogHeader className="sr-only">
          <DialogTitle>AI 生成图片预览</DialogTitle>
          <DialogDescription>点击遮罩或关闭按钮返回聊天。</DialogDescription>
        </DialogHeader>
        {selectedImage && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={selectedImage} alt="AI 生成图片预览" className="max-h-[80vh] w-full object-contain" />
          </>
        )}
      </DialogContent>
    </Dialog>
  </>
}

function ImageJobPreview({ jobId }: { jobId: number }) {
  const [status, setStatus] = useState<JobStatus | 'loading'>('loading')
  const [urls, setUrls] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try {
        const job = await getJob(jobId)
        if (cancelled) return
        setStatus(job.status)
        setUrls(imageUrlsForJob(job))
        if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
          window.clearInterval(timer)
        }
      } catch {
        if (!cancelled) setStatus('failed')
      }
    }

    const timer = window.setInterval(() => void refresh(), 2_000)
    void refresh()
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [jobId])

  if (urls.length > 0) return <GeneratedImagePreview urls={urls} />
  if (status === 'failed' || status === 'cancelled') {
    return <p className="mt-2 text-xs text-red-600">图片生成失败</p>
  }
  return <p className="mt-2 text-xs text-indigo-600">图片生成中…</p>
}

function ToolActivityGroup({
  parts,
  onApproval,
}: {
  parts: ToolEventPart[]
  onApproval?: (toolCallId: string, approvalId: string, approved: boolean) => void
}) {
  const imageUrls = [...new Set(parts.flatMap(generatedImageUrls))]
  const imageJobIds = [...new Set(parts.map(legacyImageJobId).filter((jobId): jobId is number => jobId !== null))]
  const hasPendingApproval = parts.some(part => part.state === 'approval-requested' && part.toolCallId && part.approval?.id)

  return (
    <div>
      <details
        open={hasPendingApproval}
        className="rounded-lg bg-indigo-50/60 px-3 py-2 text-xs text-indigo-950 dark:bg-indigo-950/30 dark:text-indigo-100"
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
          <Wrench className="h-3.5 w-3.5 text-indigo-500" />
          <span>{activitySummary(parts)}</span>
          <ChevronDown className="ml-auto h-3.5 w-3.5 transition-transform [[open]_&]:rotate-180" />
        </summary>
        <ul className="mt-2 space-y-1 text-indigo-700 dark:text-indigo-200">
          {parts.map((part, index) => {
            const name = chatToolName(part)
            const label = toolLabels[name] ?? name
            const pending = part.state === 'approval-requested' && part.toolCallId && part.approval?.id
            const status = pending ? '等待你确认' : chatToolStatus(part)
            return (
              <li
                key={part.toolCallId ?? part.type + '-' + index}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <span>{label}</span>
                {pending && onApproval ? (
                  <span className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="xs"
                      onClick={() => onApproval(part.toolCallId!, part.approval!.id!, true)}
                    >
                      批准
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => onApproval(part.toolCallId!, part.approval!.id!, false)}
                    >
                      拒绝
                    </Button>
                  </span>
                ) : (
                  <span className="text-indigo-500">{status}</span>
                )}
              </li>
            )
          })}
        </ul>
      </details>
      {imageUrls.length > 0 ? <GeneratedImagePreview urls={imageUrls} /> : null}
      {imageJobIds.map(jobId => <ImageJobPreview key={jobId} jobId={jobId} />)}
    </div>
  )
}

export function ChatMessageView({
  message,
  onApproval,
}: {
  message: DisplayMessage
  onApproval?: ChatApprovalHandler
}) {
  const isUser = message.role === 'user'
  const textParts = message.parts.filter(part => part.type === 'text')
  const toolParts = message.parts.filter(isChatToolPart) as ToolEventPart[]
  const fallbackText = textParts.length === 0 && message.text ? message.text : ''
  const persistedMessageId = typeof message.id === 'number' ? message.id : undefined

  if (message.role === 'tool') return null

  return (
    <article className={cn('flex', isUser && 'justify-end')}>
      <div className={isUser ? 'min-w-0 max-w-3xl space-y-2' : 'w-full min-w-0 space-y-2'}>
        {(textParts.length > 0 || fallbackText) && (
          <div
            className={cn(
              'break-words rounded-2xl px-3 py-2 text-sm leading-6',
              isUser && 'whitespace-pre-wrap',
              isUser ? 'rounded-tr-sm bg-primary text-primary-foreground' : 'text-foreground',
            )}
          >
            {isUser
              ? (textParts.length > 0
                ? textParts.map((part, index) => (
                  <span key={String(message.id) + '-text-' + index}>{String(part.text ?? '')}</span>
                ))
                : fallbackText)
              : (textParts.length > 0
                ? textParts.map((part, index) => (
                  <ChatMarkdown
                    key={String(message.id) + '-text-' + index}
                    content={String(part.text ?? '')}
                  />
                ))
                : <ChatMarkdown content={fallbackText} />)}
          </div>
        )}
        {toolParts.length > 0 && (
          <ToolActivityGroup
            parts={toolParts}
            onApproval={persistedMessageId
              ? (toolCallId, approvalId, approved) => onApproval?.(persistedMessageId, toolCallId, approvalId, approved)
              : undefined}
          />
        )}
        <time className={cn('block px-1 text-[11px] text-foreground-subtle', isUser && 'text-right')}>
          {displayTime(message.created_at)}
        </time>
      </div>
    </article>
  )
}
