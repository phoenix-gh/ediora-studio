'use client'

import { useEffect, useState } from 'react'
import {
  Bird,
  Clock3,
  FolderInput,
  History,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { getSettings, type LLMAdapter } from '@/lib/api/settings'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  listCreativeAssetDirectories,
  type CreativeAssetDirectory,
} from '@/lib/api/assets'
import {
  type CreateXSubscriptionInput,
  type XSubscription,
  type XSubscriptionPatch,
} from '@/lib/api/x'

const X_COLLECTION_INTERVAL_OPTIONS = [5, 10, 15, 30, 60, 180, 360, 720, 1440] as const
const X_DIALOG_OPTION_CLASS = 'bg-surface text-foreground'

type DialogMode = 'create' | 'edit'

export type XSubscriptionDialogProps = {
  open: boolean
  mode: DialogMode
  subscription: XSubscription | null
  onOpenChange: (open: boolean) => void
  onAdd: (input: CreateXSubscriptionInput) => Promise<void>
  onSave: (id: number, body: XSubscriptionPatch) => Promise<void>
  onDelete: (subscription: XSubscription) => Promise<void>
  onCollect: (subscription: XSubscription) => Promise<void>
  onBackfill: (subscription: XSubscription, days: number) => Promise<void>
  onIngestExisting: (subscription: XSubscription, days: number) => Promise<void>
}

const sinceDays = (days: number) =>
  new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)

const QUICK_TOKENS: { label: string; token: string | (() => string) }[] = [
  { label: 'OR 组', token: '(关键词A OR 关键词B)' },
  { label: '排除回复', token: '-filter:replies' },
  { label: '只看回复', token: 'filter:replies' },
  { label: '排除链接', token: '-filter:links' },
  { label: '排除转推', token: '-filter:retweets' },
  { label: '高赞', token: 'min_faves:1500' },
  { label: '中文', token: 'lang:zh' },
  { label: '近7天', token: () => `since:${sinceDays(7)}` },
]

const directoryIsReady = (directory: CreativeAssetDirectory) =>
  (directory.asset_type === 'article' || directory.asset_type === 'prompt')
  && directory.ai_ingestion_enabled
  && directory.ai_ingestion_prompt.trim().length > 0

