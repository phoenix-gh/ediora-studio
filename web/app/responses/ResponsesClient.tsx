'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AtSign, ExternalLink, PlaySquare, RotateCcw, Search, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  contentTypeLabels,
  createResponseDestination,
  createResponseOutputs,
  decideResponse,
  dispositionLabels,
  getResponse,
  getResponseEvents,
  getResponses,
  responseOutputLabels,
  updateResponseClassification,
  type ContentType,
  type ResponseDetail,
  type ResponseDisposition,
  type ResponseItem,
  type ResponseOutput,
  type ResponseOutputType,
} from '@/lib/api/responses'
import { listCreativeAssetDirectories } from '@/lib/api/assets'
import { cn } from '@/lib/utils'
import { ResponseDestinationDialog, type DestinationKind } from './ResponseDestinationDialog'
import { ResponseEvaluationPane } from './ResponseEvaluationPane'
import { ResponseSourcePane } from './ResponseSourcePane'
import { ResponseWritingDialog } from './ResponseWritingDialog'

const statuses: Array<{ value: ResponseDisposition | ''; label: string }> = [
  { value: 'pending', label: '待判断' },
  { value: 'worth_writing', label: '值得写' },
  { value: 'creative_asset', label: '创作资产' },
  { value: 'not_processed', label: '暂不处理' },
  { value: '', label: '全部' },
]

const sources = [
  { value: '', label: '全部来源' },
  { value: 'x_post', label: 'X' },
  { value: 'youtube_video', label: 'YouTube' },
]

const timeRanges = [
  { value: 1, label: '1天内' },
  { value: 3, label: '3天内' },
  { value: 7, label: '7天内' },
  { value: 30, label: '30天内' },
  { value: 90, label: '90天内' },
  { value: 0, label: '不限' },
]

const draftWritingOutputTypes: ResponseOutputType[] = [
  'expanded_article',
  'commentary',
  'x_short_post',
  'x_article',
  'wechat_article',
]

function formatDate(value: string | null) {
  if (!value) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable
    || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
    || Boolean(target.closest('[contenteditable="true"]'))
  )
}

