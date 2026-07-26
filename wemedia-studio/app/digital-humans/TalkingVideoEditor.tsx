'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, Loader2, Play, Sparkles, UserRound } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { creativeAssetUrl, type CreativeAsset } from '@/lib/api/assets'
import {
  createTalkingVideoRender,
  getTalkingVideo,
  updateTalkingVideo,
  type DigitalHuman,
  type TalkingVideoProject,
  type TalkingVideoUpdate,
} from '@/lib/api/digital-humans'

import { EnvironmentPickerDialog } from './EnvironmentPickerDialog'
import { RenderVersionsPanel } from './RenderVersionsPanel'
import { ScriptAssistantDialog } from './ScriptAssistantDialog'


export function TalkingVideoEditor({
  project,
  roles,
  onProjectChange,
  saveProject = updateTalkingVideo,
}: {
  project: TalkingVideoProject
  roles: DigitalHuman[]
  onProjectChange?: (project: TalkingVideoProject) => void
  saveProject?: typeof updateTalkingVideo
}) {
  const [script, setScript] = useState(project.script)
  const [roleId, setRoleId] = useState(project.digital_human_id)
  const [environment, setEnvironment] = useState<CreativeAsset | null>(
    project.effective_environment,
  )
  const [environmentOverrideId, setEnvironmentOverrideId] = useState<number | null>(
    project.environment_asset_id,
  )
  const [scriptSource, setScriptSource] = useState(project.script_source)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  const [confirmRender, setConfirmRender] = useState(false)
  const [rendering, setRendering] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSave = useRef<TalkingVideoUpdate | null>(null)
  const saveProjectRef = useRef(saveProject)
  const onProjectChangeRef = useRef(onProjectChange)
  saveProjectRef.current = saveProject
  onProjectChangeRef.current = onProjectChange

  const role = roles.find(item => item.id === roleId) ?? null
  const hasActiveRender = project.renders.some(
    render => render.status === 'queued' || render.status === 'running',
  )

  useEffect(() => {
    if (!hasActiveRender) return
    const timer = window.setInterval(() => {
      void getTalkingVideo(project.id).then(updated => onProjectChange?.(updated))
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [hasActiveRender, onProjectChange, project.id])

  useEffect(() => () => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    const body = pendingSave.current
    pendingSave.current = null
    saveTimer.current = null
    if (!body) return
    void saveProjectRef.current(project.id, body)
      .then(updated => onProjectChangeRef.current?.(updated))
      .catch(() => toast.error('作品自动保存失败'))
  }, [project.id])

  function scheduleSave(update: TalkingVideoUpdate) {
    pendingSave.current = { ...pendingSave.current, ...update }
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      const body = pendingSave.current
      pendingSave.current = null
      saveTimer.current = null
      if (!body) return
      try {
        const updated = await saveProject(project.id, body)
        onProjectChange?.(updated)
      } catch {
        toast.error('作品自动保存失败')
      }
    }, 600)
  }

  async function flushSave() {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const body = pendingSave.current
    pendingSave.current = null
    if (!body) return
    const updated = await saveProject(project.id, body)
    onProjectChange?.(updated)
  }

  function changeRole(value: string | null) {
    if (!value) return
    const nextId = Number(value)
    const nextRole = roles.find(item => item.id === nextId)
    setRoleId(nextId)
    if (environmentOverrideId === null) {
      setEnvironment(nextRole?.default_environment ?? null)
    }
    scheduleSave({ digital_human_id: nextId })
  }

  const currentRender = useMemo(
    () => project.renders.find(render => render.id === project.current_render_id)
      ?? project.renders.find(render => render.status === 'succeeded')
      ?? null,
    [project.current_render_id, project.renders],
  )

  const canRender = role?.status === 'ready'
    && Boolean(script.trim())
    && environment !== null
    && !hasActiveRender

  async function generateRender() {
    setRendering(true)
    try {
      await flushSave()
      await createTalkingVideoRender(project.id)
      onProjectChange?.(await getTalkingVideo(project.id))
      setConfirmRender(false)
      toast.success('新版本已提交 HeyGen 生成')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '生成失败')
    } finally {
      setRendering(false)
    }
  }

  return (
    <>
      <div className="grid min-w-0 gap-4 min-[1360px]:grid-cols-[200px_minmax(320px,1fr)_280px]">
        <aside
          data-testid="talking-config-column"
          className="flex flex-col gap-4"
        >
          <Card>
            <CardHeader>
              <CardTitle>角色与环境</CardTitle>
              <CardDescription>本次口播的可替换配置</CardDescription>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel>数字人角色</FieldLabel>
                  <Select value={String(roleId)} onValueChange={changeRole}>
                    <SelectTrigger>
                      <SelectValue>
                        {value => roles.find(
                          item => String(item.id) === value,
                        )?.name ?? '选择数字人角色'}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {roles.map(item => (
                          <SelectItem
                            key={item.id}
                            value={String(item.id)}
                            disabled={item.status !== 'ready'}
                          >
                            {item.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {role?.status === 'ready' ? '形象和声音已就绪' : '角色尚未就绪'}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>环境图</FieldLabel>
                  {environment ? (
                    <img
                      src={creativeAssetUrl(environment.url)}
                      alt={environment.title}
                      className="aspect-video w-full rounded-lg object-cover"
                    />
                  ) : null}
                  <Button
                    variant="outline"
                    onClick={() => setEnvironmentOpen(true)}
                  >
                    <Image data-icon="inline-start" />
                    {environment ? '替换环境图' : '选择环境图'}
                  </Button>
                </Field>
              </FieldGroup>
            </CardContent>
          </Card>
        </aside>

        <main
          data-testid="talking-script-column"
          className="flex min-h-[68vh] flex-col"
        >
          <Card className="min-h-0 flex-1">
            <CardHeader>
              <CardTitle>脚本编辑器</CardTitle>
              <CardDescription>
                自动保存到当前口播作品，不进入独立脚本库。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
              <Field className="min-h-0 flex-1">
                <FieldLabel htmlFor="talking-script">口播脚本</FieldLabel>
                <Textarea
                  id="talking-script"
                  value={script}
                  onChange={event => {
                    const value = event.target.value
                    setScript(value)
                    setScriptSource('manual')
                    scheduleSave({
                      script: value,
                      script_source: 'manual',
                      source_draft_id: null,
                    })
                  }}
                  placeholder="在这里输入最终口播内容……"
                  className="min-h-96 flex-1 resize-none text-base leading-7"
                />
              </Field>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {script.length} 字 · {scriptSource === 'draft'
                    ? '来自草稿'
                    : scriptSource === 'ai' ? 'AI 辅助' : '手动编辑'}
                </span>
                <Button variant="outline" onClick={() => setAssistantOpen(true)}>
                  <Sparkles data-icon="inline-start" />
                  AI 辅助
                </Button>
              </div>
            </CardContent>
          </Card>
        </main>

        <aside
          data-testid="talking-render-column"
          className="flex flex-col gap-4"
        >
          <Card>
            <CardHeader>
              <CardTitle>成片预览</CardTitle>
              <CardDescription>16:9 · MP4 · 无字幕与配乐</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {currentRender?.video_asset ? (
                <video
                  src={creativeAssetUrl(currentRender.video_asset.url)}
                  controls
                  preload="metadata"
                  className="aspect-video w-full rounded-lg bg-muted"
                />
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <UserRound />
                </div>
              )}
              {hasActiveRender ? (
                <Badge variant="secondary">HeyGen 正在生成</Badge>
              ) : null}
              <Button
                disabled={!canRender || rendering}
                onClick={() => setConfirmRender(true)}
              >
                {rendering
                  ? <Loader2 data-icon="inline-start" />
                  : <Play data-icon="inline-start" />}
                生成新版本
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>历史版本</CardTitle>
              <CardDescription>每次生成都会保留独立快照</CardDescription>
            </CardHeader>
            <CardContent>
              <RenderVersionsPanel
                projectId={project.id}
                renders={project.renders}
                currentRenderId={project.current_render_id}
                onChanged={updated => {
                  if (updated) onProjectChange?.(updated)
                  else void getTalkingVideo(project.id).then(value => onProjectChange?.(value))
                }}
              />
            </CardContent>
          </Card>
        </aside>
      </div>

      <EnvironmentPickerDialog
        open={environmentOpen}
        onClose={() => setEnvironmentOpen(false)}
        onSelect={asset => {
          setEnvironment(asset)
          setEnvironmentOverrideId(asset.id)
          scheduleSave({ environment_asset_id: asset.id })
        }}
      />
      <ScriptAssistantDialog
        open={assistantOpen}
        project={{ ...project, script }}
        onClose={() => setAssistantOpen(false)}
        onUse={(value, source, draftId) => {
          setScript(value)
          setScriptSource(source)
          scheduleSave({
            script: value,
            script_source: source,
            source_draft_id: draftId,
          })
        }}
      />
      <Dialog
        open={confirmRender}
        onOpenChange={value => !value && setConfirmRender(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>生成新的口播版本？</DialogTitle>
            <DialogDescription>
              当前脚本、角色与环境会被冻结为新版本，已有版本不会被覆盖。
            </DialogDescription>
          </DialogHeader>
          <Button onClick={() => void generateRender()} disabled={rendering}>
            {rendering
              ? <Loader2 data-icon="inline-start" />
              : <Play data-icon="inline-start" />}
            确认生成
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
