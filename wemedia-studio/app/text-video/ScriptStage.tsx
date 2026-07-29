'use client'

import { useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Clock3,
  FileText,
  LoaderCircle,
  Merge,
  Scissors,
  Sparkles,
} from 'lucide-react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import type {
  SpeechStatus,
  TextVideoProject,
} from '@/lib/api/text-videos'
import { estimateSpeechDuration } from '@/lib/text-video/speech-segments'
import { cn } from '@/lib/utils'

import { SpeechSplitPreviewDialog } from './SpeechSplitPreviewDialog'


type Confirmation =
  | { kind: 'collapse' }
  | { kind: 'reorder'; targetIndex: number }

const statusLabels: Record<SpeechStatus, string> = {
  draft: '待生成',
  generating: '生成中',
  ready: '待确认',
  confirmed: '已确认',
  failed: '生成失败',
}

function statusVariant(status: SpeechStatus) {
  if (status === 'confirmed') return 'default' as const
  if (status === 'failed') return 'destructive' as const
  if (status === 'draft') return 'outline' as const
  return 'secondary' as const
}

export function ScriptStage({
  project,
  selectedSpeechSegmentId,
  onSelectSpeechSegment,
  onSpeechSegmentTextChange,
  onSplitSpeechSegment,
  onMergeSpeechSegment,
  onCollapseToSingleSegment,
  onReorderSpeechSegment,
  onRequestAiSplit,
  onPrepareSpeechSplit,
  onApplySpeechSplit,
}: {
  project: TextVideoProject
  selectedSpeechSegmentId: string
  onSelectSpeechSegment?: (segmentId: string) => void
  onSpeechSegmentTextChange?: (segmentId: string, text: string) => void
  onSplitSpeechSegment?: (segmentId: string, cursor: number) => void
  onMergeSpeechSegment?: (
    segmentId: string,
    direction: 'previous' | 'next',
  ) => void
  onCollapseToSingleSegment?: () => void
  onReorderSpeechSegment?: (segmentId: string, targetIndex: number) => void
  onRequestAiSplit?: () => void
  onPrepareSpeechSplit?: () => Promise<TextVideoProject>
  onApplySpeechSplit?: (project: TextVideoProject) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [speechSplitPreviewOpen, setSpeechSplitPreviewOpen] = useState(false)
  const [speechSplitProject, setSpeechSplitProject] = useState<
    TextVideoProject | null
  >(null)
  const [speechSplitPreparing, setSpeechSplitPreparing] = useState(false)
  const [speechSplitError, setSpeechSplitError] = useState('')
  const selectedIndex = Math.max(
    0,
    project.paragraphs.findIndex(
      segment => segment.id === selectedSpeechSegmentId,
    ),
  )
  const segment = project.paragraphs[selectedIndex]
  const editable = Boolean(segment && onSpeechSegmentTextChange)
  const totalDuration = project.paragraphs.reduce((sum, item) => (
    sum + (
      item.duration > 0
        ? item.duration
        : estimateSpeechDuration(item.text)
    )
  ), 0)

  function confirmOperation() {
    if (!confirmation || !segment) return
    if (confirmation.kind === 'collapse') {
      onCollapseToSingleSegment?.()
    } else {
      onReorderSpeechSegment?.(segment.id, confirmation.targetIndex)
    }
    setConfirmation(null)
  }

  async function prepareSpeechSplitPreview() {
    onRequestAiSplit?.()
    if (!onApplySpeechSplit) return
    setSpeechSplitPreparing(true)
    setSpeechSplitError('')
    try {
      const saved = onPrepareSpeechSplit
        ? await onPrepareSpeechSplit()
        : project
      setSpeechSplitProject(saved)
      setSpeechSplitPreviewOpen(true)
    } catch (error) {
      setSpeechSplitError(
        error instanceof Error ? error.message : '保存稿件失败',
      )
    } finally {
      setSpeechSplitPreparing(false)
    }
  }

  if (!segment) {
    return (
      <div data-testid="editor-workspace" className="p-8 text-sm text-muted-foreground">
        当前稿件没有可编辑的口播段落。
      </div>
    )
  }

  const confirmationIsCollapse = confirmation?.kind === 'collapse'
  return (
    <>
      <div data-testid="editor-workspace" className="grid min-h-[650px] grid-cols-[28fr_52fr_20fr] border-border">
        <aside className="border-r border-border bg-surface/60 p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground-subtle">口播段落</p>
            <Badge variant="secondary">{project.paragraphs.length} 段</Badge>
          </div>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={project.paragraphs.length <= 1 || !onCollapseToSingleSegment}
              onClick={() => setConfirmation({ kind: 'collapse' })}
            >
              <FileText data-icon="inline-start" />
              保持整篇
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={
                (!onRequestAiSplit && !onApplySpeechSplit)
                || !project.script.trim()
                || speechSplitPreparing
              }
              onClick={() => void prepareSpeechSplitPreview()}
            >
              {speechSplitPreparing
                ? <LoaderCircle data-icon="inline-start" className="animate-spin" />
                : <Sparkles data-icon="inline-start" />}
              {speechSplitPreparing ? '正在保存稿件…' : 'AI 自动分段'}
            </Button>
          </div>
          {speechSplitError ? (
            <p role="alert" className="mb-3 text-xs text-destructive">
              {speechSplitError}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            {project.paragraphs.map((item, index) => {
              const duration = item.duration > 0
                ? `${item.duration.toFixed(1)} 秒`
                : `约 ${estimateSpeechDuration(item.text).toFixed(1)} 秒`
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-label={`段落 ${String(index + 1).padStart(2, '0')}`}
                  onClick={() => onSelectSpeechSegment?.(item.id)}
                  className={cn(
                    'w-full rounded-xl border p-3 text-left transition-colors',
                    item.id === segment.id
                      ? 'border-primary/50 bg-primary/8'
                      : 'border-transparent bg-background/60 hover:border-border',
                  )}
                >
                  <span className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>段落 {String(index + 1).padStart(2, '0')}</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock3 aria-hidden className="size-3" />
                      {duration}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-sm leading-6">{item.text}</span>
                  <Badge className="mt-2" variant={statusVariant(item.status)}>
                    {statusLabels[item.status]}
                  </Badge>
                </button>
              )
            })}
          </div>
        </aside>

        <section className="p-5 lg:p-7">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-primary">段落 {String(selectedIndex + 1).padStart(2, '0')}</p>
              <h2 className="mt-1 text-lg font-semibold">编辑口播稿</h2>
            </div>
            <Badge variant={statusVariant(segment.status)}>
              {statusLabels[segment.status]}
            </Badge>
          </div>
          <Field>
            <FieldLabel htmlFor="text-video-script">口播内容</FieldLabel>
            <Textarea
              ref={textareaRef}
              id="text-video-script"
              value={segment.text}
              readOnly={!editable}
              onChange={event => onSpeechSegmentTextChange?.(
                segment.id,
                event.target.value,
              )}
              className="min-h-52 resize-none bg-surface text-base leading-8"
            />
            <FieldDescription>
              光标决定手动分段位置；所有空格和换行都会原样保留。
            </FieldDescription>
          </Field>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!onSplitSpeechSegment}
              onClick={() => onSplitSpeechSegment?.(
                segment.id,
                textareaRef.current?.selectionStart ?? segment.text.length,
              )}
            >
              <Scissors data-icon="inline-start" />
              从此处分段
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={selectedIndex === 0 || !onMergeSpeechSegment}
              onClick={() => onMergeSpeechSegment?.(segment.id, 'previous')}
            >
              <Merge data-icon="inline-start" />
              与上一段合并
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                selectedIndex === project.paragraphs.length - 1
                || !onMergeSpeechSegment
              }
              onClick={() => onMergeSpeechSegment?.(segment.id, 'next')}
            >
              <Merge data-icon="inline-start" />
              与下一段合并
            </Button>
          </div>
          <div className="mt-6 rounded-xl border border-dashed border-primary/30 bg-primary/5 p-4">
            <p className="text-sm font-medium">分段只控制口播生成</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              视频场景会在主音频时间轴完成后单独规划，不会按口播段落序号强行对应。
            </p>
          </div>
        </section>

        <aside className="border-l border-border bg-surface/45 p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground-subtle">稿件信息</p>
          <dl className="mt-5 flex flex-col gap-4 text-sm">
            <div><dt className="text-muted-foreground">段落数量</dt><dd className="mt-1 font-medium">{project.paragraphs.length} 段</dd></div>
            <div><dt className="text-muted-foreground">预计时长</dt><dd className="mt-1 font-medium">{totalDuration.toFixed(1)} 秒</dd></div>
            <div><dt className="text-muted-foreground">分段方式</dt><dd className="mt-1 font-medium">{splitModeLabel(project.speech_split_mode)}</dd></div>
          </dl>
          <div className="mt-7 flex flex-col gap-2">
            <Button
              variant="outline"
              disabled={selectedIndex === 0 || !onReorderSpeechSegment}
              onClick={() => setConfirmation({
                kind: 'reorder',
                targetIndex: selectedIndex - 1,
              })}
            >
              <ArrowUp data-icon="inline-start" />
              上移
            </Button>
            <Button
              variant="outline"
              disabled={
                selectedIndex === project.paragraphs.length - 1
                || !onReorderSpeechSegment
              }
              onClick={() => setConfirmation({
                kind: 'reorder',
                targetIndex: selectedIndex + 1,
              })}
            >
              <ArrowDown data-icon="inline-start" />
              下移
            </Button>
          </div>
          <Button className="mt-5 w-full" disabled>生成配音（下一步）</Button>
        </aside>
      </div>

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={open => {
          if (!open) setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmationIsCollapse ? '确认保持整篇？' : '确认调整口播顺序？'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmationIsCollapse
                ? '现有分段会合并为一段，主音频和时间轴需要重新生成。'
                : '口播播放顺序会改变，主音频和时间轴需要重新生成。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmation(null)}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmOperation}>
              {confirmationIsCollapse ? '确认保持整篇' : '确认调整顺序'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {onApplySpeechSplit && speechSplitProject ? (
        <SpeechSplitPreviewDialog
          open={speechSplitPreviewOpen}
          project={speechSplitProject}
          direction=""
          onOpenChange={setSpeechSplitPreviewOpen}
          onApply={onApplySpeechSplit}
        />
      ) : null}
    </>
  )
}

function splitModeLabel(mode: TextVideoProject['speech_split_mode']): string {
  if (mode === 'auto') return 'AI 自动分段'
  if (mode === 'manual') return '手动分段'
  return '保持整篇'
}
