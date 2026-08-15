'use client'

import { useState } from 'react'
import { LoaderCircle, WandSparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  RadioGroup,
  RadioGroupItem,
} from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import type { TextVideoSceneGenerateInput } from '@/lib/api/text-videos'

import type { TextVideoActionState } from './useTextVideoProjectActions'


export type SceneDirectionDraft = Omit<
  TextVideoSceneGenerateInput,
  'revision'
>

export function SceneDirectionDialog({
  open,
  initialScope,
  selectedSceneId,
  onOpenChange,
  onGenerate,
  actionState,
}: {
  open: boolean
  initialScope: 'all' | 'selected'
  selectedSceneId: string
  onOpenChange(open: boolean): void
  onGenerate(input: SceneDirectionDraft): Promise<void>
  actionState?: TextVideoActionState
}) {
  if (!open) return null
  return (
    <SceneDirectionSession
      initialScope={initialScope}
      selectedSceneId={selectedSceneId}
      onOpenChange={onOpenChange}
      onGenerate={onGenerate}
      actionState={actionState}
    />
  )
}

function SceneDirectionSession({
  initialScope,
  selectedSceneId,
  onOpenChange,
  onGenerate,
  actionState,
}: Omit<
  Parameters<typeof SceneDirectionDialog>[0],
  'open'
>) {
  const [scope, setScope] = useState<'all' | 'selected'>(
    initialScope === 'selected' && selectedSceneId ? 'selected' : 'all',
  )
  const [direction, setDirection] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [launchError, setLaunchError] = useState('')
  const busy = submitting || actionState?.status === 'running'
  const visibleError = launchError || (
    actionState?.status === 'failed' ? actionState.error : ''
  )

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && busy) return
    onOpenChange(nextOpen)
  }

  async function submit() {
    if (busy) return
    const effectiveScope = scope === 'selected' && selectedSceneId
      ? 'selected'
      : 'all'
    setLaunchError('')
    setSubmitting(true)
    try {
      await onGenerate({
        scope: effectiveScope,
        selected_scene_id: effectiveScope === 'selected'
          ? selectedSceneId
          : '',
        direction: direction.trim(),
      })
      onOpenChange(false)
    } catch (error) {
      setLaunchError(
        error instanceof Error ? error.message : '分镜生成失败',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={changeOpen}>
      <DialogContent
        size="md"
        showCloseButton={!busy}
        aria-busy={busy}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WandSparkles className="size-4 text-primary" />
            AI 画面导演
          </DialogTitle>
          <DialogDescription>
            AI 会基于当前主音频词时间轴调整分镜，不会改动口播和音频。
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={busy} className="space-y-5">
          <div>
            <legend className="mb-2 text-sm font-medium">调整范围</legend>
            <RadioGroup
              value={scope}
              onValueChange={value => {
                if (value === 'all' || value === 'selected') setScope(value)
              }}
              className="grid gap-2 sm:grid-cols-2"
            >
              <Label className="rounded-lg border border-border p-3">
                <RadioGroupItem
                  value="all"
                  aria-label="调整全部场景"
                />
                <span>
                  <span className="block">调整全部场景</span>
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">
                    重新规划完整画面节奏
                  </span>
                </span>
              </Label>
              <Label
                className="rounded-lg border border-border p-3"
                data-disabled={!selectedSceneId}
              >
                <RadioGroupItem
                  value="selected"
                  aria-label="仅调整当前场景"
                  disabled={!selectedSceneId}
                />
                <span>
                  <span className="block">仅调整当前场景</span>
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">
                    保留其他分镜不变
                  </span>
                </span>
              </Label>
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label htmlFor="scene-direction">创意方向</Label>
            <Textarea
              id="scene-direction"
              value={direction}
              maxLength={1_000}
              rows={5}
              onChange={event => setDirection(event.target.value)}
              placeholder="例如：强调观点转折，关键词出现时使用更有力量的缩放动效"
            />
            <p className="text-xs text-muted-foreground">
              可留空，由 AI 根据稿件和时间轴自动设计。
            </p>
          </div>
        </fieldset>

        {visibleError ? (
          <p role="alert" className="text-sm text-destructive">
            {visibleError}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? (
              <LoaderCircle data-icon className="animate-spin" />
            ) : (
              <WandSparkles data-icon />
            )}
            {busy ? '正在调整画面…' : '让 AI 调整画面'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
