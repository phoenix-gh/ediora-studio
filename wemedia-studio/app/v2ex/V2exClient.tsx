'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { Hash, User, Layers, Globe, RefreshCw, Trash2, Volume2, VolumeX, ExternalLink, Search, MessageCircle, Loader2, Settings } from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  V2exKind, V2exSubscription, V2exTopic, V2exPresets,
  getV2exSubscriptions, getV2exTopics,
  addV2exSubscription, updateV2exSubscription, deleteV2exSubscription,
  collectV2exAll, collectV2exSubscription,
} from '@/lib/api/v2ex'
import { AddToTopicPopover } from '@/components/features/AddToTopicPopover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ResponsiveArticleReader, ReaderMeta } from '@/components/features/ArticleReader'
import { useMediaQuery } from '@/lib/use-media-query'
import { fmtRelTime } from '@/lib/format'
import { useInfiniteScroll } from '@/lib/use-infinite-scroll'

const KIND_META: Record<V2exKind, { label: string; icon: typeof Hash; color: string }> = {
  node: { label: '节点', icon: Hash, color: 'text-blue-500' },
  user: { label: '用户', icon: User, color: 'text-purple-500' },
  tab:  { label: 'Tab', icon: Layers, color: 'text-orange-500' },
  all:  { label: '全站', icon: Globe, color: 'text-gray-500' },
}

const DAYS_OPTIONS = [3, 7, 14, 30]
const PAGE_SIZE = 30

function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

// ── Subscribe Dialog ──────────────────────────────────────────────────────────

