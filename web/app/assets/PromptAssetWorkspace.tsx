import { Image as ImageIcon, Loader2, RotateCcw, Save, Sparkles, Trash2, Upload, Video, ZoomIn, ZoomOut } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { AsyncState } from '@/components/layout/AsyncState'
import { SplitWorkspace } from '@/components/layout/SplitWorkspace'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  attachPromptGeneration,
  createPromptGeneration,
  creativeAssetUrl,
  deletePromptGeneration,
  listPromptGenerations,
  uploadCreativeAsset,
  type CreativeAsset,
  type CreativeAssetDirectory,
  type PromptGeneration,
  type PromptKind,
} from '@/lib/api/assets'

const UNCATEGORIZED_DIRECTORY = '__uncategorized__'

type PromptAssetWorkspaceProps = {
  assets: CreativeAsset[]
  directories: CreativeAssetDirectory[]
  selected: CreativeAsset | undefined
  isSaving?: boolean
  onSelect: (id: number) => void
  onChange: (asset: CreativeAsset) => void
  onSave: () => void
  onDelete: () => void
  onMediaAsset?: (asset: CreativeAsset) => void
}

export function promptListTitle(asset: Pick<CreativeAsset, 'title' | 'content'>) {
  const title = asset.title.trim()
  if (title) return title
  const firstLine = asset.content.split(/\r?\n/).find(line => line.trim())
  return firstLine?.trim().slice(0, 80) || '未命名提示词'
}

export function promptKindLabel(kind: PromptKind | '' | undefined) {
  if (kind === 'image') return '图片'
  if (kind === 'video') return '视频'
  return '其他'
}

function formatDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function statusLabel(status: PromptGeneration['status']) {
  if (status === 'queued') return '排队中'
  if (status === 'running') return '生成中'
  if (status === 'succeeded') return '已完成'
  return '失败'
}

