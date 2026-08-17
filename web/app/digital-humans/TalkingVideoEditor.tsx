'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Image,
  Loader2,
  Play,
  Sparkles,
  Trash2,
  UserRound,
} from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { creativeAssetUrl, type CreativeAsset } from '@/lib/api/assets'
import {
  createTalkingVideoRender,
  getTalkingVideo,
  planTalkingVideoShots,
  renderPendingTalkingVideoShots,
  renderTalkingVideoShot,
  saveTalkingVideoShots,
  stitchTalkingVideo,
  updateTalkingVideo,
  type DigitalHuman,
  type TalkingVideoProject,
  type TalkingVideoShot,
  type TalkingVideoUpdate,
} from '@/lib/api/digital-humans'

import {
  buildShotPrompt,
  DEFAULT_DELIVERY,
  DEFAULT_PRESENCE,
  estimateShotSeconds,
} from '@/lib/comfyui/workflow'

import { EnvironmentPickerDialog } from './EnvironmentPickerDialog'
import { RenderVersionsPanel } from './RenderVersionsPanel'
import { ScriptAssistantDialog } from './ScriptAssistantDialog'


function PromptRefPreview({
  tag,
  label,
  kind,
  url,
}: {
  tag: string
  label: string
  kind: 'image' | 'video' | 'audio'
  url: string
}) {
  const src = creativeAssetUrl(url)
  const name = `${tag} ${label}`
  return (
    <figure className="min-w-[7.5rem] flex-1">
      <figcaption className="mb-1 truncate text-[11px] text-muted-foreground">
        {name}
      </figcaption>
      {kind === 'image' ? (
        <img
          src={src}
          alt={name}
          className="aspect-video w-full rounded-md border object-cover"
        />
      ) : null}
      {kind === 'video' ? (
        <video
          src={src}
          aria-label={name}
          muted
          playsInline
          preload="metadata"
          className="aspect-video w-full rounded-md border object-cover"
        />
      ) : null}
      {kind === 'audio' ? (
        <audio src={src} aria-label={name} controls className="w-full" />
      ) : null}
    </figure>
  )
}


function displayShotPrompt(
  shot: TalkingVideoShot,
  baseDelivery = '',
  presence = '',
) {
  return shot.render_prompt?.trim()
    ? shot.render_prompt
    : buildShotPrompt({
        framing: shot.framing,
        spokenText: shot.spoken_text,
        motionPrompt: shot.motion_prompt,
        delivery: shot.delivery,
        baseDelivery,
        presence: shot.presence,
        basePresence: presence,
      })
}

function lastSubmittedPrompt(shot: TalkingVideoShot) {
  const value = shot.provider_state?.submitted_prompt
  return typeof value === 'string' ? value : ''
}

const SHOT_STATUS_LABEL: Record<TalkingVideoShot['status'], string> = {
  draft: '草稿',
  queued: '排队',
  running: '生成中',
  succeeded: '完成',
  failed: '失败',
}

function shotStatusLabel(shot: TalkingVideoShot) {
  return shot.clip_asset ? '可试看' : SHOT_STATUS_LABEL[shot.status]
}

