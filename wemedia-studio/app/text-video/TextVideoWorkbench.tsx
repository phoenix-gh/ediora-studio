'use client'

import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  Cloud,
  CloudOff,
  LoaderCircle,
} from 'lucide-react'

import { buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { TextVideoProject } from '@/lib/api/text-videos'
import {
  canEnterVideoStage,
  updateProjectVoiceSettings,
} from '@/lib/text-video/project-merge'
import {
  collapseToSingleSegment,
  editSpeechSegment,
  mergeSpeechSegment,
  reorderSpeechSegment,
  splitSpeechSegment,
} from '@/lib/text-video/speech-segments'
import { cn } from '@/lib/utils'

import { AudioStage } from './AudioStage'
import {
  SceneDirectionDialog,
  type SceneDirectionDraft,
} from './SceneDirectionDialog'
import { ScriptStage } from './ScriptStage'
import type { TextVideoSaveState } from './useTextVideoAutosave'
import type { TextVideoActionState } from './useTextVideoProjectActions'
import { VideoStage } from './VideoStage'


type Stage = 'script' | 'audio' | 'video'

const stages: Array<{ id: Stage; label: string }> = [
  { id: 'script', label: '稿件与分镜' },
  { id: 'audio', label: '配音制作' },
  { id: 'video', label: '视频合成' },
]

const ratioDimensions = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
} as const

function speechWorkflowBanner(project: TextVideoProject): string {
  const speakable = project.paragraphs.filter(item => item.text.trim())
  const generationPending = speakable.filter(
    item => item.status === 'draft' || item.status === 'failed',
  ).length
  const generating = speakable.filter(
    item => item.status === 'generating',
  ).length
  const ready = speakable.filter(item => item.status === 'ready').length
  const single = speakable.length === 1

  if (generationPending > 0 && ready > 0) {
    return `还需生成 ${generationPending} 段、确认 ${ready} 段配音`
  }
  if (generationPending > 0) {
    return `还需生成 ${generationPending} 段配音，生成后请试听并确认`
  }
  if (generating > 0) return `正在生成 ${generating} 段配音`
  if (ready > 0) {
    return single
      ? '还需确认 1 段配音，确认后将直接复用该段音频'
      : `还需确认 ${ready} 段配音，确认后可生成主音频`
  }
  return single
    ? '配音已确认，正在准备成片时间轴'
    : '配音已确认，生成主音频和时间轴后可进入视频合成'
}

export type TextVideoWorkbenchProps = {
  projectDocument: TextVideoProject
  saveState?: TextVideoSaveState
  onProjectChange?: (project: TextVideoProject) => void
  onSave?: () => void
  actionStates?: Record<string, TextVideoActionState>
  onGeneratePendingSpeech?: () => void
  onGenerateSpeechSegment?: (segmentId: string) => void
  onConfirmSpeechSegment?: (
    segment: TextVideoProject['paragraphs'][number],
  ) => void
  onBuildMasterAudio?: () => void
  onRealignMasterAudio?: (jobId: number) => void
  onPrepareSpeechSplit?: () => Promise<TextVideoProject>
  onPrepareAudioStage?: () => Promise<TextVideoProject>
  onGenerateScenePlan?: (input: SceneDirectionDraft) => Promise<void>
  onApplyTemplateSettings?: (
    templateProps: Record<string, unknown>,
  ) => Promise<void>
  onApplyTemplate?: (
    templateId: string,
    templateVersion: number,
    templateProps: Record<string, unknown>,
  ) => Promise<void>
  onRenderVideo?: () => void
}