export function ResponsesClient({
  initialItems,
  initialTotal,
  initialSelectedId,
  initialSource,
}: {
  initialItems: ResponseItem[]
  initialTotal: number
  initialSelectedId: number | null
  initialSource: string
}) {
  const [items, setItems] = useState(initialItems)
  const [total, setTotal] = useState(initialTotal)
  const [selectedId, setSelectedId] = useState<number | null>(initialSelectedId ?? initialItems[0]?.id ?? null)
  const [detail, setDetail] = useState<ResponseDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(selectedId !== null)
  const [detailError, setDetailError] = useState('')
  const [status, setStatus] = useState<ResponseDisposition | ''>('pending')
  const [sourceFilter, setSourceFilter] = useState(initialSource)
  const [contentType, setContentType] = useState<ContentType | ''>('')
  const [days, setDays] = useState(3)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'score' | 'newest'>('score')
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [classificationBusy, setClassificationBusy] = useState(false)
  const [destination, setDestination] = useState<DestinationKind | null>(null)
  const [directories, setDirectories] = useState<string[]>([])
  const [destinationBusy, setDestinationBusy] = useState(false)
  const [destinationError, setDestinationError] = useState('')
  const [writingOpen, setWritingOpen] = useState(false)
  const [writingError, setWritingError] = useState('')
  const [events, setEvents] = useState<Array<{ id: number; event_type: string; created_at: string }>>([])

  const selectedIdRef = useRef(selectedId)
  const detailRequestGeneration = useRef(0)
  const destinationSessionRef = useRef(0)
  const destinationBusyRef = useRef(false)
  const itemsRef = useRef(items)
  const listEndRef = useRef<HTMLDivElement | null>(null)
  const listScrollRef = useRef<HTMLDivElement | null>(null)
  const listPageRef = useRef(1)
  const listRequestGeneration = useRef(0)
  const loadingMoreRef = useRef(false)

  const selectResponse = useCallback((nextId: number | null) => {
    if (nextId === selectedIdRef.current) return

    selectedIdRef.current = nextId
    detailRequestGeneration.current += 1
    setSelectedId(nextId)
    setDetail(null)
    setDetailError('')
    setEvents([])
    setDetailLoading(nextId !== null)
  }, [])

  const loadList = useCallback(async (options: { preserveSelectedId?: number } = {}) => {
    const generation = ++listRequestGeneration.current
    listPageRef.current = 1
    loadingMoreRef.current = false
    setLoading(true)
    setLoadingMore(false)
    try {
      const result = await getResponses({
        source_type: sourceFilter,
        decision_status: status,
        content_type: contentType,
        days,
        search,
        sort,
        page: 1,
      })
      if (generation !== listRequestGeneration.current) return
      itemsRef.current = result.items
      setItems(result.items)
      setTotal(result.total)
      const current = selectedIdRef.current
      const next = current && (
        result.items.some(item => item.id === current)
        || options.preserveSelectedId === current
      )
        ? current
        : result.items[0]?.id ?? null
      if (next !== current) selectResponse(next)
    } catch (error) {
      if (generation === listRequestGeneration.current) {
        toast.error(error instanceof Error ? error.message : '情报中心加载失败')
      }
    } finally {
      if (generation === listRequestGeneration.current) setLoading(false)
    }
  }, [contentType, days, search, selectResponse, sort, sourceFilter, status])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadList() }, 220)
    return () => window.clearTimeout(timer)
  }, [loadList])

  const loadMore = useCallback(async () => {
    if (loading || loadingMoreRef.current || itemsRef.current.length >= total) return
    const generation = listRequestGeneration.current
    const nextPage = listPageRef.current + 1
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const result = await getResponses({
        source_type: sourceFilter,
        decision_status: status,
        content_type: contentType,
        days,
        search,
        sort,
        page: nextPage,
      })
      if (generation !== listRequestGeneration.current) return
      const existingIds = new Set(itemsRef.current.map(item => item.id))
      const nextItems = result.items.filter(item => !existingIds.has(item.id))
      itemsRef.current = [...itemsRef.current, ...nextItems]
      setItems(itemsRef.current)
      setTotal(result.total)
      listPageRef.current = nextPage
    } catch (error) {
      if (generation === listRequestGeneration.current) {
        toast.error(error instanceof Error ? error.message : '加载更多情报失败')
      }
    } finally {
      loadingMoreRef.current = false
      if (generation === listRequestGeneration.current) setLoadingMore(false)
    }
  }, [contentType, days, loading, search, sort, sourceFilter, status, total])

  useEffect(() => {
    const sentinel = listEndRef.current
    if (!sentinel || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) void loadMore()
    }, { root: listScrollRef.current, rootMargin: '160px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMore])

  useEffect(() => {
    if (selectedId === null) return
    const requestedId = selectedId
    const generation = ++detailRequestGeneration.current
    void getResponse(requestedId).then(next => {
      if (generation !== detailRequestGeneration.current || selectedIdRef.current !== requestedId) return
      setDetail(next)
      setDetailError('')
      setEvents([])
    }).catch(error => {
      if (generation !== detailRequestGeneration.current || selectedIdRef.current !== requestedId) return
      setDetailError(error instanceof Error ? error.message : '详情加载失败')
    }).finally(() => {
      if (generation === detailRequestGeneration.current) setDetailLoading(false)
    })
    return () => {
      if (generation === detailRequestGeneration.current) detailRequestGeneration.current += 1
    }
  }, [selectedId])

  const selected = useMemo(
    () => items.find(item => item.id === selectedId) ?? (detail?.id === selectedId ? detail : null),
    [detail, items, selectedId],
  )

  const refreshDetail = useCallback(async (responseId: number, generation: number) => {
    const next = await getResponse(responseId)
    if (detailRequestGeneration.current === generation && selectedIdRef.current === responseId) {
      setDetail(next)
    }
  }, [])

  async function updateClassification(next: ContentType[]) {
    if (!detail || selectedIdRef.current !== detail.id || classificationBusy) return
    const responseId = detail.id
    const generation = detailRequestGeneration.current
    setClassificationBusy(true)
    try {
      const updated = await updateResponseClassification(responseId, next)
      if (generation === detailRequestGeneration.current && selectedIdRef.current === responseId) {
        setDetail(current => current ? { ...current, ...updated } : current)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '分类保存失败')
    } finally {
      setClassificationBusy(false)
    }
  }

  const changeDecision = useCallback(async (action: 'not_processed' | 'reset') => {
    if (!detail || selectedIdRef.current !== detail.id || detailLoading) return
    const responseId = detail.id
    const generation = detailRequestGeneration.current
    try {
      await decideResponse(responseId, action)
      await refreshDetail(responseId, generation)
      await loadList()
      toast.success(action === 'reset' ? '已恢复到待判断' : '已移入暂不处理')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '状态保存失败')
    }
  }, [detail, detailLoading, loadList, refreshDetail])

  const openDestination = useCallback(async (nextDestination: DestinationKind) => {
    if (!detail?.analysis || detail.current_analysis_run_id === null || destinationBusyRef.current) return
    setDestinationError('')
    setDestination(nextDestination)
    try {
      const result = await listCreativeAssetDirectories('article')
      if (selectedIdRef.current === detail.id) setDirectories(result.map(item => item.name))
    } catch (error) {
      setDestinationError(error instanceof Error ? error.message : '目录加载失败')
    }
  }, [detail])

  const openWritingDialog = useCallback(() => {
    if (
      !detail?.analysis
      || detail.current_analysis_run_id === null
      || selectedIdRef.current !== detail.id
      || detailLoading
      || destinationBusyRef.current
    ) return
    setWritingError('')
    setWritingOpen(true)
  }, [detail, detailLoading])

  const submitWritingTargets = useCallback(async (outputTypes: ResponseOutputType[]) => {
    if (
      outputTypes.length === 0
      || !detail?.analysis
      || detail.current_analysis_run_id === null
      || selectedIdRef.current !== detail.id
      || detailLoading
      || destinationBusyRef.current
    ) return
    const responseId = detail.id
    const generation = detailRequestGeneration.current
    const session = ++destinationSessionRef.current
    destinationBusyRef.current = true
    setDestinationBusy(true)
    setWritingError('')
    try {
      const result = await createResponseOutputs(responseId, {
        analysis_run_id: detail.current_analysis_run_id,
        output_types: [...new Set(outputTypes)],
      })
      if (session !== destinationSessionRef.current || selectedIdRef.current !== responseId) return
      setWritingOpen(false)
      await refreshDetail(responseId, generation)
      await loadList({ preserveSelectedId: responseId })
      const created = result.outputs.some(output => output.created)
      toast.success(created ? '写作任务已启动' : '写作任务已在队列中')
    } catch (error) {
      if (session === destinationSessionRef.current) {
        setWritingError(error instanceof Error ? error.message : '写作任务启动失败')
      }
    } finally {
      if (session === destinationSessionRef.current) {
        destinationBusyRef.current = false
        setDestinationBusy(false)
      }
    }
  }, [detail, detailLoading, loadList, refreshDetail])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        event.repeat
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.shiftKey
        || destination !== null
        || writingOpen
        || destinationBusy
        || detailLoading
        || !detail
        || detail.decision_status !== 'pending'
        || isEditableTarget(event.target)
      ) return

      if (event.key === '1' && detail.analysis) {
        event.preventDefault()
        openWritingDialog()
      } else if (event.key === '2' && detail.analysis) {
        event.preventDefault()
        void openDestination('creative_asset')
      } else if (event.key === '3') {
        event.preventDefault()
        void changeDecision('not_processed')
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [changeDecision, destination, destinationBusy, detail, detailLoading, openDestination, openWritingDialog, writingOpen])

  async function submitDestination(value: { destination: DestinationKind; analysis_run_id: number; directory: string | null }) {
    if (!detail || detail.id !== selectedIdRef.current || destinationBusyRef.current) return
    const responseId = detail.id
    const generation = detailRequestGeneration.current
    const session = ++destinationSessionRef.current
    destinationBusyRef.current = true
    setDestinationBusy(true)
    setDestinationError('')
    try {
      await createResponseDestination(responseId, value)
      if (session !== destinationSessionRef.current || selectedIdRef.current !== responseId) return
      await refreshDetail(responseId, generation)
      await loadList()
      setDestination(null)
      toast.success('已保存创作资产')
    } catch (error) {
      if (session === destinationSessionRef.current) setDestinationError(error instanceof Error ? error.message : '保存失败')
    } finally {
      if (session === destinationSessionRef.current) {
        destinationBusyRef.current = false
        setDestinationBusy(false)
      }
    }
  }

  async function loadHistory() {
    if (!detail || events.length) return
    try {
      const result = await getResponseEvents(detail.id)
      if (selectedIdRef.current === detail.id) setEvents(result.items)
    } catch {
      // History is supplemental; the source and evaluation remain usable.
    }
  }

  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <header data-slot="page-header" className="flex h-[var(--app-header-height)] min-h-[var(--app-header-height)] shrink-0 items-center justify-between border-b border-border bg-card px-5 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">情报中心</h1>
          <p className="truncate text-xs text-muted-foreground">先看原文，再判断它是否值得进入内容系统</p>
        </div>
        <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
          <span className="size-2 rounded-full bg-emerald-500" /> {total} 条内容
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="shrink-0 border-b border-border bg-card p-4 lg:w-52 lg:border-b-0 lg:border-r lg:overflow-y-auto">
          <div className="mb-4 flex items-center gap-2 text-xs font-semibold text-muted-foreground"><SlidersHorizontal className="size-3.5" />筛选</div>
          <FilterGroup title="状态">
            {statuses.map(option => <FilterButton key={option.value} active={status === option.value} onClick={() => setStatus(option.value)}>{option.label}</FilterButton>)}
          </FilterGroup>
          <FilterGroup title="来源">
            {sources.map(option => <FilterButton key={option.value} active={sourceFilter === option.value} onClick={() => setSourceFilter(option.value)}>{option.label}</FilterButton>)}
          </FilterGroup>
          <FilterGroup title="时间">
            {timeRanges.map(option => <FilterButton key={option.value} active={days === option.value} onClick={() => setDays(option.value)}>{option.label}</FilterButton>)}
          </FilterGroup>
          <FilterGroup title="内容类型">
            <FilterButton active={contentType === ''} onClick={() => setContentType('')}>全部类型</FilterButton>
            {Object.entries(contentTypeLabels).map(([value, label]) => (
              <FilterButton key={value} active={contentType === value} onClick={() => setContentType(value as ContentType)}>
                {label}
              </FilterButton>
            ))}
          </FilterGroup>
          <FilterGroup title="排序">
            <div className="flex rounded-lg border border-border p-0.5">
              {(['score', 'newest'] as const).map(value => <button key={value} type="button" onClick={() => setSort(value)} className={cn('flex-1 rounded-md px-2 py-1.5 text-xs', sort === value && 'bg-muted font-medium')}>{value === 'score' ? '价值评分' : '最新'}</button>)}
            </div>
          </FilterGroup>
        </aside>

        <section className="flex min-h-[260px] shrink-0 flex-col border-b border-border bg-card lg:w-[360px] lg:border-b-0 lg:border-r">
          <div className="border-b border-border p-4">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索标题或作者" className="pl-9" />
            </div>
          </div>
          <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto">
            {loading && !items.length && <p className="p-8 text-center text-sm text-muted-foreground">正在加载…</p>}
            {!loading && !items.length && <p className="p-8 text-center text-sm text-muted-foreground">暂无符合条件的内容</p>}
            {items.map(item => <ResponseListItem key={item.id} item={item} selected={item.id === selectedId} onClick={() => selectResponse(item.id)} />)}
            <div ref={listEndRef} data-testid="responses-list-sentinel" aria-hidden="true" className="h-px" />
            {loadingMore && <p className="p-3 text-center text-xs text-muted-foreground">正在加载更多…</p>}
          </div>
        </section>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/20 p-4 lg:p-6">
          {!selected && <div className="grid h-full min-h-64 place-items-center text-sm text-muted-foreground">选择一条内容开始判断</div>}
          {selected && detailLoading && !detail && <div className="grid h-full min-h-64 place-items-center text-sm text-muted-foreground">正在加载原文与 AI 评价…</div>}
          {selected && detailError && !detail && <div className="grid h-full min-h-64 place-items-center text-sm text-destructive" role="alert">{detailError}</div>}
          {detail && (
            <div className="mx-auto grid max-w-[1500px] gap-5 xl:grid-cols-[3fr_2fr]">
              <ResponseSourcePane detail={detail} />
              <div className="space-y-4">
                <ResponseEvaluationPane detail={detail} onClassification={updateClassification} classificationBusy={classificationBusy} history={events} />
                {detail.outputs
                  ?.filter(output => draftWritingOutputTypes.includes(output.output_type))
                  .map(output => <WritingJobStatus key={output.id} output={output} />)}
                {detail.destination && (
                  <a href={detail.destination.url} className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300">
                    <span>已进入{detail.destination.type === 'draft' ? '草稿箱' : '创作资产'}</span><ExternalLink className="size-4" />
                  </a>
                )}
                <div className="flex flex-wrap gap-2 rounded-2xl border border-border bg-card p-4">
                  {detail.decision_status === 'pending' && (
                    <>
                      <Button onClick={openWritingDialog} disabled={!detail.analysis || destinationBusy}>值得写</Button>
                      <Button variant="outline" onClick={() => void openDestination('creative_asset')} disabled={!detail.analysis || destinationBusy}>创作资产</Button>
                      <Button variant="ghost" onClick={() => void changeDecision('not_processed')} disabled={detailLoading}>暂不处理</Button>
                      <span className="basis-full text-xs text-muted-foreground">快捷键：<kbd className="rounded border border-border bg-muted px-1 py-0.5">1</kbd> 值得写 · <kbd className="rounded border border-border bg-muted px-1 py-0.5">2</kbd> 创作资产 · <kbd className="rounded border border-border bg-muted px-1 py-0.5">3</kbd> 暂不处理</span>
                    </>
                  )}
                  {detail.decision_status === 'worth_writing' && (
                    <Button variant="outline" onClick={openWritingDialog} disabled={!detail.analysis || destinationBusy}>继续创作</Button>
                  )}
                  {detail.decision_status === 'not_processed' && (
                    <Button variant="outline" onClick={() => void changeDecision('reset')} disabled={detailLoading}><RotateCcw className="mr-1 size-4" />恢复待判断</Button>
                  )}
                  {detail.decision_status !== 'pending' && detail.decision_status !== 'not_processed' && !detail.destination && (
                    <Button variant="outline" onClick={() => void changeDecision('reset')} disabled={detailLoading}><RotateCcw className="mr-1 size-4" />重新判断</Button>
                  )}
                  <button type="button" className="ml-auto text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => void loadHistory()}>查看处理记录</button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {writingOpen ? (
        <ResponseWritingDialog
          open
          busy={destinationBusy}
          error={writingError}
          onOpenChange={setWritingOpen}
          onConfirm={outputTypes => void submitWritingTargets(outputTypes)}
        />
      ) : null}

      <ResponseDestinationDialog
        key={destination ?? 'closed'}
        open={destination !== null}
        destination={destination}
        detail={detail}
        directories={directories}
        busy={destinationBusy}
        error={destinationError}
        onOpenChange={open => { if (!open && !destinationBusy) setDestination(null) }}
        onConfirm={value => void submitDestination(value)}
      />
    </div>
  )
}