const FRAMING_LABEL = {
  wide: '远景',
  medium: '中景',
  close: '近景',
} as const


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
  const [delivery, setDelivery] = useState(project.delivery ?? '')
  const [presence, setPresence] = useState(project.presence ?? '')
  const [shots, setShots] = useState<TalkingVideoShot[]>(project.shots ?? [])
  const [activeShotId, setActiveShotId] = useState(project.shots?.[0]?.id ?? '')
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
  const [confirmRegenShot, setConfirmRegenShot] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [enqueueing, setEnqueueing] = useState(false)
  const [workbench, setWorkbench] = useState<'script' | 'shots'>('script')
  const [shotPane, setShotPane] = useState<'spoken' | 'prompt'>('spoken')
  const [previewPane, setPreviewPane] = useState<'shot' | 'final'>('shot')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSave = useRef<TalkingVideoUpdate | null>(null)
  const shotSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingShotSave = useRef<TalkingVideoShot[] | null>(null)
  const saveProjectRef = useRef(saveProject)
  const onProjectChangeRef = useRef(onProjectChange)

  useEffect(() => {
    saveProjectRef.current = saveProject
    onProjectChangeRef.current = onProjectChange
  }, [onProjectChange, saveProject])

  const role = roles.find(item => item.id === roleId) ?? null
  const isComfy = (role?.provider ?? project.role.provider) === 'comfyui'
  const missingComfyVoice = isComfy && !role?.voice_sample_asset_id
  const roleReadyHint = !role || role.status !== 'ready'
    ? '角色尚未就绪'
    : missingComfyVoice
      ? '还缺 2–15 秒声音样本，请先到角色里补上'
      : '形象和声音已就绪'
  const hasActiveShot = shots.some(
    shot => shot.status === 'queued' || shot.status === 'running',
  )
  const hasActiveStitch = project.renders.some(
    render => render.status === 'queued' || render.status === 'running',
  )
  const hasActiveRender = hasActiveShot || hasActiveStitch

  useEffect(() => {
    setShots(project.shots ?? [])
  }, [project.shots])

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
    if (body) {
      void saveProjectRef.current(project.id, body)
        .then(updated => onProjectChangeRef.current?.(updated))
        .catch(() => toast.error('作品自动保存失败'))
    }
    if (shotSaveTimer.current !== null) clearTimeout(shotSaveTimer.current)
    const queuedShots = pendingShotSave.current
    pendingShotSave.current = null
    shotSaveTimer.current = null
    if (queuedShots) {
      void saveTalkingVideoShots(project.id, queuedShots)
        .catch(() => toast.error('镜头保存失败'))
    }
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
    if (body) {
      const updated = await saveProject(project.id, body)
      onProjectChange?.(updated)
    }
    if (shotSaveTimer.current !== null) clearTimeout(shotSaveTimer.current)
    shotSaveTimer.current = null
    const nextShots = pendingShotSave.current
    pendingShotSave.current = null
    if (nextShots) await persistShots(nextShots)
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
    && !isComfy
  const allShotsReady = shots.length > 0
    && shots.every(shot => shot.status === 'succeeded' && shot.clip_asset_id)
  const pendingShots = shots.filter(
    shot => shot.status === 'draft' || shot.status === 'failed',
  )
  const minShotSeconds = project.min_shot_seconds ?? 4
  const maxShotSeconds = project.max_shot_seconds ?? 5
  const activeShot = shots.find(shot => shot.id === activeShotId) ?? shots[0] ?? null
  const previewClip = isComfy && previewPane !== 'final'
    ? activeShot?.clip_asset ?? null
    : currentRender?.video_asset ?? null

  async function persistShots(next: TalkingVideoShot[]) {
    setShots(next)
    const updated = await saveTalkingVideoShots(project.id, next)
    setShots(updated.shots)
    onProjectChange?.(updated)
    return updated
  }

  function patchShot(shotId: string, patch: Partial<TalkingVideoShot>) {
    setShots(current => {
      const next = current.map(item => (
        item.id === shotId
          ? { ...item, ...patch, status: 'draft' as const }
          : item
      ))
      pendingShotSave.current = next
      if (shotSaveTimer.current !== null) clearTimeout(shotSaveTimer.current)
      shotSaveTimer.current = setTimeout(() => {
        const body = pendingShotSave.current
        pendingShotSave.current = null
        shotSaveTimer.current = null
        if (!body) return
        void persistShots(body).catch(() => toast.error('镜头保存失败'))
      }, 400)
      return next
    })
  }

  async function handlePlanShots() {
    setPlanning(true)
    const toastId = toast.loading('正在规划分镜，请稍候…')
    try {
      await flushSave()
      const updated = await planTalkingVideoShots(project.id, script)
      setShots(updated.shots)
      setActiveShotId(updated.shots[0]?.id ?? '')
      setDelivery(updated.delivery ?? '')
      setPresence(updated.presence ?? '')
      setWorkbench('shots')
      setShotPane('spoken')
      onProjectChange?.(updated)
      toast.success(`已按全文重新规划 ${updated.shots.length} 个镜头`, { id: toastId })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '分镜规划失败', { id: toastId })
    } finally {
      setPlanning(false)
    }
  }

  async function handleEnqueuePending() {
    setEnqueueing(true)
    try {
      await flushSave()
      const updated = await renderPendingTalkingVideoShots(project.id)
      setShots(updated.shots)
      onProjectChange?.(updated)
      toast.success('未完成镜头已全部入队')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '入队失败')
    } finally {
      setEnqueueing(false)
    }
  }

  const thisShotBusy = activeShot?.status === 'queued' || activeShot?.status === 'running'
  const canGenerateThisShot = Boolean(activeShot)
    && !thisShotBusy
    && !missingComfyVoice
    && role?.status === 'ready'
  const thisShotHasClip = Boolean(activeShot?.clip_asset_id || activeShot?.clip_asset)

  async function handleRenderShot(shotId: string) {
    try {
      await flushSave()
      const updated = await renderTalkingVideoShot(project.id, shotId)
      setShots(updated.shots)
      onProjectChange?.(updated)
      setConfirmRegenShot(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '镜头生成失败')
    }
  }

  function requestGenerateThisShot() {
    if (!activeShot) return
    if (thisShotHasClip) {
      setConfirmRegenShot(true)
      return
    }
    void handleRenderShot(activeShot.id)
  }

  async function handleStitch() {
    try {
      await flushSave()
      await stitchTalkingVideo(project.id)
      const updated = await getTalkingVideo(project.id)
      setShots(updated.shots)
      setPreviewPane('final')
      onProjectChange?.(updated)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '拼接失败')
    }
  }

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
      <div className="grid h-full min-h-0 min-w-0 gap-4 overflow-hidden min-[1360px]:grid-cols-[200px_minmax(320px,1fr)_280px]">
        <aside
          data-testid="talking-config-column"
          className="flex min-h-0 flex-col gap-4 overflow-y-auto"
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
                    {roleReadyHint}
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
                {isComfy ? (
                  <Field>
                    <FieldLabel htmlFor="talking-delivery">整片语气</FieldLabel>
                    <Textarea
                      id="talking-delivery"
                      value={delivery}
                      onChange={event => {
                        const value = event.target.value
                        setDelivery(value)
                        scheduleSave({ delivery: value })
                      }}
                      placeholder={DEFAULT_DELIVERY}
                      className="min-h-20 resize-none text-sm leading-6"
                    />
                    <FieldDescription>
                      写清情绪和语速。规划分镜时会按整稿提炼。参考音频只借音色，不抄它的情绪或快慢。
                    </FieldDescription>
                  </Field>
                ) : null}
                {isComfy ? (
                  <Field>
                    <FieldLabel htmlFor="talking-presence">整片状态</FieldLabel>
                    <Textarea
                      id="talking-presence"
                      value={presence}
                      onChange={event => {
                        const value = event.target.value
                        setPresence(value)
                        scheduleSave({ presence: value })
                      }}
                      placeholder={DEFAULT_PRESENCE}
                      className="min-h-20 resize-none text-sm leading-6"
                    />
                    <FieldDescription>
                      写可见肢体：坐姿、头、手、肩、视线。规划时一并提炼。
                    </FieldDescription>
                  </Field>
                ) : null}
              </FieldGroup>
            </CardContent>
          </Card>
        </aside>

        <main
          data-testid="talking-script-column"
          className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        >
          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <CardHeader className="shrink-0">
              <CardTitle>{isComfy ? '口播工作台' : '脚本编辑器'}</CardTitle>
              <CardDescription>
                {isComfy
                  ? '整稿、分镜和提示词分开改。规划会整表替换，已生成片段一并作废。'
                  : '自动保存到当前口播作品，不进入独立脚本库。'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
              {isComfy ? (
                <Tabs
                  value={workbench}
                  onValueChange={value => setWorkbench(value as 'script' | 'shots')}
                  className="flex min-h-0 flex-1 flex-col overflow-hidden"
                >
                  <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                    <TabsList>
                      <TabsTrigger value="script">整稿</TabsTrigger>
                      <TabsTrigger value="shots">
                        分镜{shots.length ? ` ${shots.length}` : ''}
                      </TabsTrigger>
                    </TabsList>
                    <span className="text-xs text-muted-foreground">
                      {script.length} 字 · 单镜 {minShotSeconds}–{maxShotSeconds} 秒
                    </span>
                  </div>
                  <TabsContent value="script" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
                    <Field className="flex min-h-0 flex-1 flex-col">
                      <FieldLabel htmlFor="talking-full-script">全文口播</FieldLabel>
                      <Textarea
                        id="talking-full-script"
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
                        placeholder="粘贴或输入整段口播，再规划分镜……"
                        className="min-h-0 flex-1 resize-none overflow-y-auto text-base leading-7"
                      />
                    </Field>
                    <Button
                      disabled={planning || !script.trim() || hasActiveShot}
                      onClick={() => void handlePlanShots()}
                    >
                      {planning
                        ? <Loader2 data-icon="inline-start" className="animate-spin" />
                        : <Sparkles data-icon="inline-start" />}
                      {planning ? '规划中…' : 'AI 规划分镜'}
                    </Button>
                  </TabsContent>
                  <TabsContent value="shots" className="min-h-0 flex-1 overflow-hidden">
                    <div className="grid h-full min-h-0 gap-3 overflow-hidden lg:grid-cols-[220px_minmax(0,1fr)]">
                      <div className="flex min-h-0 flex-col gap-2">
                        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
                          {shots.map((shot, index) => {
                            const active = shot.id === (activeShot?.id ?? '')
                            return (
                              <button
                                key={shot.id}
                                type="button"
                                data-testid={`talking-shot-${shot.id}`}
                                className={`w-full rounded-lg border px-2.5 py-2 text-left ${
                                  active ? 'border-foreground/40 bg-accent' : 'hover:bg-muted/60'
                                }`}
                                onClick={() => setActiveShotId(shot.id)}
                              >
                                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                                  <span>镜 {index + 1} · {shot.duration_sec}s · {FRAMING_LABEL[shot.framing]}</span>
                                  <span>{shotStatusLabel(shot)}</span>
                                </div>
                                <p className="mt-1 line-clamp-2 text-sm leading-5">
                                  {shot.spoken_text.trim() || '（空口播）'}
                                </p>
                              </button>
                            )
                          })}
                        </div>
                        <Button
                          variant="outline"
                          onClick={() => {
                            const created = {
                              id: crypto.randomUUID(),
                              duration_sec: maxShotSeconds,
                              framing: 'medium' as const,
                              spoken_text: '',
                              motion_prompt: '',
                              delivery: '',
                              presence: '',
                              render_prompt: '',
                              first_frame_asset_id: null,
                              clip_asset_id: null,
                              status: 'draft' as const,
                              job_id: null,
                              error: '',
                              workflow_version: '',
                              seed: null,
                              provider_state: {},
                            }
                            const next = [...shots, created]
                            setActiveShotId(created.id)
                            void persistShots(next).catch(() => toast.error('镜头保存失败'))
                          }}
                        >
                          添加镜头
                        </Button>
                      </div>
                      {activeShot ? (
                        <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
                          {activeShot.status === 'failed' && activeShot.error ? (
                            <p className="text-xs text-destructive">{activeShot.error}</p>
                          ) : null}
                          <div className="flex flex-wrap items-center gap-2">
                            <Field className="w-24">
                              <FieldLabel htmlFor="talking-shot-duration">时长</FieldLabel>
                              <NativeSelect
                                id="talking-shot-duration"
                                aria-label={`镜头 ${shots.indexOf(activeShot) + 1} 时长`}
                                value={activeShot.duration_sec}
                                onChange={event => {
                                  patchShot(activeShot.id, {
                                    duration_sec: Number(event.target.value),
                                  })
                                }}
                              >
                                {Array.from(
                                  { length: maxShotSeconds - minShotSeconds + 1 },
                                  (_, index) => minShotSeconds + index,
                                ).map(seconds => (
                                  <option key={seconds} value={seconds}>{seconds} 秒</option>
                                ))}
                              </NativeSelect>
                            </Field>
                            <Field className="w-28">
                              <FieldLabel htmlFor="talking-shot-framing">景别</FieldLabel>
                              <NativeSelect
                                id="talking-shot-framing"
                                aria-label={`镜头 ${shots.indexOf(activeShot) + 1} 景别`}
                                value={activeShot.framing}
                                onChange={event => {
                                  patchShot(activeShot.id, {
                                    framing: event.target.value as TalkingVideoShot['framing'],
                                    render_prompt: '',
                                  })
                                }}
                              >
                                <option value="wide">远景</option>
                                <option value="medium">中景</option>
                                <option value="close">近景</option>
                              </NativeSelect>
                            </Field>
                            <div className="ml-auto flex gap-1">
                              <Button
                                type="button"
                                variant="outline"
                                disabled={shots[0]?.id === activeShot.id}
                                onClick={() => {
                                  const index = shots.findIndex(item => item.id === activeShot.id)
                                  if (index <= 0) return
                                  const next = [...shots]
                                  ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                                  void persistShots(next).catch(() => toast.error('镜头保存失败'))
                                }}
                              >
                                <ChevronUp />
                                上移
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                disabled={shots[shots.length - 1]?.id === activeShot.id}
                                onClick={() => {
                                  const index = shots.findIndex(item => item.id === activeShot.id)
                                  if (index < 0 || index >= shots.length - 1) return
                                  const next = [...shots]
                                  ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
                                  void persistShots(next).catch(() => toast.error('镜头保存失败'))
                                }}
                              >
                                <ChevronDown />
                                下移
                              </Button>
                              <Button
                                type="button"
                                variant="outline"
                                disabled={shots.length <= 1}
                                onClick={() => {
                                  const next = shots.filter(item => item.id !== activeShot.id)
                                  setActiveShotId(next[0]?.id ?? '')
                                  void persistShots(next).catch(() => toast.error('镜头保存失败'))
                                }}
                              >
                                <Trash2 />
                                删除
                              </Button>
                            </div>
                          </div>
                          <Tabs
                            value={shotPane}
                            onValueChange={value => setShotPane(value as 'spoken' | 'prompt')}
                            className="flex min-h-0 flex-1 flex-col overflow-hidden"
                          >
                            <TabsList>
                              <TabsTrigger value="spoken">本镜口播</TabsTrigger>
                              <TabsTrigger value="prompt">提示词</TabsTrigger>
                            </TabsList>
                            <TabsContent value="spoken" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
                              <Field className="flex min-h-0 flex-1 flex-col">
                                <FieldLabel htmlFor={`talking-shot-spoken-${activeShot.id}`}>
                                  口播句
                                </FieldLabel>
                                <Textarea
                                  id={`talking-shot-spoken-${activeShot.id}`}
                                  aria-label={`镜头 ${shots.indexOf(activeShot) + 1} 口播句`}
                                  value={activeShot.spoken_text}
                                  onChange={event => {
                                    patchShot(activeShot.id, {
                                      spoken_text: event.target.value,
                                      duration_sec: estimateShotSeconds(
                                        event.target.value,
                                        minShotSeconds,
                                        maxShotSeconds,
                                      ),
                                    })
                                  }}
                                  className="min-h-0 flex-1 resize-none overflow-y-auto text-base leading-7"
                                />
                              </Field>
                              <Field>
                                <FieldLabel htmlFor={`talking-shot-delivery-${activeShot.id}`}>
                                  本镜语气
                                </FieldLabel>
                                <Input
                                  id={`talking-shot-delivery-${activeShot.id}`}
                                  aria-label={`镜头 ${shots.indexOf(activeShot) + 1} 语气`}
                                  value={activeShot.delivery ?? ''}
                                  onChange={event => {
                                    patchShot(activeShot.id, {
                                      delivery: event.target.value,
                                      render_prompt: '',
                                    })
                                  }}
                                  placeholder={delivery.trim() || DEFAULT_DELIVERY}
                                />
                              </Field>
                              <Field>
                                <FieldLabel htmlFor={`talking-shot-presence-${activeShot.id}`}>
                                  本镜状态
                                </FieldLabel>
                                <Input
                                  id={`talking-shot-presence-${activeShot.id}`}
                                  aria-label={`镜头 ${shots.indexOf(activeShot) + 1} 状态`}
                                  value={activeShot.presence ?? ''}
                                  onChange={event => {
                                    patchShot(activeShot.id, {
                                      presence: event.target.value,
                                      render_prompt: '',
                                    })
                                  }}
                                  placeholder={presence.trim() || DEFAULT_PRESENCE}
                                />
                              </Field>
                            </TabsContent>
                            <TabsContent value="prompt" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
                              <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
                                {role?.look?.url ? (
                                  <PromptRefPreview
                                    tag="<Picture 1>"
                                    label="定妆图"
                                    kind="image"
                                    url={role.look.url}
                                  />
                                ) : null}
                                {environment?.url ? (
                                  <PromptRefPreview
                                    tag="<Picture 2>"
                                    label="环境图"
                                    kind="image"
                                    url={environment.url}
                                  />
                                ) : null}
                                {activeShot.framing === 'close' && role?.portrait?.url ? (
                                  <PromptRefPreview
                                    tag="<Picture 3>"
                                    label="正面照"
                                    kind="image"
                                    url={role.portrait.url}
                                  />
                                ) : null}
                                {role?.voice_sample?.url ? (
                                  <PromptRefPreview
                                    tag="<Audio 1>"
                                    label="音色样本"
                                    kind="audio"
                                    url={role.voice_sample.url}
                                  />
                                ) : null}
                              </div>
                              <Field className="flex min-h-0 flex-1 flex-col">
                                <FieldLabel htmlFor={`talking-shot-prompt-${activeShot.id}`}>
                                  H3 提示词
                                </FieldLabel>
                                <Textarea
                                  id={`talking-shot-prompt-${activeShot.id}`}
                                  aria-label={`镜头 ${shots.indexOf(activeShot) + 1} 提示词`}
                                  value={displayShotPrompt(activeShot, delivery, presence)}
                                  onChange={event => {
                                    patchShot(activeShot.id, { render_prompt: event.target.value })
                                  }}
                                  className="min-h-0 flex-1 resize-none overflow-y-auto font-mono text-xs leading-5"
                                />
                              </Field>
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  onClick={() => {
                                    patchShot(activeShot.id, {
                                      duration_sec: estimateShotSeconds(
                                        activeShot.spoken_text,
                                        minShotSeconds,
                                        maxShotSeconds,
                                      ),
                                      render_prompt: buildShotPrompt({
                                        framing: activeShot.framing,
                                        spokenText: activeShot.spoken_text,
                                        motionPrompt: activeShot.motion_prompt,
                                        delivery: activeShot.delivery,
                                        baseDelivery: delivery,
                                        presence: activeShot.presence,
                                        basePresence: presence,
                                      }),
                                    })
                                  }}
                                >
                                  按口播重填提示词
                                </Button>
                                {activeShot.seed != null ? (
                                  <span className="text-xs text-muted-foreground">
                                    seed {activeShot.seed}
                                  </span>
                                ) : null}
                              </div>
                              {lastSubmittedPrompt(activeShot)
                                && lastSubmittedPrompt(activeShot) !== displayShotPrompt(activeShot, delivery, presence)
                                ? (
                                  <details className="rounded-md bg-muted/50 p-2 text-xs">
                                    <summary className="cursor-pointer text-muted-foreground">
                                      上次提交的提示词
                                    </summary>
                                    <pre className="mt-2 whitespace-pre-wrap font-mono leading-5">
                                      {lastSubmittedPrompt(activeShot)}
                                    </pre>
                                  </details>
                                ) : null}
                            </TabsContent>
                          </Tabs>
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">先添加或选择一个镜头。</p>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              ) : (
                <>
                  <Field className="flex min-h-0 flex-1 flex-col">
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
                      className="min-h-0 flex-1 resize-none overflow-y-auto text-base leading-7"
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
                </>
              )}
            </CardContent>
          </Card>
        </main>

        <aside
          data-testid="talking-render-column"
          className="flex min-h-0 flex-col gap-4 overflow-y-auto"
        >
          <Card>
            <CardHeader>
              <CardTitle>{isComfy && previewPane !== 'final' ? '本镜预览' : '成片预览'}</CardTitle>
              <CardDescription>
                {isComfy && previewPane !== 'final'
                  ? activeShot
                                      ? `镜 ${shots.indexOf(activeShot) + 1} · ${shotStatusLabel(activeShot)}`
                    : '选中镜头后在这里试看'
                  : currentRender
                    ? `版本 ${currentRender.version} · 16:9 · MP4`
                    : '16:9 · MP4 · 无字幕与配乐'}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {isComfy ? (
                <Tabs
                  value={previewPane}
                  onValueChange={value => setPreviewPane(value as 'shot' | 'final')}
                >
                  <TabsList>
                    <TabsTrigger value="shot">本镜</TabsTrigger>
                    <TabsTrigger value="final">成片</TabsTrigger>
                  </TabsList>
                </Tabs>
              ) : null}
              {previewClip ? (
                <video
                  key={previewClip.url}
                  src={creativeAssetUrl(previewClip.url)}
                  controls
                  preload="metadata"
                  aria-label={isComfy && previewPane !== 'final' ? '本镜预览' : '成片预览'}
                  className="aspect-video w-full rounded-lg bg-muted"
                />
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-lg bg-muted px-3 text-center text-sm text-muted-foreground">
                  {isComfy && previewPane !== 'final'
                    ? '这一镜还没有成片，生成后可在这里试看'
                    : isComfy
                      ? '还没有成片，各镜都完成后点「生成成片」'
                      : <UserRound />}
                </div>
              )}
              {hasActiveRender ? (
                <Badge variant="secondary">
                  {isComfy ? '镜头正在生成' : 'HeyGen 正在生成'}
                </Badge>
              ) : null}
              {isComfy ? (
                <>
                  <Button
                    disabled={!canGenerateThisShot}
                    onClick={() => requestGenerateThisShot()}
                  >
                    <Play data-icon="inline-start" />
                    {thisShotHasClip ? '重新生成这一镜' : '生成这一镜'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={
                      enqueueing
                      || pendingShots.length === 0
                      || hasActiveShot
                      || missingComfyVoice
                      || role?.status !== 'ready'
                    }
                    onClick={() => void handleEnqueuePending()}
                  >
                    {enqueueing
                      ? <Loader2 data-icon="inline-start" />
                      : <Play data-icon="inline-start" />}
                    全部入队生成
                  </Button>
                  <Button
                    disabled={!allShotsReady || hasActiveStitch}
                    onClick={() => void handleStitch()}
                  >
                    生成成片
                  </Button>
                </>
              ) : (
                <Button
                  disabled={!canRender || rendering}
                  onClick={() => setConfirmRender(true)}
                >
                  {rendering
                    ? <Loader2 data-icon="inline-start" />
                    : <Play data-icon="inline-start" />}
                  生成新版本
                </Button>
              )}
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
        open={confirmRegenShot}
        onOpenChange={value => !value && setConfirmRegenShot(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重新生成这一镜？</DialogTitle>
            <DialogDescription>
              这一镜已有成片。确认后会按当前口播和提示词重跑，工作台上的预览会被新结果替换。
            </DialogDescription>
          </DialogHeader>
          <Button
            disabled={!activeShot || thisShotBusy}
            onClick={() => activeShot && void handleRenderShot(activeShot.id)}
          >
            <Play data-icon="inline-start" />
            确认重新生成
          </Button>
        </DialogContent>
      </Dialog>
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
