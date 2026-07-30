'use client'

import { useState } from 'react'
import {
  ArrowLeftFromLine,
  ArrowRightFromLine,
  Brush,
  Clapperboard,
  Download,
  LoaderCircle,
  Merge,
  Play,
  Scissors,
  Sparkles,
  WandSparkles,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  Alert,
  AlertDescription,
} from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  ScenePlanSceneDocument,
  TextVideoProject,
} from '@/lib/api/text-videos'
import {
  textVideoOutputDownloadUrl,
} from '@/lib/api/text-videos'
import { creativeAssetUrl } from '@/lib/api/assets'
import {
  applyScenePlanToProject,
  editSceneVisuals,
  mergeScene,
  moveSceneBoundary,
  splitSceneAtWord,
} from '@/lib/text-video/scene-plan'
import { canPreviewVideo } from '@/lib/text-video/project-merge'
import { resolveTextVideoTemplate } from '@/remotion/registry'
import { cn } from '@/lib/utils'

import { RemotionPreview } from './RemotionPreview'
import { SceneTimeline } from './SceneTimeline'
import { TemplateSettingsDialog } from './TemplateSettingsDialog'
import type { TextVideoActionState } from './useTextVideoProjectActions'


export function VideoStage({
  project,
  selectedSceneId,
  onSelectScene,
  previewAll,
  onPreviewAll,
  onProjectChange,
  onOpenSceneDirection,
  onApplyTemplateSettings,
  onRenderVideo,
  renderAction,
}: {
  project: TextVideoProject
  selectedSceneId: string
  onSelectScene(sceneId: string): void
  previewAll: boolean
  onPreviewAll(): void
  onProjectChange(project: TextVideoProject): void
  onOpenSceneDirection(scope: 'all' | 'selected'): void
  onApplyTemplateSettings(
    templateProps: Record<string, unknown>,
  ): Promise<void>
  onRenderVideo?: () => void
  renderAction?: TextVideoActionState
}) {
  const [templateSettingsOpen, setTemplateSettingsOpen] = useState(false)
  const scenes = project.scene_plan.scenes
  const selectedIndex = scenes.findIndex(
    scene => scene.id === selectedSceneId,
  )
  const activeSceneIndex = selectedIndex >= 0 ? selectedIndex : 0
  const selectedScene = scenes[activeSceneIndex]
  const activeSceneId = selectedScene?.id ?? ''
  const planCurrent = (
    project.scene_plan.status === 'ready'
    && project.scene_plan.master_source_hash
      === project.master_audio.source_hash
  )
  const previewReady = canPreviewVideo(project)
  const director = directorAction(project, activeSceneId)
  const template = templateDetails(project)
  const renderRunning = (
    renderAction?.status === 'running'
    || project.render_state.status === 'queued'
    || project.render_state.status === 'rendering'
  )
  const renderProgress = Math.max(
    0,
    Math.min(
      100,
      renderAction?.progress ?? project.render_state.progress,
    ),
  )
  const renderError = renderAction?.error || project.render_state.error
  const hasOutput = Boolean(project.output_asset_url)
  const hasCurrentOutput = hasOutput && !project.output_stale
  const renderLabel = renderRunning
    ? '正在生成视频'
    : hasOutput
      ? '重新生成视频'
      : '生成视频'

  return (
    <div
      data-testid="editor-workspace"
      className="grid min-h-[650px] grid-cols-[28fr_52fr_20fr] border-border"
    >
      <aside className="border-r border-border bg-surface/60 p-3">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground-subtle">
            画面场景
          </p>
          <Badge variant="secondary">{scenes.length} scenes</Badge>
        </div>
        {scenes.length > 0 ? (
          <div className="space-y-2">
            {scenes.map((item, index) => {
              const timing = project.render_input.segments.find(
                segment => segment.id === item.id,
              )
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid="scene-card"
                  aria-label={`场景 ${String(index + 1).padStart(2, '0')}`}
                  onClick={() => onSelectScene(item.id)}
                  className={cn(
                    'grid w-full grid-cols-[72px_1fr] gap-3 rounded-xl border p-2 text-left transition-colors',
                    activeSceneId === item.id && !previewAll
                      ? 'border-primary/50 bg-primary/8'
                      : 'border-transparent bg-background/60 hover:border-border',
                  )}
                >
                  <span className="flex h-14 items-center justify-center rounded-md bg-[#07111f] px-1 text-center text-[10px] font-semibold leading-4 text-cyan-50">
                    {item.displayText.replace('\n', ' · ')}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>SCENE {String(index + 1).padStart(2, '0')}</span>
                      <span>
                        {timing
                          ? `${(timing.end - timing.start).toFixed(1)}s`
                          : '待校准'}
                      </span>
                    </span>
                    <span className="mt-1 line-clamp-2 whitespace-pre-line text-xs font-medium leading-4">
                      {item.displayText}
                    </span>
                    <span className="mt-1 inline-flex rounded bg-muted px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">
                      {item.animation}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border p-5 text-center text-xs leading-5 text-muted-foreground">
            主音频已就绪。使用 AI 生成第一版分镜后，可逐幕调整文字与动效。
          </div>
        )}
      </aside>

      <section className="flex min-w-0 flex-col p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-primary">
              {previewAll
                ? '全片预览'
                : selectedScene
                  ? `SCENE ${String(
                    scenes.findIndex(item => item.id === selectedScene.id) + 1,
                  ).padStart(2, '0')}`
                  : '等待分镜'}
            </p>
            <h2 className="mt-1 text-base font-semibold">
              Remotion 实时画面
            </h2>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!previewReady}
            onClick={onPreviewAll}
          >
            <Play data-icon />
            预览全片
          </Button>
        </div>
        <div className="mx-auto flex min-h-[455px] w-full flex-1 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-[#030711] p-3 shadow-[0_22px_60px_rgba(2,8,23,0.18)]">
          <div
            className={cn(
              'overflow-hidden rounded-xl shadow-2xl',
              project.render_input.composition.width
                === project.render_input.composition.height
                ? 'aspect-square h-auto w-full max-w-[440px]'
                : project.render_input.composition.width
                    > project.render_input.composition.height
                  ? 'aspect-video w-full'
                  : 'h-[440px] aspect-[9/16]',
            )}
          >
            <RemotionPreview
              project={project}
              selectedSceneId={activeSceneId}
              previewAll={previewAll}
            />
          </div>
        </div>
      </section>

      <aside className="border-l border-border bg-surface/45 p-4">
        <div className="flex items-center gap-2">
          <Clapperboard data-icon className="size-4 text-primary" />
          <p className="text-sm font-semibold">模板与导演</p>
        </div>
        <Field className="mt-5">
          <FieldLabel>视频模板</FieldLabel>
          <Select
            value={`${project.render_input.templateId}@${
              project.render_input.templateVersion
            }`}
            disabled
          >
            <SelectTrigger className="w-full" aria-label="视频模板">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={`${project.render_input.templateId}@${
                  project.render_input.templateVersion
                }`}>
                  {template.name}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>
            {project.render_input.templateId} · v{
              project.render_input.templateVersion
            }
          </FieldDescription>
        </Field>
        <Button
          className="mt-3 w-full"
          variant="outline"
          onClick={() => setTemplateSettingsOpen(true)}
        >
          <Brush data-icon />
          模板视觉设置
        </Button>

        {selectedScene && planCurrent ? (
          <SceneInspector
            key={`${selectedScene.id}:${selectedScene.fromWordId}:${
              selectedScene.throughWordId
            }:${project.scene_plan.generation_revision}`}
            project={project}
            scene={selectedScene}
            sceneIndex={activeSceneIndex}
            animations={template.animations}
            onProjectChange={onProjectChange}
          />
        ) : (
          <div className="mt-5 rounded-xl border bg-background/55 p-4 text-xs leading-5 text-muted-foreground">
            {project.scene_plan.status === 'generating'
              ? 'AI 正在生成分镜，完成后可编辑当前场景。'
              : project.scene_plan.status === 'stale'
                ? '主音频时间轴已变化，请重新校准全部分镜。'
                : project.scene_plan.status === 'failed'
                  ? project.scene_plan.error || '分镜生成失败，可重新生成。'
                  : '生成分镜后可在这里编辑屏显文字、高亮和动效。'}
          </div>
        )}

        <Button
          className="mt-5 w-full"
          variant="outline"
          disabled={project.scene_plan.status === 'generating'}
          onClick={() => onOpenSceneDirection(director.scope)}
        >
          <WandSparkles data-icon />
          {director.label}
        </Button>
        {project.output_asset_url && project.output_stale ? (
          <Alert variant="info" className="mt-3">
            <AlertDescription>
              模板视觉已更新，当前为上一版成片；重新渲染后更新
            </AlertDescription>
          </Alert>
        ) : null}
        {hasOutput ? (
          <div className="mt-3 flex flex-col gap-2 rounded-xl border bg-background/55 p-2">
            <video
              aria-label="成片视频"
              className="aspect-video w-full rounded-lg bg-muted object-contain"
              controls
              preload="metadata"
              src={creativeAssetUrl(project.output_asset_url)}
            />
            <a
              className={buttonVariants({
                variant: 'outline',
                size: 'sm',
              })}
              href={textVideoOutputDownloadUrl(project.id)}
              download
            >
              <Download data-icon="inline-start" />
              下载 MP4
            </a>
          </div>
        ) : null}
        {renderRunning ? (
          <Progress
            className="mt-3"
            value={renderProgress}
            aria-label="视频渲染进度"
          >
            <ProgressLabel>正在渲染 {renderProgress}%</ProgressLabel>
            <ProgressValue />
          </Progress>
        ) : null}
        {!renderRunning && renderError ? (
          <Alert variant="danger" className="mt-3">
            <AlertDescription>{renderError}</AlertDescription>
          </Alert>
        ) : null}
        <Button
          className="mt-3 w-full"
          disabled={!previewReady || !onRenderVideo || renderRunning}
          aria-label={renderLabel}
          onClick={onRenderVideo}
        >
          {renderRunning ? <LoaderCircle data-icon="inline-start" /> : null}
          {renderLabel}
        </Button>
        {!previewReady ? (
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            先完成主音频、时间轴与分镜校准，再生成 MP4。
          </p>
        ) : hasCurrentOutput ? (
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            当前成片与编辑内容一致，可直接播放或下载。
          </p>
        ) : null}
      </aside>

      <SceneTimeline
        project={project}
        selectedSceneId={activeSceneId}
        onSelectScene={onSelectScene}
      />
      <TemplateSettingsDialog
        open={templateSettingsOpen}
        project={project}
        onOpenChange={setTemplateSettingsOpen}
        onApply={onApplyTemplateSettings}
      />
    </div>
  )
}

function SceneInspector({
  project,
  scene,
  sceneIndex,
  animations,
  onProjectChange,
}: {
  project: TextVideoProject
  scene: ScenePlanSceneDocument
  sceneIndex: number
  animations: readonly string[]
  onProjectChange(project: TextVideoProject): void
}) {
  const [displayText, setDisplayText] = useState(scene.displayText)
  const [highlightText, setHighlightText] = useState(
    scene.highlight.join('，'),
  )
  const sceneWords = wordsInsideScene(project, scene)
  const splitCandidates = sceneWords.slice(1)
  const [splitWordId, setSplitWordId] = useState(
    splitCandidates[0]?.id ?? '',
  )
  const previous = project.scene_plan.scenes[sceneIndex - 1]
  const next = project.scene_plan.scenes[sceneIndex + 1]
  const previousWordCount = previous
    ? wordsInsideScene(project, previous).length
    : 0
  const nextWordCount = next ? wordsInsideScene(project, next).length : 0

  function commitVisuals(
    update: Partial<Pick<
      ScenePlanSceneDocument,
      'displayText' | 'highlight' | 'animation'
    >>,
  ) {
    const highlights = update.highlight ?? parseHighlights(highlightText)
    try {
      onProjectChange(editSceneVisuals(project, scene.id, {
        displayText: update.displayText ?? displayText,
        highlight: highlights,
        animation: update.animation ?? scene.animation,
      }))
    } catch (error) {
      setDisplayText(scene.displayText)
      setHighlightText(scene.highlight.join('，'))
      toast.error(
        error instanceof Error ? error.message : '场景视觉设置无效',
      )
    }
  }

  function applyPlan(
    update: (
      timing: { masterDuration: number; fps: number },
    ) => TextVideoProject['scene_plan'],
  ) {
    try {
      const timing = {
        masterDuration: project.master_audio.duration,
        fps: project.render_input.composition.fps,
      }
      onProjectChange(applyScenePlanToProject(project, update(timing)))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '分镜边界调整失败')
    }
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Sparkles data-icon className="size-4" />
        当前场景
      </div>
      <div className="mt-4 space-y-4">
        <Field>
          <FieldLabel htmlFor={`scene-display-${scene.id}`}>
            场景展示文字
          </FieldLabel>
          <Input
            id={`scene-display-${scene.id}`}
            value={displayText}
            onChange={event => setDisplayText(event.target.value)}
            onBlur={() => commitVisuals({ displayText })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor={`scene-highlight-${scene.id}`}>
            高亮词
          </FieldLabel>
          <Input
            id={`scene-highlight-${scene.id}`}
            value={highlightText}
            placeholder="用逗号分隔"
            onChange={event => setHighlightText(event.target.value)}
            onBlur={() => commitVisuals({
              highlight: parseHighlights(highlightText),
            })}
          />
          <FieldDescription>
            每个高亮词都必须出现在展示文字中。
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>场景动效</FieldLabel>
          <Select
            value={scene.animation}
            onValueChange={animation => {
              if (animation) commitVisuals({ animation })
            }}
          >
            <SelectTrigger aria-label="场景动效" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {animations.map(animation => (
                  <SelectItem key={animation} value={animation}>
                    {animation}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        {splitCandidates.length > 0 ? (
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs font-medium">按词边界拆分</p>
            <Select
              value={splitWordId}
              onValueChange={value => setSplitWordId(value ?? '')}
            >
              <SelectTrigger
                aria-label="拆分位置"
                className="mt-2 w-full"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {splitCandidates.map(word => (
                    <SelectItem key={word.id} value={word.id}>
                      从“{word.text || '空白'}”前拆分
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              className="mt-2 w-full"
              size="sm"
              variant="outline"
              disabled={!splitWordId}
              onClick={() => applyPlan(timing => splitSceneAtWord(
                project.scene_plan,
                project.master_audio.word_timings,
                timing,
                scene.id,
                splitWordId,
              ))}
            >
              <Scissors data-icon />
              拆分场景
            </Button>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!previous}
            onClick={() => applyPlan(timing => mergeScene(
              project.scene_plan,
              project.master_audio.word_timings,
              timing,
              scene.id,
              'previous',
            ))}
          >
            <Merge data-icon />
            与上一场景合并
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!next}
            onClick={() => applyPlan(timing => mergeScene(
              project.scene_plan,
              project.master_audio.word_timings,
              timing,
              scene.id,
              'next',
            ))}
          >
            <Merge data-icon />
            与下一场景合并
          </Button>
        </div>

        {previous ? (
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={previousWordCount <= 1}
              onClick={() => applyPlan(timing => moveSceneBoundary(
                project.scene_plan,
                project.master_audio.word_timings,
                timing,
                previous.id,
                'backward',
                1,
              ))}
            >
              <ArrowRightFromLine data-icon />
              从上一幕移入一词
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={sceneWords.length <= 1}
              onClick={() => applyPlan(timing => moveSceneBoundary(
                project.scene_plan,
                project.master_audio.word_timings,
                timing,
                previous.id,
                'forward',
                1,
              ))}
            >
              <ArrowLeftFromLine data-icon />
              移给上一幕一词
            </Button>
          </div>
        ) : null}
        {next ? (
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={sceneWords.length <= 1}
              onClick={() => applyPlan(timing => moveSceneBoundary(
                project.scene_plan,
                project.master_audio.word_timings,
                timing,
                scene.id,
                'backward',
                1,
              ))}
            >
              <ArrowLeftFromLine data-icon />
              移给下一幕一词
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={nextWordCount <= 1}
              onClick={() => applyPlan(timing => moveSceneBoundary(
                project.scene_plan,
                project.master_audio.word_timings,
                timing,
                scene.id,
                'forward',
                1,
              ))}
            >
              <ArrowRightFromLine data-icon />
              从下一幕移入一词
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function wordsInsideScene(
  project: TextVideoProject,
  scene: ScenePlanSceneDocument,
) {
  const words = project.master_audio.word_timings
  const start = words.findIndex(word => word.id === scene.fromWordId)
  const end = words.findIndex(word => word.id === scene.throughWordId)
  return start >= 0 && end >= start ? words.slice(start, end + 1) : []
}

function parseHighlights(value: string): string[] {
  return [...new Set(value.split(/[，,\n]/).map(item => item.trim()).filter(
    Boolean,
  ))]
}

function directorAction(
  project: TextVideoProject,
  selectedSceneId: string,
): { label: string; scope: 'all' | 'selected' } {
  if (project.scene_plan.status === 'generating') {
    return { label: '正在生成分镜…', scope: 'all' }
  }
  if (
    project.scene_plan.status === 'stale'
    || (
      project.scene_plan.status === 'ready'
      && project.scene_plan.master_source_hash
        !== project.master_audio.source_hash
    )
  ) {
    return { label: '重新校准分镜', scope: 'all' }
  }
  if (
    project.scene_plan.status === 'ready'
    && selectedSceneId
  ) {
    return { label: '让 AI 调整画面', scope: 'selected' }
  }
  return { label: 'AI 生成分镜', scope: 'all' }
}

function templateDetails(project: TextVideoProject): {
  name: string
  animations: readonly string[]
} {
  try {
    const template = resolveTextVideoTemplate(
      project.render_input.templateId,
      project.render_input.templateVersion,
    )
    return {
      name: template.name ?? template.id,
      animations: template.animations,
    }
  } catch {
    return {
      name: `${project.render_input.templateId}（不可用）`,
      animations: [],
    }
  }
}
