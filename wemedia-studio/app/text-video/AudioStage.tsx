'use client'

import { useRef } from 'react'
import {
  Check,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Mic2,
  RefreshCw,
  Sparkles,
  Volume2,
} from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { creativeAssetUrl } from '@/lib/api/assets'
import type {
  SpeechStatus,
  TextVideoParagraph,
  TextVideoProject,
  TextVideoVoiceSettings,
} from '@/lib/api/text-videos'
import { cn } from '@/lib/utils'

import type { TextVideoActionState } from './useTextVideoProjectActions'

const statusLabels: Record<SpeechStatus, string> = {
  draft: '未生成',
  generating: '生成中',
  ready: '待确认',
  confirmed: '已确认',
  failed: '生成失败',
}

function statusVariant(status: SpeechStatus) {
  if (status === 'confirmed') return 'success' as const
  if (status === 'failed') return 'destructive' as const
  if (status === 'ready') return 'warning' as const
  if (status === 'generating') return 'info' as const
  return 'outline' as const
}

function masterStatusLabel(project: TextVideoProject): string {
  const master = project.master_audio
  if (master.status === 'building') return '主音频生成中'
  if (master.status === 'failed') return '主音频生成失败'
  if (master.status === 'stale') return '主音频已失效'
  if (master.status !== 'ready') return '主音频未生成'
  if (master.timeline_status === 'ready') return '时间轴已就绪'
  if (master.timeline_status === 'aligning') return '时间轴生成中'
  if (master.timeline_status === 'failed') return '时间轴生成失败'
  if (master.timeline_status === 'stale') return '时间轴已失效'
  return '等待生成时间轴'
}

