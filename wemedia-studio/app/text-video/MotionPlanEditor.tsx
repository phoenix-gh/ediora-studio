'use client'

import { useState } from 'react'
import { LoaderCircle, Sparkles, WandSparkles } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type {
  KineticSceneMotionPlan,
  ScenePlanSceneDocument,
  TextVideoProject,
} from '@/lib/api/text-videos'
import {
  applyRuleMotionPlan,
  editSceneMotion,
} from '@/lib/text-video/motion-plan'

type MotionPlanEditorProps = {
  project: TextVideoProject
  scene: ScenePlanSceneDocument
  busy: boolean
  onProjectChange(project: TextVideoProject): void
  onOptimize(
    scope: 'all' | 'selected',
    direction: string,
  ): void | Promise<void>
}

const PRESET_LABELS = {
  impact: '冲击强调',
  reveal: '逐层揭示',
  contrast: '反差切换',
} as const

export function MotionPlanEditor({
  project,
  scene,
  busy,
  onProjectChange,
  onOptimize,
}: MotionPlanEditorProps) {
  const [dialogScope, setDialogScope] = useState<
    'all' | 'selected' | null
  >(null)
  const [direction, setDirection] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const motion = scene.motion
  const exactTiming = project.master_audio.timeline_source === 'provider'
  const disabled = busy || submitting

  function applyMotion(next: KineticSceneMotionPlan) {
    try {
      onProjectChange(editSceneMotion(project, scene.id, next))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '动效设置无效')
    }
  }

  function moveChunkBoundary(
    leftIndex: number,
    direction: 'left' | 'right',
  ) {
    if (!motion) return
    const words = project.master_audio.word_timings
    const indexes = new Map(words.map((word, index) => [word.id, index]))
    const left = motion.chunks[leftIndex]
    const right = motion.chunks[leftIndex + 1]
    const leftFrom = indexes.get(left.fromWordId)
    const leftThrough = indexes.get(left.throughWordId)
    const rightFrom = indexes.get(right.fromWordId)
    const rightThrough = indexes.get(right.throughWordId)
    if (
      leftFrom === undefined
      || leftThrough === undefined
      || rightFrom === undefined
      || rightThrough === undefined
    ) return

    const chunks = motion.chunks.map(chunk => ({
      ...chunk,
      highlight: [...chunk.highlight],
    }))
    if (direction === 'left') {
      if (rightFrom >= rightThrough) return
      const moved = words[rightFrom].text
      const splitAt = right.displayText.indexOf(moved)
      const moveEnd = splitAt >= 0 ? splitAt + moved.length : moved.length
      const movedText = right.displayText.slice(0, moveEnd)
      chunks[leftIndex] = {
        ...left,
        throughWordId: words[rightFrom].id,
        displayText: left.displayText + movedText,
        highlight: left.highlight.filter(item => (
          (left.displayText + movedText).includes(item)
        )),
      }
      chunks[leftIndex + 1] = {
        ...right,
        fromWordId: words[rightFrom + 1].id,
        displayText: right.displayText.slice(moveEnd),
        highlight: right.highlight.filter(item => (
          right.displayText.slice(moveEnd).includes(item)
        )),
      }
    } else {
      if (leftFrom >= leftThrough) return
      const moved = words[leftThrough].text
      const splitAt = left.displayText.lastIndexOf(moved)
      const moveStart = splitAt >= 0
        ? splitAt
        : Math.max(0, left.displayText.length - moved.length)
      const movedText = left.displayText.slice(moveStart)
      chunks[leftIndex] = {
        ...left,
        throughWordId: words[leftThrough - 1].id,
        displayText: left.displayText.slice(0, moveStart),
        highlight: left.highlight.filter(item => (
          left.displayText.slice(0, moveStart).includes(item)
        )),
      }
      chunks[leftIndex + 1] = {
        ...right,
        fromWordId: words[leftThrough].id,
        displayText: movedText + right.displayText,
        highlight: right.highlight.filter(item => (
          (movedText + right.displayText).includes(item)
        )),
      }
    }
    applyMotion({ ...motion, chunks })
  }

  async function submitOptimization() {
    if (!dialogScope || disabled) return
    setSubmitting(true)
    try {
      await onOptimize(dialogScope, direction.trim())
      setDialogScope(null)
      setDirection('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'AI 动效优化失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Sparkles data-icon className="size-4 text-primary" />
          动效编排
        </div>
        <Badge variant="secondary">
          {exactTiming ? '精确词时间' : '使用估算时间'}
        </Badge>
      </div>

      {busy ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-primary">
          <LoaderCircle data-icon className="size-3.5 animate-spin" />
          正在优化动效…
        </div>
      ) : null}
      {project.scene_plan.error ? (
        <Alert variant="danger" className="mt-3">
          <AlertDescription>{project.scene_plan.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => {
            try {
              onProjectChange(applyRuleMotionPlan(project, [scene.id]))
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : '自动拆句失败',
              )
            }
          }}
        >
          自动拆句
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setDialogScope('selected')}
        >
          AI 优化本场
        </Button>
      </div>
      <Button
        className="mt-2 w-full"
        size="sm"
        disabled={disabled}
        onClick={() => setDialogScope('all')}
      >
        <WandSparkles data-icon />
        AI 优化全片
      </Button>

      {motion ? (
        <>
          <Field className="mt-4">
            <FieldLabel htmlFor={`motion-intensity-${scene.id}`}>
              动效强度
            </FieldLabel>
            <Input
              id={`motion-intensity-${scene.id}`}
              type="number"
              min={0}
              max={1}
              step={0.05}
              disabled={disabled}
              value={motion.intensity}
              onChange={event => {
                const intensity = Number(event.target.value)
                if (Number.isFinite(intensity) && intensity >= 0 && intensity <= 1) {
                  applyMotion({ ...motion, intensity })
                }
              }}
            />
          </Field>
          <div className="mt-3 space-y-2">
            {motion.chunks.map((chunk, index) => {
              const timing = chunkTiming(project, chunk)
              return (
                <div
                  className="rounded-lg border border-border bg-background/60 p-3"
                  key={chunk.id}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">
                        {index + 1}. {chunk.displayText}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {timing}
                      </p>
                    </div>
                    <Badge variant="outline">{chunk.emphasis}</Badge>
                  </div>
                  {chunk.highlight.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {chunk.highlight.map(item => (
                        <Badge key={item} variant="secondary">{item}</Badge>
                      ))}
                    </div>
                  ) : null}
                  <Select
                    value={chunk.motionPreset}
                    disabled={disabled}
                    onValueChange={value => {
                      if (
                        value !== 'impact'
                        && value !== 'reveal'
                        && value !== 'contrast'
                      ) return
                      const chunks = motion.chunks.map(item => (
                        item.id === chunk.id
                          ? {
                              ...item,
                              motionPreset: value,
                              emphasis: value === 'impact'
                                ? 'punch' as const
                                : 'normal' as const,
                            }
                          : item
                      ))
                      applyMotion({ ...motion, chunks })
                    }}
                  >
                    <SelectTrigger
                      aria-label="短句动作"
                      className="mt-2 w-full"
                      size="sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {Object.entries(PRESET_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  {index < motion.chunks.length - 1 ? (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={
                          disabled
                          || chunkWordCount(
                            project,
                            motion.chunks[index + 1],
                          ) <= 1
                        }
                        aria-label={`边界 ${index + 1} 向前一词`}
                        onClick={() => moveChunkBoundary(index, 'left')}
                      >
                        ← 向前一词
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={
                          disabled
                          || chunkWordCount(project, chunk) <= 1
                        }
                        aria-label={`边界 ${index + 1} 向后一词`}
                        onClick={() => moveChunkBoundary(index, 'right')}
                      >
                        向后一词 →
                      </Button>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </>
      ) : (
        <p className="mt-3 rounded-lg border border-dashed p-3 text-xs leading-5 text-muted-foreground">
          尚未编排短句。点击“自动拆句”生成可编辑的第一版动效。
        </p>
      )}

      <Dialog
        open={dialogScope !== null}
        onOpenChange={open => {
          if (!open && !submitting) setDialogScope(null)
        }}
      >
        <DialogContent size="md" aria-busy={submitting}>
          <DialogHeader>
            <DialogTitle>AI 动效优化</DialogTitle>
            <DialogDescription>
              AI 只调整短句动作和强调节奏，不会修改口播、屏显文字或词边界。
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="motion-direction">创意方向</FieldLabel>
            <Textarea
              id="motion-direction"
              value={direction}
              disabled={submitting}
              maxLength={1000}
              placeholder="可留空，例如：强调反差，节奏更有力量"
              onChange={event => setDirection(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => setDialogScope(null)}
            >
              取消
            </Button>
            <Button disabled={submitting} onClick={submitOptimization}>
              {submitting ? <LoaderCircle data-icon /> : null}
              开始优化
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function chunkTiming(
  project: TextVideoProject,
  chunk: NonNullable<ScenePlanSceneDocument['motion']>['chunks'][number],
) {
  const words = project.master_audio.word_timings
  const from = words.find(word => word.id === chunk.fromWordId)
  const through = words.find(word => word.id === chunk.throughWordId)
  if (!from || !through) return '待校准'
  return `${from.start.toFixed(2)}s – ${through.end.toFixed(2)}s`
}

function chunkWordCount(
  project: TextVideoProject,
  chunk: NonNullable<ScenePlanSceneDocument['motion']>['chunks'][number],
) {
  const words = project.master_audio.word_timings
  const from = words.findIndex(word => word.id === chunk.fromWordId)
  const through = words.findIndex(word => word.id === chunk.throughWordId)
  return from >= 0 && through >= from ? through - from + 1 : 0
}
