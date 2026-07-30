'use client'

import { useEffect, useMemo, useState } from 'react'
import { LoaderCircle, RotateCcw } from 'lucide-react'

import {
  TemplateSettingsForm,
  templateSettingsFieldErrors,
  type TemplateSettingsManifest,
} from '@/components/features/text-video/TemplateSettingsForm'
import {
  Alert,
  AlertDescription,
} from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getSettings } from '@/lib/api/settings'
import type { TextVideoProject } from '@/lib/api/text-videos'
import { resolveTextVideoTemplate } from '@/remotion/registry'

import { RemotionPreview } from './RemotionPreview'


export function TemplateSettingsDialog({
  open,
  project,
  onOpenChange,
  onApply,
}: {
  open: boolean
  project: TextVideoProject
  onOpenChange(open: boolean): void
  onApply(props: Record<string, unknown>): Promise<void>
}) {
  if (!open) return null

  return (
    <TemplateSettingsSession
      project={project}
      onOpenChange={onOpenChange}
      onApply={onApply}
    />
  )
}

function TemplateSettingsSession({
  project,
  onOpenChange,
  onApply,
}: Omit<Parameters<typeof TemplateSettingsDialog>[0], 'open'>) {
  const manifest = resolveTextVideoTemplate(
    project.render_input.templateId,
    project.render_input.templateVersion,
  ) as TemplateSettingsManifest<Record<string, unknown>>
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    manifest.propsSchema.parse({
      ...project.render_input.templateProps,
    }),
  )
  const [restoreDraft, setRestoreDraft] = useState<
    Record<string, unknown> | null
  >(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState('')
  const [applyError, setApplyError] = useState('')
  const [applying, setApplying] = useState(false)
  const templateKey = `${project.render_input.templateId}@${
    project.render_input.templateVersion
  }`

  useEffect(() => {
    let active = true

    void getSettings().then(settings => {
      const parsed = manifest.propsSchema.safeParse({
        ...manifest.defaults,
        ...settings.text_video_template_defaults[templateKey],
      })
      if (!parsed.success) {
        throw new Error('平台模板默认值无效')
      }
      if (active) setRestoreDraft(parsed.data)
    }).catch(error => {
      if (!active) return
      setRestoreDraft(null)
      setLoadError(
        error instanceof Error ? error.message : '平台默认值加载失败',
      )
    })

    return () => {
      active = false
    }
  }, [manifest, templateKey])

  const previewProject = useMemo<TextVideoProject>(() => ({
    ...project,
    render_input: {
      ...project.render_input,
      templateProps: draft,
    },
  }), [draft, project])

  function changeDraft(nextDraft: Record<string, unknown>) {
    setDraft(nextDraft)
    setApplyError('')
    setFieldErrors(currentErrors => Object.fromEntries(
      Object.entries(currentErrors).filter(([key]) =>
        Object.is(draft[key], nextDraft[key]),
      ),
    ))
  }

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && applying) return
    onOpenChange(nextOpen)
  }

  async function apply() {
    if (applying) return
    const parsed = manifest.propsSchema.safeParse(draft)
    if (!parsed.success) {
      setFieldErrors(templateSettingsFieldErrors(parsed.error))
      return
    }

    setFieldErrors({})
    setApplyError('')
    setApplying(true)
    try {
      await onApply(parsed.data)
      setDraft(parsed.data)
      onOpenChange(false)
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : '保存失败')
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open onOpenChange={changeOpen}>
      <DialogContent
        size="lg"
        showCloseButton={!applying}
        aria-busy={applying}
        className="max-h-[calc(100dvh-2rem)] overflow-hidden"
      >
        <DialogHeader>
          <DialogTitle>模板视觉设置</DialogTitle>
          <DialogDescription>
            仅修改当前作品的品牌与画面风格；应用后立即保存，不改变平台默认值。
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(300px,0.9fr)]">
          <div className="max-h-[min(68dvh,680px)] overflow-y-auto pr-3">
            <TemplateSettingsForm
              manifest={manifest}
              value={draft}
              onChange={changeDraft}
              fieldErrors={fieldErrors}
            />
          </div>

          <section
            aria-label="模板视觉草稿预览"
            className="flex min-h-[360px] items-center justify-center overflow-hidden rounded-xl border bg-[#030711] p-3"
          >
            <div className="h-[min(58dvh,600px)] max-h-full aspect-[9/16] overflow-hidden rounded-lg">
              <RemotionPreview
                project={previewProject}
                selectedSceneId={project.scene_plan.scenes[0]?.id ?? ''}
                previewAll
              />
            </div>
          </section>
        </div>

        {loadError ? (
          <Alert variant="warning">
            <AlertDescription>{loadError}</AlertDescription>
          </Alert>
        ) : null}
        {applyError ? (
          <Alert variant="destructive">
            <AlertDescription>{applyError}</AlertDescription>
          </Alert>
        ) : null}

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            disabled={!restoreDraft || applying}
            onClick={() => {
              if (!restoreDraft) return
              setDraft({ ...restoreDraft })
              setFieldErrors({})
              setApplyError('')
            }}
          >
            <RotateCcw data-icon="inline-start" />
            恢复平台默认值
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              disabled={applying}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={applying}
              onClick={() => void apply()}
            >
              {applying ? (
                <LoaderCircle
                  data-icon="inline-start"
                  className="animate-spin"
                />
              ) : null}
              {applying ? '正在应用…' : '应用'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
