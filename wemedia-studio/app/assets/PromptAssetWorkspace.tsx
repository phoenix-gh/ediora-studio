import { Image as ImageIcon, Loader2, Save, Sparkles, Trash2, Upload, Video } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { AsyncState } from '@/components/layout/AsyncState'
import { SplitWorkspace } from '@/components/layout/SplitWorkspace'
import { Button } from '@/components/ui/button'
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

  useEffect(() => { void loadGenerations() }, [loadGenerations])

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

  return (
    <SplitWorkspace
      editorLabel="提示词编辑器"
      listLabel="提示词列表"
      list={assets.length ? (
        <div className="divide-y divide-border">
          {assets.map(asset => (
            <button
              className={`relative block w-full px-4 py-3 text-left hover:bg-muted/70 ${selected?.id === asset.id ? 'bg-primary/10 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-primary' : ''}`}
              key={asset.id}
              onClick={() => onSelect(asset.id)}
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
              <div className="grid gap-3 md:grid-cols-2">
                {generations.map(generation => (
                  <GenerationCard generation={generation} key={generation.id} onDelete={() => void removeGeneration(generation.id)} />
                ))}
              </div>
            ) : <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">还没有生成结果。</p>}
          </section>
        </div>
      ) : <AsyncState description="从左侧提示词列表选择一项开始编辑。" title="尚未选择提示词" variant="empty" />}
    />
  )
}

function GenerationCard({ generation, onDelete }: { generation: PromptGeneration; onDelete: () => void }) {
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-surface">
      {generation.media?.media_kind === 'image' ? <img alt={generation.media.title} className="aspect-video w-full object-cover" src={creativeAssetUrl(generation.media.url)} /> : null}
      {generation.media?.media_kind === 'video' ? <video className="aspect-video w-full object-cover" controls preload="metadata" src={creativeAssetUrl(generation.media.url)} /> : null}
      {!generation.media && (generation.status === 'queued' || generation.status === 'running') ? <div className="flex aspect-video items-center justify-center gap-2 bg-muted text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />{statusLabel(generation.status)}</div> : null}
      {!generation.media && generation.status === 'failed' ? <div className="flex min-h-24 items-center justify-center bg-destructive/5 px-4 text-center text-xs text-destructive">{generation.error || '生成失败'}</div> : null}
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2 text-xs">
          {generation.media?.media_kind === 'image' ? <ImageIcon className="size-3.5" /> : <Video className="size-3.5" />}
          <span className="font-medium">{statusLabel(generation.status)}</span>
          <span className="ml-auto text-muted-foreground">{formatDate(generation.generated_at || generation.created_at)}</span>
        </div>
        <p className="truncate text-[11px] text-muted-foreground">模型：{generation.model || '待确定'}</p>
        <Button aria-label={`删除生成记录 ${generation.id}`} onClick={onDelete} size="xs" variant="ghost"><Trash2 />删除记录</Button>
      </div>
    </article>
  )
}