function SubscribeDialog({
  open, onOpenChange, presets, subs, onAdd, onMute, onDelete, onCollect,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  presets: V2exPresets
  subs: V2exSubscription[]
  onAdd: (body: { kind: V2exKind; key?: string; label?: string; group?: string }) => Promise<void>
  onMute: (s: V2exSubscription) => Promise<void>
  onDelete: (s: V2exSubscription) => Promise<void>
  onCollect: (s: V2exSubscription) => Promise<void>
}) {
  const [kind, setKind] = useState<V2exKind>('node')
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [group, setGroup] = useState('未分组')
  const [adding, setAdding] = useState(false)
  const [actingId, setActingId] = useState<number | null>(null)

  const presetList = kind === 'tab' ? presets.tabs : kind === 'node' ? presets.nodes : []
  const placeholderMap: Record<V2exKind, string> = {
    node: '节点 slug，如 programmer',
    user: '用户名，如 Livid',
    tab:  '请从下方选择',
    all:  '无需填写',
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (kind !== 'all' && !key.trim()) return
    setAdding(true)
    try {
      await onAdd({
        kind,
        key: kind === 'all' ? '' : key.trim(),
        label: label.trim() || undefined,
        group,
      })
      setKey(''); setLabel('')
    } finally {
      setAdding(false)
    }
  }

  async function wrap(s: V2exSubscription, fn: (x: V2exSubscription) => Promise<void>) {
    setActingId(s.id)
    try { await fn(s) } finally { setActingId(null) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>订阅管理 · V2EX</DialogTitle>
          <DialogDescription>
            按节点、用户、Tab 或全站订阅，系统会定时拉取最新主题。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-2">
          <div className="grid grid-cols-4 gap-1 p-0.5 bg-zinc-100 dark:bg-zinc-900 rounded-md">
            {(Object.keys(KIND_META) as V2exKind[]).map(k => {
              const Icon = KIND_META[k].icon
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => { setKind(k); setKey('') }}
                  className={cn(
                    'flex items-center justify-center gap-1 px-2 py-1 text-xs rounded transition-colors',
                    kind === k
                      ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-700'
                  )}
                >
                  <Icon className={cn('w-3 h-3', kind === k && KIND_META[k].color)} />
                  {KIND_META[k].label}
                </button>
              )
            })}
          </div>

          {kind !== 'all' && (
            <div>
              <Input value={key} onChange={e => setKey(e.target.value)}
                placeholder={placeholderMap[kind]} className="h-8 text-xs"
                disabled={kind === 'tab'} />
              {presetList.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {presetList.map(p => (
                    <button key={p.key} type="button" onClick={() => setKey(p.key)}
                      className={cn(
                        'px-2 py-0.5 rounded-full text-xs transition-colors',
                        key === p.key
                          ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 font-medium'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700',
                      )}>
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Input value={label} onChange={e => setLabel(e.target.value)}
              placeholder="显示名（留空自动取）" className="h-8 text-xs flex-1" />
            <Input value={group} onChange={e => setGroup(e.target.value)}
              placeholder="分组" className="h-8 text-xs w-24" />
            <Button type="submit" size="sm" className="h-8 text-xs"
              disabled={adding || (kind !== 'all' && !key.trim())}>
              {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '添加'}
            </Button>
          </div>
        </form>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-zinc-400 mb-1.5 px-0.5">
            已订阅 · {subs.length}
          </div>
          {subs.length === 0 ? (
            <div className="text-xs text-zinc-400 py-6 text-center border border-dashed rounded-md">
              暂无订阅。从上方选 kind + key 后点击「添加」。
            </div>
          ) : (
            <div className="border border-zinc-200 dark:border-zinc-800 rounded-md max-h-60 overflow-y-auto">
              {subs.map(s => {
                const Icon = KIND_META[s.kind].icon
                return (
                  <div key={s.id}
                    className={cn(
                      'flex items-center gap-2 px-2.5 py-1.5 border-b border-zinc-100 dark:border-zinc-800 last:border-0',
                      s.muted && 'opacity-50'
                    )}>
                    <Icon className={cn('w-4 h-4 flex-shrink-0', KIND_META[s.kind].color)} />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium truncate">{s.label}</div>
                      <div className="text-[11px] text-zinc-400 truncate">
                        {KIND_META[s.kind].label}{s.key && ` · ${s.key}`} · {s.group}
                      </div>
                    </div>
                    <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 px-2"
                      disabled={actingId === s.id} onClick={() => wrap(s, onCollect)}>
                      {actingId === s.id
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <RefreshCw className="w-3 h-3" />}
                      同步
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                      disabled={actingId === s.id}
                      title={s.muted ? '取消静音' : '静音'}
                      onClick={() => wrap(s, onMute)}>
                      {s.muted ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
                    </Button>
                    <Button size="sm" variant="ghost"
                      className="h-7 w-7 p-0 text-red-400 hover:text-red-600"
                      disabled={actingId === s.id}
                      onClick={() => wrap(s, onDelete)}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Subscription Sidebar ───────────────────────────────────────────────────────

function SubList({
  subs, selectedId, onSelect, onMute, onDelete, onCollect,
}: {
  subs: V2exSubscription[]
  selectedId: number | null
  onSelect: (id: number | null) => void
  onMute: (s: V2exSubscription) => Promise<void>
  onDelete: (s: V2exSubscription) => Promise<void>
  onCollect: (s: V2exSubscription) => Promise<void>
}) {
  // Group by `group` field
  const grouped = useMemo(() => {
    const m = new Map<string, V2exSubscription[]>()
    for (const s of subs) {
      const arr = m.get(s.group) || []
      arr.push(s)
      m.set(s.group, arr)
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [subs])

  return (
    <div className="space-y-0.5">
      <button
        onClick={() => onSelect(null)}
        className={cn(
          'w-full text-left flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
          selectedId === null
            ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 font-medium'
            : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-900',
        )}
      >
        <Globe className="w-4 h-4 flex-shrink-0 text-indigo-500" />
        <span className="truncate">全部订阅</span>
        <span className="ml-auto text-[10px] text-zinc-400">{subs.length}</span>
      </button>

      {grouped.map(([group, items]) => (
        <div key={group} className="pt-2">
          <p className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider px-3 pb-1">{group}</p>
          {items.map(s => {
            const meta = KIND_META[s.kind as V2exKind]
            const Icon = meta?.icon || Hash
            return (
              <div
                key={s.id}
                className={cn(
                  'group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors cursor-pointer',
                  selectedId === s.id
                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-900',
                  s.muted && 'opacity-50',
                )}
                onClick={() => onSelect(s.id)}
              >
                <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', meta?.color)} />
                <span className="truncate flex-1 min-w-0">{s.label}</span>
                <span className="hidden group-hover:hidden text-[10px] text-zinc-400">{s.topic_count}</span>
                <div className="hidden group-hover:flex items-center gap-0.5">
                  <button
                    onClick={e => { e.stopPropagation(); onCollect(s) }}
                    className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                    title="立即采集"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); onMute(s) }}
                    className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
                    title={s.muted ? '取消静音' : '静音'}
                  >
                    {s.muted ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); onDelete(s) }}
                    className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950 text-red-500 transition-colors"
                    title="删除订阅"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

// ── Topic Card ─────────────────────────────────────────────────────────────────

function TopicCard({ topic, onOpen }: { topic: V2exTopic; onOpen: () => void }) {
  const excerpt = stripHtml(topic.content).slice(0, 140)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="relative w-full text-left block py-3 px-2 -mx-2 rounded-lg border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors group cursor-pointer"
    >
      <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100 line-clamp-2 leading-snug
                    group-hover:text-blue-700 dark:group-hover:text-blue-400 transition-colors">
        {topic.title}
      </p>
      {excerpt && (
        <p className="mt-1 text-[11px] text-zinc-400 line-clamp-2 leading-relaxed">{excerpt}</p>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-zinc-400">
        {topic.author && (
          <>
            <User className="w-3 h-3 flex-shrink-0" />
            <span className="text-zinc-500 truncate max-w-[160px]">{topic.author}</span>
          </>
        )}
        <span>·</span>
        <span>{fmtRelTime(topic.published_at)}</span>
      </div>

      <div className="mt-2 flex items-center text-[11px] text-zinc-400">
        <span className="flex items-center gap-1">
          <MessageCircle className="w-3.5 h-3.5" />
          {topic.replies}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <a
            href={topic.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            title="查看原帖"
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-zinc-400 hover:text-blue-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <AddToTopicPopover
            url={topic.url}
            title={topic.title}
            summary={excerpt}
            platform="v2ex"
          />
        </div>
      </div>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function V2exClient({
  initialSubs, initialTopics, presets,
}: {
  initialSubs: V2exSubscription[]
  initialTopics: V2exTopic[]
  presets: V2exPresets
}) {
  const [subs, setSubs] = useState(initialSubs)
  const [topics, setTopics] = useState(initialTopics)
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null)
  const [days, setDays] = useState(14)
  const [search, setSearch] = useState('')
  const [collecting, setCollecting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [readerOpen, setReaderOpen] = useState(false)
  const [readerMeta, setReaderMeta] = useState<ReaderMeta | null>(null)
  const [subsOpen, setSubsOpen] = useState(false)
  // V2EX already has external sidebar (224) + internal subs sidebar (224); needs a wider viewport before fitting a reader panel
  const useSidePanel = useMediaQuery('(min-width: 1440px)')

  const selectedSub = selectedSubId ? subs.find(s => s.id === selectedSubId) ?? null : null

  function openReader(topic: V2exTopic) {
    const sub = subs.find(s => s.id === topic.subscription_id)
    setReaderMeta({
      title: topic.title,
      author: topic.author,
      source: sub ? `V2EX · ${sub.label}` : 'V2EX',
      published_at: topic.published_at,
      url: topic.url,
      content: topic.content,
    })
    setReaderOpen(true)
  }

  const refreshTopics = useCallback(async (opts?: { subId?: number | null; daysVal?: number }) => {
    setLoading(true)
    try {
      const sid = opts?.subId !== undefined ? opts.subId : selectedSubId
      const d = opts?.daysVal ?? days
      const data = await getV2exTopics({
        subscription_id: sid ?? undefined,
        days: d,
        limit: 200,
        search: search || undefined,
      })
      setTopics(data)
      resetScroll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [selectedSubId, days, search])

  async function handleAdd(body: Parameters<typeof addV2exSubscription>[0]) {
    try {
      await addV2exSubscription(body)
      toast.success('订阅成功，正在后台采集…')
      const fresh = await getV2exSubscriptions()
      setSubs(fresh)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '订阅失败')
      throw e
    }
  }

  async function handleMute(s: V2exSubscription) {
    try {
      const updated = await updateV2exSubscription(s.id, { muted: !s.muted })
      setSubs(prev => prev.map(x => x.id === s.id ? updated : x))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    }
  }

  async function handleDelete(s: V2exSubscription) {
    if (!confirm(`删除订阅「${s.label}」？该订阅下的所有主题也会一同删除。`)) return
    try {
      await deleteV2exSubscription(s.id)
      toast.success(`已删除：${s.label}`)
      const fresh = await getV2exSubscriptions()
      setSubs(fresh)
      if (selectedSubId === s.id) {
        setSelectedSubId(null)
        await refreshTopics({ subId: null })
      } else {
        await refreshTopics()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  async function handleCollect(s: V2exSubscription) {
    try {
      await collectV2exSubscription(s.id)
      toast.success(`${s.label} 采集已启动`)
      setTimeout(() => refreshTopics(), 3000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '采集失败')
    }
  }

  async function handleCollectAll() {
    setCollecting(true)
    try {
      await collectV2exAll()
      toast.success('全量采集已启动')
      setTimeout(() => refreshTopics(), 5000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '采集失败')
    } finally {
      setCollecting(false)
    }
  }

  async function handleSelect(id: number | null) {
    setSelectedSubId(id)
    await refreshTopics({ subId: id })
  }

  async function handleDaysChange(d: number) {
    setDays(d)
    await refreshTopics({ daysVal: d })
  }

  const filtered = useMemo(() => {
    let list = topics
    if (search) {
      const q = search.toLowerCase()
      list = list.filter(t =>
        t.title.toLowerCase().includes(q) ||
        t.author.toLowerCase().includes(q)
      )
    }
    return list
  }, [topics, search])

  const { visibleCount, sentinelRef, hasMore, reset: resetScroll } = useInfiniteScroll({
    totalCount: filtered.length,
    pageSize: PAGE_SIZE,
  })
  const visible = filtered.slice(0, visibleCount)

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-56 border-r border-zinc-200 dark:border-zinc-800 flex flex-col flex-shrink-0">
        <div className="px-3 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-1">V2EX 订阅</p>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {subs.length === 0 ? (
            <p className="text-xs text-zinc-400 text-center mt-6 px-3">还没有订阅，点右上角添加</p>
          ) : (
            <SubList
              subs={subs}
              selectedId={selectedSubId}
              onSelect={handleSelect}
              onMute={handleMute}
              onDelete={handleDelete}
              onCollect={handleCollect}
            />
          )}
        </div>
      </div>

      {/* Main */}
      <div className={cn(
        'flex flex-col relative',
        useSidePanel
          ? 'w-[440px] flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800'
          : 'flex-1 min-w-0',
      )}>
        <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-6 py-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-indigo-500" />
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                {selectedSub ? selectedSub.label : 'V2EX 订阅'}
              </span>
              <span className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full">
                {filtered.length} 个主题
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
                <Input
                  value={search}
                  onChange={e => { setSearch(e.target.value); resetScroll() }}
                  placeholder="搜索标题/作者"
                  className="h-8 text-xs pl-8 w-44"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5"
                onClick={handleCollectAll}
                disabled={collecting}
              >
                <RefreshCw className={cn('w-3.5 h-3.5', collecting && 'animate-spin')} />
                {collecting ? '采集中…' : '立即采集'}
              </Button>
              <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5"
                onClick={() => setSubsOpen(true)}>
                <Settings className="w-3.5 h-3.5" />
                订阅管理
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-1 mt-2.5">
            <span className="text-xs text-zinc-400">最近</span>
            {DAYS_OPTIONS.map(d => (
              <button
                key={d}
                onClick={() => handleDaysChange(d)}
                className={cn(
                  'px-2 py-0.5 rounded text-xs transition-colors',
                  days === d
                    ? 'bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-medium'
                    : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                )}
              >
                {d}天
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center h-32 text-sm text-zinc-400">加载中…</div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-zinc-400">
              <Globe className="w-10 h-10 opacity-20 text-indigo-500" />
              <p className="text-sm">
                {subs.length === 0 ? '点击右上角「添加订阅」开始' : '该订阅暂无主题，尝试「立即采集」'}
              </p>
            </div>
          ) : (
            <>
              <div className={useSidePanel ? '' : 'max-w-3xl'}>
                {visible.map(t => <TopicCard key={t.id} topic={t} onOpen={() => openReader(t)} />)}
              </div>
              <div ref={sentinelRef} className="py-4">
                {hasMore && <span className="text-xs text-zinc-400">加载中…</span>}
              </div>
            </>
          )}
        </div>
      </div>

      <ResponsiveArticleReader
        asPanel={useSidePanel}
        open={readerOpen}
        onClose={() => setReaderOpen(false)}
        meta={readerMeta}
        accent="indigo"
      />

      <SubscribeDialog
        open={subsOpen}
        onOpenChange={setSubsOpen}
        presets={presets}
        subs={subs}
        onAdd={handleAdd}
        onMute={handleMute}
        onDelete={handleDelete}
        onCollect={handleCollect}
      />
    </div>
  )
}