function ResponseListItem({ item, selected, onClick }: { item: ResponseItem; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn('w-full border-b border-border px-4 py-4 text-left transition-colors hover:bg-muted/60', selected && 'bg-primary/5')}>
      <div className="flex items-center gap-2">
        {item.source_type === 'youtube_video' ? <PlaySquare className="size-4 text-red-500" /> : <AtSign className="size-4 text-sky-600" />}
        <span className="truncate text-xs text-muted-foreground">{item.source_author || '未知作者'}</span>
        <Badge variant="outline" className="ml-auto text-[10px]">{dispositionLabels[item.decision_status]}</Badge>
      </div>
      <p className="mt-2 line-clamp-2 text-sm font-medium leading-5">{item.source_title || '未命名内容'}</p>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{item.analysis ? `${item.analysis.content_value_score} 分` : '待分析'}</span>
        {item.content_types.slice(0, 2).map(type => <span key={type} className="rounded bg-muted px-1.5 py-0.5">{contentTypeLabels[type]}</span>)}
        <span className="ml-auto whitespace-nowrap">{formatDate(item.source_published_at || item.created_at)}</span>
      </div>
      {item.analysis?.recommendation_reason && <p className="mt-2 line-clamp-1 text-xs text-muted-foreground">{item.analysis.recommendation_reason}</p>}
    </button>
  )
}