export function TextVideoWorkbench({
  projectDocument,
  saveState = 'saved',
  onProjectChange,
  onSave,
  actionStates,
  onGeneratePendingSpeech,
  onGenerateSpeechSegment,
  onConfirmSpeechSegment,
  onBuildMasterAudio,
  onRealignMasterAudio,
  onPrepareSpeechSplit,
  onPrepareAudioStage,
  onGenerateScenePlan,
  onApplyTemplateSettings,
  onApplyTemplate,
  onRenderVideo,
}: TextVideoWorkbenchProps) {
  const [selectedSceneId, setSelectedSceneId] = useState(
    () => projectDocument.scene_plan.scenes[0]?.id ?? '',
  )
  const [selectedSpeechSegmentId, setSelectedSpeechSegmentId] = useState(
    () => projectDocument.paragraphs[0]?.id ?? '',
  )
  const [previewAll, setPreviewAll] = useState(false)
  const [sceneDirectionOpen, setSceneDirectionOpen] = useState(false)
  const [sceneDirectionScope, setSceneDirectionScope] = useState<
    'all' | 'selected'
  >('all')
  const stage = projectDocument.stage
  const ratio = aspectRatio(projectDocument)
  const activeSpeechSegmentId = projectDocument.paragraphs.some(
    paragraph => paragraph.id === selectedSpeechSegmentId,
  )
    ? selectedSpeechSegmentId
    : projectDocument.paragraphs[0]?.id ?? ''
  const activeSceneId = projectDocument.scene_plan.scenes.some(
    scene => scene.id === selectedSceneId,
  )
    ? selectedSceneId
    : projectDocument.scene_plan.scenes[0]?.id ?? ''
  const audioReady = canEnterVideoStage(projectDocument)
  const sceneActionKey = sceneDirectionScope === 'selected' && activeSceneId
    ? `scene:${activeSceneId}`
    : 'scene:all'

  function changeDocument(
    update: (current: TextVideoProject) => TextVideoProject,
  ) {
    onProjectChange?.(update(projectDocument))
  }

  function chooseStage(nextStage: Stage) {
    setPreviewAll(false)
    changeDocument(current => ({
      ...current,
      stage: nextStage,
      status: nextStage === 'video' ? 'video_ready' : current.status,
    }))
  }

  function changeRatio(nextRatio: keyof typeof ratioDimensions) {
    changeDocument(current => ({
      ...current,
      aspect_ratio: nextRatio,
      render_input: {
        ...current.render_input,
        composition: {
          ...current.render_input.composition,
          ...ratioDimensions[nextRatio],
        },
      },
    }))
  }

  function commitSpeechProject(
    next: TextVideoProject,
    selectedId?: string,
  ) {
    onProjectChange?.(next)
    if (selectedId) setSelectedSpeechSegmentId(selectedId)
  }

  function changeSpeechText(segmentId: string, text: string) {
    commitSpeechProject(
      editSpeechSegment(projectDocument, segmentId, text),
    )
  }

  function splitSpeech(segmentId: string, cursor: number) {
    try {
      const currentIndex = projectDocument.paragraphs.findIndex(
        paragraph => paragraph.id === segmentId,
      )
      const next = splitSpeechSegment(projectDocument, segmentId, cursor)
      commitSpeechProject(next, next.paragraphs[currentIndex + 1]?.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '分段失败')
    }
  }

  function mergeSpeech(
    segmentId: string,
    direction: 'previous' | 'next',
  ) {
    try {
      const currentIndex = projectDocument.paragraphs.findIndex(
        paragraph => paragraph.id === segmentId,
      )
      const survivingId = direction === 'previous'
        ? projectDocument.paragraphs[currentIndex - 1]?.id
        : segmentId
      const next = mergeSpeechSegment(
        projectDocument,
        segmentId,
        direction,
      )
      commitSpeechProject(next, survivingId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '合并失败')
    }
  }

  function collapseSpeech() {
    const next = collapseToSingleSegment(projectDocument)
    commitSpeechProject(next, next.paragraphs[0]?.id)
  }

  function reorderSpeech(segmentId: string, targetIndex: number) {
    try {
      const next = reorderSpeechSegment(
        projectDocument,
        segmentId,
        targetIndex,
      )
      commitSpeechProject(next, segmentId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '调整顺序失败')
    }
  }

  function changeVoiceSettings(
    update: Parameters<typeof updateProjectVoiceSettings>[1],
  ) {
    changeDocument(current => updateProjectVoiceSettings(current, update))
  }

  function chooseScene(sceneId: string) {
    setSelectedSceneId(sceneId)
    setPreviewAll(false)
  }

  function openSceneDirection(scope: 'all' | 'selected') {
    setSceneDirectionScope(scope)
    setSceneDirectionOpen(true)
  }

  return (
    <div className="min-h-full overflow-x-auto bg-background">
      <div data-testid="editor-shell" className="min-w-[1120px]">
        <header
          data-testid="editor-topbar"
          className="flex h-[72px] items-center border-b border-border bg-surface px-4"
        >
          <div className="flex w-[28%] min-w-0 items-center gap-2 pr-4">
            <Link
              href="/text-video"
              aria-label="返回文字视频作品"
              className={buttonVariants({
                size: 'icon-sm',
                variant: 'ghost',
              })}
            >
              <ArrowLeft data-icon />
            </Link>
            <Input
              aria-label="作品标题"
              value={projectDocument.title}
              readOnly={!onProjectChange}
              onChange={event => changeDocument(current => ({
                ...current,
                title: event.target.value,
              }))}
              className="h-9 min-w-0 border-transparent bg-transparent px-2 text-base font-semibold shadow-none hover:border-border focus-visible:bg-background"
            />
          </div>

          <div
            role="tablist"
            aria-label="文字视频制作阶段"
            className="flex w-[52%] items-center justify-center px-3"
          >
            {stages.map((item, index) => {
              const active = stage === item.id
              const disabled = item.id === 'video' && !audioReady
              return (
                <div key={item.id} className="flex min-w-0 items-center">
                  <button
                    type="button"
                    role="tab"
                    aria-label={item.label}
                    aria-selected={active}
                    disabled={disabled}
                    onClick={() => chooseStage(item.id)}
                    className={cn(
                      'flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground',
                      disabled && 'cursor-not-allowed opacity-45',
                    )}
                  >
                    <span className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs',
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background',
                    )}>
                      {index < stages.findIndex(
                        value => value.id === stage,
                      )
                        ? <Check data-icon className="size-3.5" />
                        : disabled
                          ? <CircleDashed data-icon className="size-3.5" />
                          : index + 1}
                    </span>
                    <span>{item.label}</span>
                  </button>
                  {index < stages.length - 1 ? (
                    <ChevronRight
                      data-icon
                      className="mx-1 size-4 text-border"
                    />
                  ) : null}
                </div>
              )
            })}
          </div>

          <div className="flex w-[20%] items-center justify-end gap-2 pl-3">
            <SaveIndicator state={saveState} onSave={onSave} />
            <Select
              value={ratio}
              onValueChange={value => changeRatio(
                value as keyof typeof ratioDimensions,
              )}
            >
              <SelectTrigger aria-label="画面比例" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="9:16">9:16 竖屏</SelectItem>
                  <SelectItem value="16:9">16:9 横屏</SelectItem>
                  <SelectItem value="1:1">1:1 方形</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </header>

        {!audioReady ? (
          <div className="border-b border-amber-500/20 bg-amber-500/8 px-5 py-1.5 text-center text-xs text-amber-700">
            {speechWorkflowBanner(projectDocument)}
          </div>
        ) : null}

        {stage === 'script' ? (
          <ScriptStage
            project={projectDocument}
            selectedSpeechSegmentId={activeSpeechSegmentId}
            onSelectSpeechSegment={setSelectedSpeechSegmentId}
            onSpeechSegmentTextChange={
              onProjectChange ? changeSpeechText : undefined
            }
            onSplitSpeechSegment={onProjectChange ? splitSpeech : undefined}
            onMergeSpeechSegment={onProjectChange ? mergeSpeech : undefined}
            onCollapseToSingleSegment={
              onProjectChange ? collapseSpeech : undefined
            }
            onReorderSpeechSegment={
              onProjectChange ? reorderSpeech : undefined
            }
            onPrepareSpeechSplit={onPrepareSpeechSplit}
            onContinueToAudio={onPrepareAudioStage ? async () => {
              const saved = await onPrepareAudioStage()
              onProjectChange?.({
                ...saved,
                stage: 'audio',
              })
            } : undefined}
            onApplySpeechSplit={onProjectChange ? next => {
              commitSpeechProject(next, next.paragraphs[0]?.id)
            } : undefined}
          />
        ) : stage === 'audio' ? (
          <AudioStage
            project={projectDocument}
            selectedSegmentId={activeSpeechSegmentId}
            onSelectSegment={setSelectedSpeechSegmentId}
            onVoiceSettingsChange={
              onProjectChange ? changeVoiceSettings : undefined
            }
            onGeneratePending={onGeneratePendingSpeech}
            onGenerateSegment={onGenerateSpeechSegment}
            onConfirmSegment={onConfirmSpeechSegment}
            onBuildMasterAudio={onBuildMasterAudio}
            onRealignMasterAudio={onRealignMasterAudio}
            actionStates={actionStates}
          />
        ) : (
          <VideoStage
            project={projectDocument}
            selectedSceneId={activeSceneId}
            onSelectScene={chooseScene}
            previewAll={previewAll}
            onPreviewAll={() => setPreviewAll(true)}
            onProjectChange={next => onProjectChange?.(next)}
            onOpenSceneDirection={openSceneDirection}
            onApplyTemplate={onApplyTemplate}
            onApplyTemplateSettings={async templateProps => {
              if (!onApplyTemplateSettings) {
                throw new Error('模板视觉保存服务尚未连接')
              }
              await onApplyTemplateSettings(templateProps)
            }}
            onRenderVideo={onRenderVideo}
            renderAction={
              actionStates?.['render:mp4'] ?? actionStates?.recovery
            }
          />
        )}
      </div>

      <SceneDirectionDialog
        open={sceneDirectionOpen}
        initialScope={sceneDirectionScope}
        selectedSceneId={activeSceneId}
        actionState={actionStates?.[sceneActionKey]}
        onOpenChange={setSceneDirectionOpen}
        onGenerate={async input => {
          if (!onGenerateScenePlan) {
            throw new Error('AI 分镜服务尚未连接')
          }
          await onGenerateScenePlan(input)
        }}
      />
    </div>
  )
}