function parseNumber(value: string, fallback: number): number {
  if (!value.trim()) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function AudioStage({
  project,
  selectedSegmentId,
  onSelectSegment,
  onVoiceSettingsChange,
  onGeneratePending,
  onGenerateSegment,
  onConfirmSegment,
  onBuildMasterAudio,
  onRealignMasterAudio,
  actionStates = {},
}: {
  project: TextVideoProject
  selectedSegmentId: string
  onSelectSegment?: (segmentId: string) => void
  onVoiceSettingsChange?: (
    update: Partial<TextVideoVoiceSettings>,
  ) => void
  onGeneratePending?: () => void
  onGenerateSegment?: (segmentId: string) => void
  onConfirmSegment?: (segment: TextVideoParagraph) => void
  onBuildMasterAudio?: () => void
  onRealignMasterAudio?: (jobId: number) => void
  actionStates?: Record<string, TextVideoActionState>
}) {
  const masterAudioRef = useRef<HTMLAudioElement>(null)
  const selected = (
    project.paragraphs.find(segment => segment.id === selectedSegmentId)
    ?? project.paragraphs[0]
  )
  const selectedIndex = Math.max(
    0,
    project.paragraphs.findIndex(segment => segment.id === selected?.id),
  )
  const speakable = project.paragraphs.filter(segment => segment.text.trim())
  const confirmedCount = speakable.filter(
    segment => segment.status === 'confirmed',
  ).length
  const allConfirmed = (
    speakable.length > 0
    && confirmedCount === speakable.length
  )
  const pendingCount = speakable.filter(
    segment => segment.status === 'draft' || segment.status === 'failed',
  ).length
  const selectedAction = selected
    ? actionStates[`speech:${selected.id}`]
    : undefined
  const pendingAction = actionStates['speech:pending']
  const masterAction = actionStates.master
  const generationBusy = (
    selectedAction?.status === 'running'
    || pendingAction?.status === 'running'
  )
  const masterBusy = (
    masterAction?.status === 'running'
    || project.master_audio.status === 'building'
    || project.master_audio.timeline_status === 'aligning'
  )
  const visibleActionError = [
    selectedAction,
    pendingAction,
    masterAction,
  ].find(state => state?.status === 'failed')

  if (!selected) {
    return (
      <div
        data-testid="editor-workspace"
        className="p-8 text-sm text-muted-foreground"
      >
        当前稿件没有可生成的口播段落。
      </div>
    )
  }

  function playMasterAudio() {
    const playback = masterAudioRef.current?.play()
    if (playback) void playback.catch(() => undefined)
  }

  return (
    <div
      data-testid="editor-workspace"
      className="grid min-h-[650px] grid-cols-[28fr_52fr_20fr] border-border"
    >
      <aside className="border-r border-border bg-surface/60 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground-subtle">
            配音段落
          </p>
          <Badge variant="secondary">
            {confirmedCount} / {speakable.length} 段已确认
          </Badge>
        </div>
        <div className="mb-3">
          <Button
            className="w-full"
            size="sm"
            disabled={
              pendingCount === 0
              || generationBusy
              || !onGeneratePending
            }
            onClick={onGeneratePending}
          >
            {pendingAction?.status === 'running'
              ? <LoaderCircle data-icon="inline-start" className="animate-spin" />
              : <Sparkles data-icon="inline-start" />}
            生成全部未生成段落
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          {project.paragraphs.map((segment, index) => (
            <button
              key={segment.id}
              type="button"
              data-testid="speech-segment-card"
              aria-pressed={segment.id === selected.id}
              onClick={() => onSelectSegment?.(segment.id)}
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors',
                segment.id === selected.id
                  ? 'border-primary/50 bg-primary/8'
                  : 'border-transparent bg-background/60 hover:border-border',
              )}
            >
              <span className={cn(
                'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs',
                segment.status === 'confirmed'
                  ? 'border-success/35 bg-success/10 text-success'
                  : 'text-muted-foreground',
              )}>
                {segment.status === 'confirmed'
                  ? <Check aria-hidden className="size-3.5" />
                  : segment.status === 'generating'
                    ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
                    : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-sm leading-5">
                  {segment.text || '空白段落'}
                </span>
                <span className="mt-2 flex items-center justify-between gap-2">
                  <Badge variant={statusVariant(segment.status)}>
                    {statusLabels[segment.status]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {segment.duration > 0
                      ? `${segment.duration.toFixed(1)} 秒`
                      : '—'}
                  </span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex flex-col p-5 lg:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-primary">
              段落 {String(selectedIndex + 1).padStart(2, '0')}
            </p>
            <h2 className="mt-1 text-lg font-semibold">试听与确认</h2>
          </div>
          <Badge variant={statusVariant(selected.status)}>
            {statusLabels[selected.status]}
          </Badge>
        </div>

        <blockquote className="mt-6 border-l-2 border-primary pl-4 text-lg leading-8">
          {selected.text || '当前段落没有可朗读文字'}
        </blockquote>

        <div className="mt-6 rounded-xl border bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">当前段配音</p>
              <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Clock3 aria-hidden className="size-3" />
                {selected.duration > 0
                  ? `${selected.duration.toFixed(1)} 秒`
                  : '尚无可播放音频'}
              </p>
            </div>
          </div>
          {selected.audio_url.trim() ? (
            <audio
              data-testid="segment-audio"
              className="mt-4 w-full"
              controls
              preload="metadata"
              src={creativeAssetUrl(selected.audio_url)}
            />
          ) : (
            <p className="mt-4 rounded-lg bg-muted/45 p-3 text-sm text-muted-foreground">
              {selected.status === 'generating'
                ? '配音正在生成，完成后可在这里试听。'
                : '生成当前段后可在这里试听真实音频。'}
            </p>
          )}
          {selected.error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {selected.error}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                !selected.text.trim()
                || selected.status === 'generating'
                || generationBusy
                || !onGenerateSegment
              }
              onClick={() => onGenerateSegment?.(selected.id)}
            >
              {selected.status === 'generating'
                ? <LoaderCircle data-icon="inline-start" className="animate-spin" />
                : <RefreshCw data-icon="inline-start" />}
              {selected.status === 'draft'
                ? '生成当前段'
                : selected.status === 'generating'
                  ? '生成中'
                  : '重新生成当前段'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                selected.status !== 'ready'
                || !selected.source_hash
                || generationBusy
                || !onConfirmSegment
              }
              onClick={() => onConfirmSegment?.(selected)}
            >
              <Check data-icon="inline-start" />
              确认当前段
            </Button>
          </div>
        </div>

        <div className="mt-5 rounded-xl border bg-surface p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">主音频与全局时间轴</p>
              <p className="mt-1 text-xs text-muted-foreground">
                主音频是视频预览与最终渲染的唯一时间基准。
              </p>
            </div>
            <Badge
              data-testid="master-audio-status"
              variant={
                project.master_audio.timeline_status === 'ready'
                  ? 'success'
                  : project.master_audio.status === 'failed'
                    || project.master_audio.timeline_status === 'failed'
                    ? 'destructive'
                    : 'secondary'
              }
            >
              {masterStatusLabel(project)}
            </Badge>
          </div>
          {project.master_audio.audio_url.trim() ? (
            <audio
              ref={masterAudioRef}
              data-testid="master-audio"
              className="mt-4 w-full"
              controls
              preload="metadata"
              src={creativeAssetUrl(project.master_audio.audio_url)}
            />
          ) : null}
          {project.master_audio.error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {project.master_audio.error}
            </p>
          ) : null}
          {project.master_audio.timeline_error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {project.master_audio.timeline_error}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                !allConfirmed
                || masterBusy
                || !onBuildMasterAudio
              }
              onClick={onBuildMasterAudio}
            >
              {masterBusy
                ? <LoaderCircle data-icon="inline-start" className="animate-spin" />
                : <Volume2 data-icon="inline-start" />}
              {project.master_audio.status === 'ready'
                ? '重新生成主音频'
                : '生成主音频'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!project.master_audio.audio_url.trim()}
              onClick={playMasterAudio}
            >
              <Volume2 data-icon="inline-start" />
              播放全部
            </Button>
            {(
              project.master_audio.status === 'ready'
              && project.master_audio.timeline_status === 'failed'
              && project.master_audio.job_id !== null
            ) ? (
              <Button
                size="sm"
                variant="outline"
                disabled={masterBusy || !onRealignMasterAudio}
                onClick={() => onRealignMasterAudio?.(
                  project.master_audio.job_id!,
                )}
              >
                <RefreshCw data-icon="inline-start" />
                重新对齐
              </Button>
            ) : null}
          </div>
        </div>

        {visibleActionError ? (
          <Alert className="mt-5" variant="destructive">
            <CircleAlert aria-hidden />
            <AlertTitle>任务失败</AlertTitle>
            <AlertDescription>
              {visibleActionError.error}
              {visibleActionError.retryable ? '，可以重试当前操作。' : ''}
            </AlertDescription>
          </Alert>
        ) : null}
      </section>

      <aside className="border-l border-border bg-surface/45 p-5">
        <div className="flex items-center gap-2">
          <Mic2 aria-hidden className="size-4 text-primary" />
          <p className="text-sm font-semibold">音色与语音设置</p>
        </div>
        <FieldGroup className="mt-5">
          <Field>
            <FieldLabel htmlFor="speech-model">语音模型</FieldLabel>
            <Input
              id="speech-model"
              aria-label="语音模型"
              value={project.voice_settings.model}
              readOnly
            />
            <FieldDescription>模型由系统设置固定。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="voice-id">音色 ID</FieldLabel>
            <Input
              id="voice-id"
              aria-label="音色 ID"
              value={project.voice_settings.voice_id}
              readOnly={!onVoiceSettingsChange}
              onChange={event => onVoiceSettingsChange?.({
                voice_id: event.target.value,
              })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="voice-speed">语速</FieldLabel>
              <Input
                id="voice-speed"
                aria-label="语速"
                type="number"
                min={0.5}
                max={2}
                step={0.1}
                value={project.voice_settings.speed}
                readOnly={!onVoiceSettingsChange}
                onChange={event => onVoiceSettingsChange?.({
                  speed: parseNumber(
                    event.target.value,
                    project.voice_settings.speed,
                  ),
                })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="voice-volume">音量</FieldLabel>
              <Input
                id="voice-volume"
                aria-label="音量"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={project.voice_settings.volume}
                readOnly={!onVoiceSettingsChange}
                onChange={event => onVoiceSettingsChange?.({
                  volume: parseNumber(
                    event.target.value,
                    project.voice_settings.volume,
                  ),
                })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="voice-pitch">音调</FieldLabel>
              <Input
                id="voice-pitch"
                aria-label="音调"
                type="number"
                min={-12}
                max={12}
                step={1}
                value={project.voice_settings.pitch}
                readOnly={!onVoiceSettingsChange}
                onChange={event => onVoiceSettingsChange?.({
                  pitch: parseNumber(
                    event.target.value,
                    project.voice_settings.pitch,
                  ),
                })}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel>目标格式</FieldLabel>
            <div className="rounded-lg border bg-background px-3 py-2 text-sm">
              MP3 · 44.1 kHz · 128 kbps · 单声道
            </div>
            <FieldDescription>
              生成后统一规范化，确保 Remotion 模板稳定读取。
            </FieldDescription>
          </Field>
        </FieldGroup>
      </aside>
    </div>
  )
}