function WritingJobStatus({ output }: { output: ResponseOutput }) {
  const ready = output.status === 'draft_ready' && output.article_draft_id !== null
  const failed = output.job_status === 'failed' || output.status === 'failed'
  const draftUrl = ready ? `/drafts?draft=${output.article_draft_id}` : null
  const label = responseOutputLabels[output.output_type]
  const legacyExpandedArticle = output.output_type === 'expanded_article'
  return (
    <div data-testid="response-writing-status" className={cn(
      'rounded-xl border px-4 py-3 text-sm',
      ready && 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300',
      failed && 'border-destructive/30 bg-destructive/5 text-destructive',
      !ready && !failed && 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/20 dark:text-sky-300',
    )}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">
          {ready ? `${label}写作完成，已进入草稿箱` : failed ? `${label}写作任务失败` : `${label}写作中…`}
        </span>
        {draftUrl && <a href={draftUrl} className="inline-flex items-center gap-1 underline underline-offset-4">{legacyExpandedArticle ? '打开草稿箱' : `打开 ${label} 草稿`}<ExternalLink className="size-3.5" /></a>}
      </div>
      {failed && <p className="mt-1 text-xs">{output.error || '请前往任务看板查看日志并重试。'}</p>}
      {!ready && !failed && <p className="mt-1 text-xs opacity-80">写作完成后会自动创建独立草稿，不会自动发布。</p>}
    </div>
  )
}

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return <div className="mb-5"><p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</p>{children}</div>
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={`筛选：${String(children)}`} onClick={onClick} className={cn('w-full rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-muted', active && 'bg-muted font-medium text-foreground')}>{children}</button>
}