export function XSubscriptionDialog({
  open,
  mode,
  subscription,
  onOpenChange,
  onAdd,
  onSave,
  onDelete,
  onCollect,
  onBackfill,
  onIngestExisting,
}: XSubscriptionDialogProps) {
  const editing = mode === 'edit' && subscription !== null
  const [kind, setKind] = useState<'timeline' | 'search'>(subscription?.kind ?? 'timeline')
  const [name, setName] = useState(subscription?.label ?? '')
  const [url, setUrl] = useState(subscription?.url ?? '')
  const [rawQuery, setRawQuery] = useState(subscription?.raw_query ?? '')
  const [maxResults, setMaxResults] = useState(subscription?.max_results ?? 50)
  const [enabled, setEnabled] = useState(subscription?.enabled ?? true)
  const [collectInterval, setCollectInterval] = useState(subscription?.collect_interval_minutes ?? 15)
  const [intelligenceEnabled, setIntelligenceEnabled] = useState(subscription?.intelligence_enabled ?? false)
  const [saving, setSaving] = useState(false)
  const [collecting, setCollecting] = useState(false)
  const [backfillDays, setBackfillDays] = useState('7')
  const [backfilling, setBackfilling] = useState(false)
  const [backfillError, setBackfillError] = useState('')
  const [ingestionBackfillDays, setIngestionBackfillDays] = useState('7')
  const [ingestionBackfilling, setIngestionBackfilling] = useState(false)
  const [ingestionBackfillError, setIngestionBackfillError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [ingestionDirectories, setIngestionDirectories] = useState<CreativeAssetDirectory[]>([])
  const [selectedDirectoryIds, setSelectedDirectoryIds] = useState<number[]>(subscription?.ingestion_directory_ids ?? [])
  const [informationFilteringAdapters, setInformationFilteringAdapters] = useState<LLMAdapter[]>([])
  const [informationFilteringAdapterId, setInformationFilteringAdapterId] = useState(
    subscription?.llm_adapter_id ?? '',
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const directoriesRequest = Promise.all([
      Promise.resolve(listCreativeAssetDirectories('article')),
      Promise.resolve(listCreativeAssetDirectories('prompt')),
    ]).then(groups => groups.flatMap(group => Array.isArray(group) ? group : []))
      .catch(() => null)
    const settingsRequest = Promise.resolve(getSettings()).catch(() => null)
    void Promise.all([directoriesRequest, settingsRequest]).then(([directories, settings]) => {
      if (cancelled) return
      if (directories === null) {
        toast.error('加载订阅素材入库配置失败')
      } else {
        const nextDirectories = Array.from(new Map(
          directories.map(directory => [directory.id, directory]),
        ).values())
        setIngestionDirectories(nextDirectories)
        const readyIds = new Set(nextDirectories.filter(directoryIsReady).map(directory => directory.id))
        setSelectedDirectoryIds((subscription?.ingestion_directory_ids ?? []).filter(id => readyIds.has(id)))
      }
      const textAdapters = (settings?.llm_adapters ?? []).filter(adapter => adapter.supports_text)
      setInformationFilteringAdapters(textAdapters)
      setInformationFilteringAdapterId(subscription?.llm_adapter_id ?? '')
    })
    return () => { cancelled = true }
  }, [open, subscription])

  const toggleDirectory = (directoryId: number, checked: boolean) => {
    setSelectedDirectoryIds(current => checked
      ? current.includes(directoryId) ? current : [...current, directoryId]
      : current.filter(id => id !== directoryId))
  }

  const frequencyOptions = Array.from(new Set([
    ...X_COLLECTION_INTERVAL_OPTIONS,
    collectInterval,
  ])).sort((a, b) => a - b)

  const insertToken = (token: string) => {
    setRawQuery(previous => `${previous.trim() ? `${previous.trim()} ` : ''}${token} `)
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      if (!editing) {
        if (kind === 'timeline') {
          const nextUrl = url.trim()
          if (!nextUrl) return
          await onAdd({
            kind: 'timeline',
            url: nextUrl,
            label: name.trim() || undefined,
            llm_adapter_id: informationFilteringAdapterId || null,
            ingestion_directory_ids: selectedDirectoryIds,
          })
        } else {
          const query = rawQuery.trim()
          if (!query) return
          await onAdd({
            kind: 'search',
            raw_query: query,
            max_results: maxResults,
            label: name.trim() || undefined,
            llm_adapter_id: informationFilteringAdapterId || null,
            ingestion_directory_ids: selectedDirectoryIds,
          })
        }
        onOpenChange(false)
        return
      }

      const body: XSubscriptionPatch = {
        enabled,
        label: name.trim() || subscription.label,
        collect_interval_minutes: collectInterval,
        intelligence_enabled: intelligenceEnabled,
        llm_adapter_id: informationFilteringAdapterId || null,
        ingestion_directory_ids: selectedDirectoryIds,
      }
      if (kind === 'search') {
        const query = rawQuery.trim()
        if (!query) return
        body.raw_query = query
        body.max_results = maxResults
      }
      await onSave(subscription.id, body)
      onOpenChange(false)
    } catch (error) {
      toast.error((error as Error).message || '保存失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const collect = async () => {
    if (!subscription || collecting) return
    setCollecting(true)
    try {
      await onCollect(subscription)
    } catch (error) {
      toast.error((error as Error).message || '采集失败')
    } finally {
      setCollecting(false)
    }
  }

  const backfill = async () => {
    if (!subscription || backfilling) return
    const days = Number(backfillDays)
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      setBackfillError('请输入 1–90 的整数天数')
      return
    }
    setBackfilling(true)
    setBackfillError('')
    try {
      await onBackfill(subscription, days)
    } catch (error) {
      setBackfillError((error as Error).message || '回溯采集失败，请重试')
    } finally {
      setBackfilling(false)
    }
  }

  const ingestExisting = async () => {
    if (!subscription || ingestionBackfilling) return
    const days = Number(ingestionBackfillDays)
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      setIngestionBackfillError('请输入 1–90 的整数天数')
      return
    }
    setIngestionBackfilling(true)
    setIngestionBackfillError('')
    try {
      await onIngestExisting(subscription, days)
    } catch (error) {
      setIngestionBackfillError((error as Error).message || '补处理失败，请重试')
    } finally {
      setIngestionBackfilling(false)
    }
  }

  const confirmDelete = async () => {
    if (!subscription || deleting) return
    setDeleting(true)
    try {
      await onDelete(subscription)
      onOpenChange(false)
    } catch (error) {
      toast.error((error as Error).message || '删除失败，请重试')
      setDeleting(false)
    }
  }

  const title = editing ? `编辑 X 订阅 · ${subscription.label}` : '新增 X 订阅'

  return (
    <Dialog open={open} onOpenChange={value => { if (!saving && !deleting) onOpenChange(value) }}>
      <DialogContent size="md" className="max-h-[min(86vh,820px)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {editing
              ? '只修改当前订阅的采集、分析和素材入库设置。'
              : '添加时间线或搜索订阅；新帖子会按订阅设置定时落库。'}
          </DialogDescription>
        </DialogHeader>

        {!editing && (
          <div className="flex items-center gap-1.5">
            <Button type="button" size="sm" variant={kind === 'timeline' ? 'default' : 'outline'} onClick={() => setKind('timeline')}>
              时间线
            </Button>
            <Button type="button" size="sm" variant={kind === 'search' ? 'default' : 'outline'} onClick={() => setKind('search')}>
              搜索
            </Button>
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <section className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <Bird className="size-4 text-sky-500" />
              基础信息
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium" htmlFor="x-subscription-name">名称</label>
              <Input id="x-subscription-name" value={name} onChange={event => setName(event.target.value)} placeholder="名称（可选，留空自动命名）" />
            </div>
            {kind === 'timeline' ? (
              <div className="space-y-1.5">
                <label className="text-xs font-medium" htmlFor="x-subscription-url">时间线 URL</label>
                <Input id="x-subscription-url" readOnly={editing} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://x.com/elonmusk 或 https://x.com/i/lists/12345" />
                {editing ? <p className="text-[11px] text-muted-foreground">已有订阅的 URL 暂不支持修改。</p> : null}
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-xs font-medium" htmlFor="x-subscription-query">X 搜索语句</label>
                <Textarea id="x-subscription-query" value={rawQuery} onChange={event => setRawQuery(event.target.value)} rows={3} spellCheck={false} placeholder="如：(AI OR 大模型) min_faves:1500 lang:zh -filter:replies" />
                <div className="flex flex-wrap gap-1">
                  {QUICK_TOKENS.map(item => (
                    <button type="button" key={item.label} onClick={() => insertToken(typeof item.token === 'function' ? item.token() : item.token)} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-sky-400 hover:text-sky-500">
                      + {item.label}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground" htmlFor="x-subscription-max-results">
                  条数上限
                  <Input id="x-subscription-max-results" type="number" min={1} max={500} value={maxResults} onChange={event => setMaxResults(Number(event.target.value) || 1)} className="h-8 w-24" />
                </label>
              </div>
            )}
            {editing ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-xs" htmlFor="x-subscription-enabled">
                  <span>启用订阅</span>
                  <Switch id="x-subscription-enabled" checked={enabled} onCheckedChange={setEnabled} />
                </label>
                <label className="space-y-1.5 text-xs" htmlFor="x-collection-interval">
                  <span className="flex items-center gap-1.5 font-medium"><Clock3 className="size-3.5" />采集频率</span>
                  <NativeSelect id="x-collection-interval" aria-label="采集频率" value={collectInterval} onChange={event => setCollectInterval(Number(event.target.value))} className="rounded-md px-2 text-sm">
                    {frequencyOptions.map(minutes => <option className={X_DIALOG_OPTION_CLASS} key={minutes} value={minutes}>{minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`}</option>)}
                  </NativeSelect>
                </label>
              </div>
            ) : null}
          </section>

          {editing && subscription ? (
            <section className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Sparkles className="size-4 text-amber-500" />
                情报分析
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-xs" htmlFor="x-subscription-intelligence">
                <span>
                  <span className="block font-medium">启用情报分析</span>
                  <span className="mt-0.5 block text-muted-foreground">开启后，新采集帖子会进入情报中心进行价值分析。</span>
                </span>
                <Switch id="x-subscription-intelligence" checked={intelligenceEnabled} onCheckedChange={setIntelligenceEnabled} />
              </label>
            </section>
          ) : null}

          <section className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
              <FolderInput className="size-4 text-emerald-500" />
              AI 素材入库
            </div>
            <p className="text-[11px] text-muted-foreground">可选择多个文章或提示词文件夹；每个文件夹的 AI 入库规则会一起交给 AI，由 AI 为每条帖子选择文章归属，并提取可复用提示词。</p>
            {ingestionDirectories.length === 0 ? (
              <p className="text-xs text-amber-600">请先在创作资产中创建文章或提示词文件夹，并配置 AI 入库规则。</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {ingestionDirectories.map(item => {
                  const ready = directoryIsReady(item)
                  const checked = selectedDirectoryIds.includes(item.id)
                  return (
                    <label
                      key={item.id}
                      className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-xs transition-colors ${ready ? 'cursor-pointer hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20' : 'cursor-not-allowed opacity-55'} ${checked ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30' : 'border-border'}`}
                    >
                      <Checkbox
                        aria-label={item.name}
                        checked={checked}
                        disabled={!ready}
                        onCheckedChange={value => toggleDirectory(item.id, value === true)}
                      />
                      <span className="min-w-0 space-y-1">
                        <span className="block truncate font-medium text-foreground">{item.name}<span className="ml-1 text-[10px] font-normal text-muted-foreground">{item.asset_type === 'prompt' ? '提示词' : '文章'}</span></span>
                        {ready ? (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {item.ai_ingestion_keywords.length > 0 ? `关键词：${item.ai_ingestion_keywords.join('、')}` : '已配置 AI 入库规则'}
                          </span>
                        ) : (
                          <span className="block text-[11px] text-amber-600">请先在创作资产中配置 AI 入库规则</span>
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">不选择文件夹则不执行素材入库；文章和提示词各自最多落入一个文件夹，提示词正文必须来自原帖。</p>
            {informationFilteringAdapters.length > 0 ? (
              <label className="block space-y-1.5 text-xs" htmlFor="x-subscription-llm-adapter">
                <span className="font-medium">信息筛选 Adapter</span>
                <NativeSelect
                  id="x-subscription-llm-adapter"
                  aria-label="信息筛选 Adapter"
                  value={informationFilteringAdapterId}
                  onChange={event => setInformationFilteringAdapterId(event.target.value)}
                  className="rounded-md px-2 text-sm"
                >
                  <option className={X_DIALOG_OPTION_CLASS} value="">跟随信息筛选设置</option>
                  {informationFilteringAdapters.map(adapter => (
                    <option className={X_DIALOG_OPTION_CLASS} key={adapter.id} value={adapter.id}>
                      {adapter.name} · {adapter.model}
                    </option>
                  ))}
                </NativeSelect>
                <span className="block text-[11px] text-muted-foreground">不选择时使用设置中的“信息筛选 Adapter”，未设置时回退到文字默认 Adapter。</span>
              </label>
            ) : null}
          </section>

          {editing && subscription ? (
            <>
              <section className="space-y-3 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                  <RefreshCw className="size-4 text-sky-500" />
                  采集操作
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={collecting} onClick={() => void collect()}>
                    {collecting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    {collecting ? '采集中…' : '立即采集'}
                  </Button>
                  {subscription.kind === 'timeline' ? (
                    <>
                      <label className="space-y-1 text-[11px] text-muted-foreground" htmlFor="x-backfill-days">
                        回溯天数
                        <Input id="x-backfill-days" type="number" min={1} max={90} value={backfillDays} onChange={event => { setBackfillDays(event.target.value); setBackfillError('') }} className="h-8 w-20" />
                      </label>
                      <Button type="button" size="sm" variant="outline" disabled={backfilling} onClick={() => void backfill()}>
                        {backfilling ? <Loader2 className="animate-spin" /> : <History />}
                        {backfilling ? '采集中…' : '回溯采集'}
                      </Button>
                    </>
                  ) : null}
                </div>
                {backfillError ? <p role="alert" className="text-xs text-destructive">{backfillError}</p> : null}
                <div className="space-y-2 rounded-md bg-muted/40 p-2.5">
                  <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                    <FolderInput className="size-3.5 text-emerald-500" />
                    补处理已有帖子
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    不重新采集 X，只处理本地已保存的帖子；已有素材入库决策的帖子会自动跳过。
                  </p>
                  <div className="flex flex-wrap items-end gap-2">
                    <label className="space-y-1 text-[11px] text-muted-foreground" htmlFor="x-ingestion-backfill-days">
                      补处理天数
                      <Input
                        id="x-ingestion-backfill-days"
                        aria-label="补处理天数"
                        type="number"
                        min={1}
                        max={90}
                        value={ingestionBackfillDays}
                        onChange={event => {
                          setIngestionBackfillDays(event.target.value)
                          setIngestionBackfillError('')
                        }}
                        className="h-8 w-20"
                      />
                    </label>
                    <Button type="button" size="sm" variant="outline" disabled={ingestionBackfilling} onClick={() => void ingestExisting()}>
                      {ingestionBackfilling ? <Loader2 className="animate-spin" /> : <FolderInput />}
                      {ingestionBackfilling ? '补处理中…' : '补处理已有帖子'}
                    </Button>
                  </div>
                  {ingestionBackfillError ? <p role="alert" className="text-xs text-destructive">{ingestionBackfillError}</p> : null}
                </div>
              </section>

              <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-destructive"><Trash2 className="size-4" />危险区</div>
                {!deleteConfirm ? (
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p className="text-[11px] text-muted-foreground">删除后该订阅及其关联帖子将被清除。</p>
                    <Button type="button" size="sm" variant="destructive" onClick={() => setDeleteConfirm(true)}>删除订阅</Button>
                  </div>
                ) : (
                  <div className="mt-2 space-y-2 rounded-md border border-destructive/30 bg-background p-2.5">
                    <p className="text-xs text-destructive">删除后关联帖子也会被清除，确定继续吗？</p>
                    <div className="flex justify-end gap-2">
                      <Button type="button" size="sm" variant="outline" disabled={deleting} onClick={() => setDeleteConfirm(false)}>取消</Button>
                      <Button type="button" size="sm" variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
                        {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                        {deleting ? '删除中…' : '确认删除'}
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            </>
          ) : null}

          {!editing ? (
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button type="submit" disabled={saving || (kind === 'timeline' ? !url.trim() : !rawQuery.trim())}>
                {saving ? <Loader2 className="animate-spin" /> : null}
                {saving ? '保存中…' : kind === 'timeline' ? '添加时间线订阅' : '添加搜索订阅'}
              </Button>
            </DialogFooter>
          ) : (
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button type="submit" disabled={saving}>
                {saving ? <Loader2 className="animate-spin" /> : null}
                {saving ? '保存中…' : '保存订阅'}
              </Button>
            </DialogFooter>
          )}
        </form>
      </DialogContent>
    </Dialog>
  )
}