function SaveIndicator({
  state,
  onSave,
}: {
  state: TextVideoSaveState
  onSave?: () => void
}) {
  const config = {
    saved: {
      label: '已保存',
      icon: Cloud,
      className: 'text-emerald-600',
    },
    dirty: {
      label: '有未保存更改',
      icon: CloudOff,
      className: 'text-amber-600',
    },
    saving: {
      label: '正在保存',
      icon: LoaderCircle,
      className: 'text-muted-foreground',
    },
    error: {
      label: '保存失败，点击重试',
      icon: CircleAlert,
      className: 'text-destructive',
    },
    conflict: {
      label: '保存冲突',
      icon: CircleAlert,
      className: 'text-destructive',
    },
  }[state]
  const Icon = config.icon
  return (
    <button
      type="button"
      data-testid="text-video-save-status"
      aria-live="polite"
      disabled={!onSave || (state !== 'error' && state !== 'dirty')}
      onClick={onSave}
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap text-xs',
        config.className,
      )}
    >
      <Icon
        data-icon
        className={cn('size-3.5', state === 'saving' && 'animate-spin')}
      />
      {config.label}
    </button>
  )
}

function aspectRatio(
  project: TextVideoProject,
): keyof typeof ratioDimensions {
  const { width, height } = project.render_input.composition
  if (width === height) return '1:1'
  return width > height ? '16:9' : '9:16'
}