export function PromptAssetWorkspace({
  assets,
  directories,
  selected,
  isSaving = false,
  onSelect,
  onChange,
  onSave,
  onDelete,
  onMediaAsset,
}: PromptAssetWorkspaceProps) {
  const [generations, setGenerations] = useState<PromptGeneration[]>([])
  const [loading, setLoading] = useState(false)
  const [busyAction, setBusyAction] = useState<'generate' | 'attach' | null>(null)
  const [error, setError] = useState('')
  const [previewImage, setPreviewImage] = useState<CreativeAsset | null>(null)
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const selectedId = selected?.id ?? null
  const kind: PromptKind = selected?.prompt_kind === 'image'
    || selected?.prompt_kind === 'video'
    || selected?.prompt_kind === 'other'
    ? selected.prompt_kind
    : 'other'

  const loadGenerations = useCallback(async () => {
    if (selectedId === null) {
      setGenerations([])
      return
    }
    setLoading(true)
    try {
      const items = await listPromptGenerations(selectedId)
      setGenerations(items)
      items.forEach(item => { if (item.media) onMediaAsset?.(item.media) })
      setError('')
    } catch {
      setError('加载生成历史失败，请重试。')
    } finally {
      setLoading(false)
    }
  }, [onMediaAsset, selectedId])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadGenerations() }, 0)
    return () => window.clearTimeout(timer)
  }, [loadGenerations])

  useEffect(() => {
    if (!generations.some(item => item.status === 'queued' || item.status === 'running')) return
    const timer = window.setInterval(() => { void loadGenerations() }, 2000)
    return () => window.clearInterval(timer)
  }, [generations, loadGenerations])

  async function generateImage() {
    if (!selected || kind !== 'image' || busyAction) return
    setBusyAction('generate')
    setError('')
    try {
      const generation = await createPromptGeneration(selected.id)
      setGenerations(items => [generation, ...items])
      if (generation.media) onMediaAsset?.(generation.media)
    } catch {
      setError('创建图片生成任务失败，请重试。')
    } finally {
      setBusyAction(null)
    }
  }

  async function attachFile(file: File | undefined) {
    if (!selected || (kind !== 'image' && kind !== 'video') || !file || busyAction) return
    setBusyAction('attach')
    setError('')
    try {
      const media = await uploadCreativeAsset(kind, file)
      const generation = await attachPromptGeneration(selected.id, media.id)
      setGenerations(items => [generation, ...items])
      onMediaAsset?.(media)
    } catch {
      setError(`补录${promptKindLabel(kind)}失败，请重试。`)
    } finally {
      setBusyAction(null)
      if (uploadInputRef.current) uploadInputRef.current.value = ''
    }
  }

  async function removeGeneration(generationId: number) {
    if (!selected || busyAction) return
    try {
      await deletePromptGeneration(selected.id, generationId)
      setGenerations(items => items.filter(item => item.id !== generationId))
    } catch {
      setError('删除生成记录失败，请重试。')
    }
  }

  function selectPrompt(id: number) {
    setPreviewImage(null)
    onSelect(id)
  }

  return (
    <>
      <SplitWorkspace
        editorLabel="提示词编辑器"
        listLabel="提示词列表"
        list={assets.length ? (
          <div className="divide-y divide-border">
            {assets.map(asset => (
              <button
                className={`relative block w-full px-4 py-3 text-left hover:bg-muted/70 ${selected?.id === asset.id ? 'bg-primary/10 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary' : ''}`}
                key={asset.id}
                onClick={() => selectPrompt(asset.id)}
                type="button"
              >
                <span className="block truncate text-sm font-medium">{promptListTitle(asset)}</span>
                <span className="mt-1 block text-[10px] text-muted-foreground">{promptKindLabel(asset.prompt_kind)}</span>
              </button>
            ))}
          </div>
        ) : <AsyncState description="新增提示词资产后会显示在这里。" title="当前目录没有提示词" variant="empty" />}
        editor={selected ? (
          <div className="flex h-full min-h-0 flex-col overflow-y-auto p-6">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                aria-label="提示词标题"
                className="min-w-[16rem] flex-1 border-0 bg-transparent px-0 text-lg font-semibold shadow-none dark:bg-transparent"
                onChange={event => onChange({ ...selected, title: event.target.value })}
                placeholder="提示词标题"
                value={selected.title}
              />
              <Button className="ml-auto" onClick={onDelete} size="sm" variant="destructive"><Trash2 />删除</Button>
              <Button disabled={isSaving} onClick={onSave} size="sm">{isSaving ? '保存中…' : <><Save />保存</>}</Button>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Select onValueChange={value => onChange({ ...selected, prompt_kind: value as PromptKind })} value={kind}>
                <SelectTrigger aria-label="提示词类型" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="image">图片提示词</SelectItem>
                  <SelectItem value="video">视频提示词</SelectItem>
                  <SelectItem value="other">其他提示词</SelectItem>
                </SelectContent>
              </Select>
              <Select onValueChange={value => onChange({ ...selected, directory: value === UNCATEGORIZED_DIRECTORY ? '' : value ?? '' })} value={selected.directory || UNCATEGORIZED_DIRECTORY}>
                <SelectTrigger aria-label="所属目录" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNCATEGORIZED_DIRECTORY}>未分类</SelectItem>
                  {directories.map(directory => <SelectItem key={directory.id} value={directory.name}>{directory.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Input aria-label="来源 URL" className="mt-3" onChange={event => onChange({ ...selected, url: event.target.value })} placeholder="来源 URL（可留空）" value={selected.url} />
            <div className="mt-4 rounded-lg border border-border bg-surface-muted/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                {kind === 'image' ? <Button disabled={busyAction !== null} onClick={() => void generateImage()} size="sm"><Sparkles />{busyAction === 'generate' ? '创建中…' : '生成图片'}</Button> : null}
                {kind === 'image' || kind === 'video' ? (
                  <>
                    <Button disabled={busyAction !== null} onClick={() => uploadInputRef.current?.click()} size="sm" variant="outline"><Upload />{busyAction === 'attach' ? '补录中…' : `补录${promptKindLabel(kind)}`}</Button>
                    <input accept={kind === 'image' ? 'image/*' : 'video/*'} className="hidden" onChange={event => void attachFile(event.target.files?.[0])} ref={uploadInputRef} type="file" />
                  </>
                ) : null}
                {kind === 'other' ? <span className="text-xs text-muted-foreground">其他提示词仅保存文本，不绑定生成媒体。</span> : null}
              </div>
            </div>
            <Textarea
              aria-label="提示词正文"
              className="mt-4 min-h-40 resize-y font-mono text-sm"
              onChange={event => onChange({ ...selected, content: event.target.value })}
              placeholder="输入完整提示词"
              value={selected.content}
            />
            {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
            <section aria-label="生成历史" className="mt-5 min-h-0">
              <div className="mb-3 flex items-center gap-2">
                <h3 className="text-sm font-semibold">生成历史</h3>
                {loading ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
                <span className="text-xs text-muted-foreground">最近记录</span>
              </div>
              {generations.length ? (
                <div className="space-y-3">
                  {generations.map(generation => (
                    <GenerationCard
                      generation={generation}
                      key={generation.id}
                      onDelete={() => void removeGeneration(generation.id)}
                      onPreview={setPreviewImage}
                      promptContent={selected.content}
                    />
                  ))}
                </div>
              ) : <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">还没有生成结果。</p>}
            </section>
          </div>
        ) : <AsyncState description="从左侧提示词列表选择一项开始编辑。" title="尚未选择提示词" variant="empty" />}
      />
      <ZoomableImagePreview key={previewImage?.id ?? 'none'} image={previewImage} onClose={() => setPreviewImage(null)} />
    </>
  )
}

function GenerationCard({
  generation,
  onDelete,
  onPreview,
  promptContent,
}: {
  generation: PromptGeneration
  onDelete: () => void
  onPreview: (image: CreativeAsset) => void
  promptContent: string
}) {
  return (
    <article className="grid gap-4 rounded-xl border border-border bg-surface p-3 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.9fr)]">
      <div className="min-w-0 rounded-lg border border-border/70 bg-surface-muted/30">
        <div className="border-b border-border/70 px-3 py-2 text-xs font-medium text-muted-foreground">当前提示词</div>
        <p className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-6">{promptContent || '提示词正文为空'}</p>
      </div>
      <div className="min-w-0 space-y-2">
        {generation.media?.media_kind === 'image' ? (
          <button
            aria-label={`预览图片 ${generation.media.title}`}
            className="flex min-h-56 w-full items-center justify-center rounded-lg bg-muted/40 p-2 hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onPreview(generation.media!)}
            type="button"
          >
            <img alt={generation.media.title} className="max-h-[28rem] max-w-full object-contain" src={creativeAssetUrl(generation.media.url)} />
          </button>
        ) : null}
        {generation.media?.media_kind === 'video' ? <div className="flex min-h-56 items-center justify-center rounded-lg bg-muted/40 p-2"><video className="max-h-[28rem] max-w-full object-contain" controls preload="metadata" src={creativeAssetUrl(generation.media.url)} /></div> : null}
        {!generation.media && (generation.status === 'queued' || generation.status === 'running') ? <div className="flex min-h-56 items-center justify-center gap-2 rounded-lg bg-muted text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />{statusLabel(generation.status)}</div> : null}
        {!generation.media && generation.status === 'failed' ? <div className="flex min-h-24 items-center justify-center rounded-lg bg-destructive/5 px-4 text-center text-xs text-destructive">{generation.error || '生成失败'}</div> : null}
        <div className="space-y-2 px-1 pt-1">
          <div className="flex items-center gap-2 text-xs">
            {generation.media?.media_kind === 'image' ? <ImageIcon className="size-3.5" /> : <Video className="size-3.5" />}
            <span className="font-medium">{statusLabel(generation.status)}</span>
            <span className="ml-auto text-muted-foreground">{formatDate(generation.generated_at || generation.created_at)}</span>
          </div>
          <p className="truncate text-[11px] text-muted-foreground">模型：{generation.model || '待确定'}</p>
          <Button aria-label={`删除生成记录 ${generation.id}`} onClick={onDelete} size="xs" variant="ghost"><Trash2 />删除记录</Button>
        </div>
      </div>
    </article>
  )
}

type Point = { x: number; y: number }

function ZoomableImagePreview({ image, onClose }: { image: CreativeAsset | null; onClose: () => void }) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 })
  const dragRef = useRef<{ pointer: Point; offset: Point } | null>(null)

  function setZoom(next: number) {
    const value = Math.min(4, Math.max(1, Number(next.toFixed(2))))
    setScale(value)
    if (value === 1) setOffset({ x: 0, y: 0 })
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    setZoom(scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2))
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (scale <= 1) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointer: { x: event.clientX, y: event.clientY },
      offset,
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return
    const start = dragRef.current
    setOffset({
      x: start.offset.x + event.clientX - start.pointer.x,
      y: start.offset.y + event.clientY - start.pointer.y,
    })
  }

  function stopDragging(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    dragRef.current = null
  }

  return (
    <Dialog open={image !== null} onOpenChange={open => { if (!open) onClose() }}>
      {image ? (
        <DialogContent className="max-h-[min(90vh,860px)] overflow-hidden" size="lg">
          <DialogHeader>
            <DialogTitle>{image.title || '图片预览'}</DialogTitle>
            <DialogDescription>滚轮缩放，放大后按住图片拖动查看。</DialogDescription>
          </DialogHeader>
          <div
            aria-label="图片预览区域"
            className={`flex h-[min(70vh,680px)] min-h-0 items-center justify-center overscroll-contain overflow-hidden rounded-lg bg-black/5 ${scale > 1 ? 'cursor-grab' : 'cursor-zoom-in'}`}
            onPointerCancel={stopDragging}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDragging}
            onWheel={handleWheel}
          >
            <img
              alt={image.title}
              className="max-h-full max-w-full select-none object-contain"
              data-scale={scale}
              draggable={false}
              src={creativeAssetUrl(image.url)}
              style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: 'center center' }}
            />
          </div>
          <div className="flex items-center justify-center gap-2">
            <Button aria-label="缩小" onClick={() => setZoom(scale / 1.2)} size="icon-sm" variant="outline"><ZoomOut /></Button>
            <Button aria-label="重置缩放" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }) }} size="sm" variant="outline"><RotateCcw />{Math.round(scale * 100)}%</Button>
            <Button aria-label="放大" onClick={() => setZoom(scale * 1.2)} size="icon-sm" variant="outline"><ZoomIn /></Button>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
