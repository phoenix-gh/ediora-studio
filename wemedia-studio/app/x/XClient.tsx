'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Bird, Search, RefreshCw, Loader2, Settings, Trash2, ExternalLink,
  Globe, ListFilter, MessageSquare, Repeat2, Heart, Eye, Pencil, Check, X,
  SendHorizonal,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { fmtRelTime } from '@/lib/format'
import {
  type XSubscription, type XPost, type XSearchPost, type CreateXSubscriptionInput,
  listXSubscriptions, listXPosts, searchX,
  createXSubscription, patchXSubscription, deleteXSubscription,
  collectXSubscription, collectAllXSubscriptions,
} from '@/lib/api/x'
import { analyzePlan } from '@/lib/api/writing-plans'

const HOURS_OPTIONS = [
  { v: 24,  label: '24h' },
  { v: 168, label: '7d'  },
  { v: 720, label: '30d' },
]

type Selection = { kind: 'all' } | { kind: 'sub'; id: number } | { kind: 'search' }


export function XClient({
  initialSubs,
  initialPosts,
}: {
  initialSubs: XSubscription[]
  initialPosts: XPost[]
}) {
  const [subs, setSubs] = useState<XSubscription[]>(initialSubs)
  const [posts, setPosts] = useState<XPost[]>(initialPosts)
  const [selection, setSelection] = useState<Selection>({ kind: 'all' })
  const [hours, setHours] = useState<number>(168)
  const [loadingFeed, setLoadingFeed] = useState(false)
  const [collectingAll, setCollectingAll] = useState(false)
  const [actingId, setActingId] = useState<number | null>(null)
  const [subsOpen, setSubsOpen] = useState(false)

  const reloadSubs = async () => setSubs(await listXSubscriptions().catch(() => []))

  const reloadPosts = async (sel: Selection = selection, h: number = hours) => {
    if (sel.kind === 'search') return
    setLoadingFeed(true)
    try {
      setPosts(await listXPosts({
        subscription_id: sel.kind === 'sub' ? sel.id : undefined,
        hours: h,
      }))
    } catch {
      // silent
    } finally { setLoadingFeed(false) }
  }

  useEffect(() => { reloadPosts(selection, hours) }, [selection, hours])

  const handleAdd = async (input: CreateXSubscriptionInput) => {
    await createXSubscription(input)
    await Promise.all([reloadSubs(), reloadPosts()])
    toast.success('订阅已添加')
  }

  const handleToggle = async (s: XSubscription) => {
    await patchXSubscription(s.id, { enabled: !s.enabled })
    await reloadSubs()
  }

  const handleRename = async (s: XSubscription, label: string) => {
    await patchXSubscription(s.id, { label })
    await reloadSubs()
  }

  const handleDelete = async (s: XSubscription) => {
    await deleteXSubscription(s.id)
    if (selection.kind === 'sub' && selection.id === s.id) {
      setSelection({ kind: 'all' })
    }
    await Promise.all([reloadSubs(), reloadPosts()])
  }

  const handleCollectOne = async (s: XSubscription) => {
    setActingId(s.id)
    try {
      const r = await collectXSubscription(s.id)
      toast.success(`@${s.label}：新增 ${r.new_posts} 帖`)
      await Promise.all([reloadSubs(), reloadPosts()])
    } catch (e) {
      toast.error((e as Error).message || '采集失败')
    } finally { setActingId(null) }
  }

  const handleCollectAll = async () => {
    setCollectingAll(true)
    try {
      const r = await collectAllXSubscriptions()
      toast.success(
        `已采集 ${r.checked} 源，新增 ${r.new_posts} 帖`
        + (r.failed.length ? `（${r.failed.length} 源失败）` : '')
      )
      await Promise.all([reloadSubs(), reloadPosts()])
    } catch (e) {
      toast.error((e as Error).message || '采集失败')
    } finally { setCollectingAll(false) }
  }

  const selectedSub = useMemo(() => {
    if (selection.kind !== 'sub') return null
    return subs.find(s => s.id === selection.id) ?? null
  }, [selection, subs])

  const totalPostCount = useMemo(
    () => subs.reduce((sum, s) => sum + s.post_count, 0),
    [subs],
  )

  const headerTitle =
    selection.kind === 'all'    ? 'X 订阅 · 全部' :
    selection.kind === 'search' ? '实时搜索'      :
    selectedSub?.label || '订阅'

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-56 border-r border-zinc-200 dark:border-zinc-800 flex flex-col flex-shrink-0">
        <div className="px-3 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider px-1">X 订阅</p>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <SidebarRow
            icon={Search} iconColor="text-emerald-500" label="实时搜索"
            active={selection.kind === 'search'} onClick={() => setSelection({ kind: 'search' })}
          />
          <div className="text-[11px] uppercase tracking-wider text-zinc-400 mt-3 mb-1 px-2">
            已订阅 · {subs.length}
          </div>
          <SidebarRow
            icon={Globe} iconColor="text-sky-500" label="全部"
            badge={totalPostCount > 0 ? String(totalPostCount) : undefined}
            active={selection.kind === 'all'}
            onClick={() => setSelection({ kind: 'all' })}
          />
          {subs.length === 0 ? (
            <p className="text-xs text-zinc-400 text-center mt-2 px-3">
              点右上角「订阅管理」添加
            </p>
          ) : (
            subs.map(s => (
              <SidebarRow
                key={s.id}
                icon={Bird}
                iconColor={s.enabled ? 'text-sky-500' : 'text-zinc-400'}
                label={s.label}
                badge={s.post_count > 0 ? String(s.post_count) : undefined}
                active={selection.kind === 'sub' && selection.id === s.id}
                muted={!s.enabled}
                hasError={!!s.last_error}
                onClick={() => setSelection({ kind: 'sub', id: s.id })}
              />
            ))
          )}
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-6 py-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2 min-w-0">
              <Bird className="w-4 h-4 text-sky-500 shrink-0" />
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300 truncate">
                {headerTitle}
              </span>
              {selection.kind !== 'search' && (
                <span className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full shrink-0">
                  {posts.length} 帖
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {selection.kind !== 'search' && (
                <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5"
                  onClick={handleCollectAll} disabled={collectingAll}>
                  <RefreshCw className={cn('w-3.5 h-3.5', collectingAll && 'animate-spin')} />
                  {collectingAll ? '采集中…' : '立即采集'}
                </Button>
              )}
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5"
                onClick={() => setSubsOpen(true)}>
                <Settings className="w-3.5 h-3.5" />
                订阅管理
              </Button>
            </div>
          </div>

          {selection.kind !== 'search' && (
            <div className="flex items-center gap-1 mt-2.5">
              <span className="text-xs text-zinc-400 mr-1">最近</span>
              {HOURS_OPTIONS.map(({ v, label }) => (
                <button key={v}
                  onClick={() => setHours(v)}
                  className={cn(
                    'text-xs px-2 py-0.5 rounded transition-colors',
                    hours === v
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                  )}
                >{label}</button>
              ))}
              {selectedSub?.last_error && (
                <span className="ml-3 text-xs text-red-500 truncate">
                  ⚠ {selectedSub.last_error}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {selection.kind === 'search'
            ? <SearchPanel />
            : <FeedPanel posts={posts} loading={loadingFeed} subsCount={subs.length} />}
        </div>
      </div>

      <SubscribeDialog
        open={subsOpen}
        onOpenChange={setSubsOpen}
        subs={subs}
        actingId={actingId}
        onAdd={handleAdd}
        onToggle={handleToggle}
        onDelete={handleDelete}
        onCollect={handleCollectOne}
        onRename={handleRename}
        onSaved={reloadSubs}
      />
    </div>
  )
}


// ── Sidebar row ──────────────────────────────────────────────────────────────

function SidebarRow({
  icon: Icon, iconColor, label, badge, active, muted, hasError, onClick,
}: {
  icon: typeof Bird
  iconColor: string
  label: string
  badge?: string
  active?: boolean
  muted?: boolean
  hasError?: boolean
  onClick: () => void
}) {
  return (
    <button onClick={onClick} className={cn(
      'w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors mb-0.5',
      active
        ? 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300'
        : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
      muted && 'opacity-50',
    )}>
      <Icon className={cn('w-4 h-4 flex-shrink-0', iconColor)} />
      <span className="text-xs font-medium truncate flex-1">{label}</span>
      {hasError && <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0" />}
      {badge && (
        <span className="text-[10px] text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded-full">
          {badge}
        </span>
      )}
    </button>
  )
}


// ── Feed panel ───────────────────────────────────────────────────────────────

function FeedPanel({
  posts, loading, subsCount,
}: {
  posts: XPost[]
  loading: boolean
  subsCount: number
}) {
  if (loading && posts.length === 0) {
    return <div className="flex items-center justify-center h-32 text-sm text-zinc-400">加载中…</div>
  }
  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3 text-zinc-400">
        <Bird className="w-10 h-10 opacity-20 text-sky-500" />
        <p className="text-sm">
          {subsCount === 0 ? '点右上角「订阅管理」添加 X URL 开始' : '该范围暂无帖子，试试「立即采集」或换时间窗'}
        </p>
      </div>
    )
  }
  return (
    <div className="max-w-3xl space-y-2">
      {posts.map(p => <PostCard key={p.tweet_id} post={p} />)}
    </div>
  )
}


// ── Search panel ─────────────────────────────────────────────────────────────

function SearchPanel() {
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<XSearchPost[]>([])
  const [error, setError] = useState('')

  const run = async () => {
    const trimmed = q.trim()
    if (!trimmed) return
    setLoading(true); setError(''); setResults([])
    try {
      setResults(await searchX(trimmed))
    } catch (e) {
      setError((e as Error).message || '搜索失败')
    } finally { setLoading(false) }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <ListFilter className="w-3.5 h-3.5" />
        <span>实时通过 feedgrab 查询 X · 结果不入库</span>
      </div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
          <Input value={q} onChange={e => setQ(e.target.value)}
            placeholder="输入关键词，例如：AI agent"
            className="h-8 text-sm pl-8"
            onKeyDown={e => { if (e.key === 'Enter') run() }}
          />
        </div>
        <Button size="sm" className="h-8 text-xs gap-1.5" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          搜索
        </Button>
      </div>
      {error && (
        <div className="rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      {results.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-zinc-400">{results.length} 条结果</p>
          {results.map(p => <PostCard key={p.tweet_id} post={p} />)}
        </div>
      )}
      {!loading && !error && results.length === 0 && (
        <p className="text-xs text-zinc-400">输入关键词后回车搜索</p>
      )}
    </div>
  )
}


// ── Post card (works for XPost and XSearchPost — shared fields only) ─────────

function PostCard({ post: p }: { post: XPost | XSearchPost }) {
  const router = useRouter()
  const [analyzing, setAnalyzing] = useState(false)
  const avatar = p.author_avatar || `https://unavatar.io/x/${p.username}`

  const handleAnalyze = async () => {
    setAnalyzing(true)
    try {
      const res = await analyzePlan({ url: p.url, content: p.content })
      toast.success('已派发给 Scout', {
        description: `任务 ${res.task_id}`,
        action: { label: '查看看板', onClick: () => router.push(res.kanban_url) },
      })
    } catch {
      toast.error('派发失败')
    } finally { setAnalyzing(false) }
  }

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors">
      <div className="flex items-start gap-3">
        <a href={`https://x.com/${p.username}`} target="_blank" rel="noreferrer" className="shrink-0">
          <img
            src={avatar}
            alt={p.username}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 object-cover"
            onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
          />
        </a>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex items-center gap-1.5 text-sm min-w-0">
              <span className="font-medium text-zinc-800 dark:text-zinc-200 truncate">
                {p.display_name || p.username}
              </span>
              <span className="text-zinc-400 text-xs truncate">@{p.username}</span>
            </div>
            <a href={p.url} target="_blank" rel="noreferrer"
              className="text-xs text-zinc-400 hover:text-sky-500 flex items-center gap-1 shrink-0"
              title={new Date(p.published_at).toLocaleString()}>
              {fmtRelTime(p.published_at)}
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap mb-2">
            {p.content}
          </p>
          {p.cover_image && (
            <a href={p.url} target="_blank" rel="noreferrer"
              className="block mb-2 rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-800">
              <img
                src={p.cover_image}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                className="w-full max-h-[420px] object-cover"
                onError={e => { (e.currentTarget.parentElement as HTMLElement).style.display = 'none' }}
              />
            </a>
          )}
          <div className="flex items-center gap-4 text-xs text-zinc-400">
            <span className="flex items-center gap-1"><Eye className="w-3 h-3" />{p.views.toLocaleString()}</span>
            <span className="flex items-center gap-1"><Repeat2 className="w-3 h-3" />{p.reposts.toLocaleString()}</span>
            <span className="flex items-center gap-1"><Heart className="w-3 h-3" />{p.likes.toLocaleString()}</span>
            <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{p.replies.toLocaleString()}</span>
            <button
              onClick={handleAnalyze}
              disabled={analyzing}
              title="提炼写作方案"
              className="ml-auto flex items-center gap-1 text-zinc-400 hover:text-indigo-500 disabled:opacity-40 transition-colors"
            >
              {analyzing
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <SendHorizonal className="w-3.5 h-3.5" />}
              <span>提炼方案</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}


// ── Subscribe dialog ─────────────────────────────────────────────────────────

function SubscribeDialog({
  open, onOpenChange, subs, actingId,
  onAdd, onToggle, onDelete, onCollect, onRename, onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  subs: XSubscription[]
  actingId: number | null
  onAdd: (input: CreateXSubscriptionInput) => Promise<void>
  onToggle: (s: XSubscription) => Promise<void>
  onDelete: (s: XSubscription) => Promise<void>
  onCollect: (s: XSubscription) => Promise<void>
  onRename: (s: XSubscription, label: string) => Promise<void>
  onSaved: () => Promise<void>
}) {
  const [kind, setKind] = useState<'timeline' | 'search'>('timeline')
  const [url, setUrl] = useState('')
  const [rawQuery, setRawQuery] = useState('')
  const [name, setName] = useState('')
  const [maxResults, setMaxResults] = useState(50)
  const [adding, setAdding] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editingSearchId, setEditingSearchId] = useState<number | null>(null)

  const startEditSearch = (s: XSubscription) => {
    setKind('search')
    setRawQuery(s.raw_query)
    setMaxResults(s.max_results)
    setName(s.label)
    setEditingSearchId(s.id)
  }
  const cancelEditSearch = () => {
    setEditingSearchId(null)
    setRawQuery('')
    setMaxResults(50)
    setName('')
  }

  const sinceDays = (n: number) =>
    new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
  const QUICK_TOKENS: { label: string; token: string }[] = [
    { label: 'OR 组', token: '(关键词A OR 关键词B)' },
    { label: '排除回复', token: '-filter:replies' },
    { label: '只看回复', token: 'filter:replies' },
    { label: '排除链接', token: '-filter:links' },
    { label: '排除转推', token: '-filter:retweets' },
    { label: '高赞', token: 'min_faves:1500' },
    { label: '中文', token: 'lang:zh' },
    { label: '近7天', token: `since:${sinceDays(7)}` },
  ]
  const insertToken = (t: string) =>
    setRawQuery(prev => (prev.trim() ? prev.trim() + ' ' : '') + t + ' ')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setAdding(true)
    try {
      if (kind === 'search') {
        const q = rawQuery.trim()
        if (!q) return
        if (editingSearchId != null) {
          await patchXSubscription(editingSearchId, {
            raw_query: q, max_results: maxResults, label: name.trim() || undefined,
          })
          toast.success('已保存修改')
          await onSaved()
          cancelEditSearch()
        } else {
          await onAdd({ kind: 'search', raw_query: q, max_results: maxResults, label: name.trim() || undefined })
          setRawQuery('')
          setName('')
        }
      } else {
        const trimmed = url.trim()
        if (!trimmed) return
        await onAdd({ kind: 'timeline', url: trimmed, label: name.trim() || undefined })
        setUrl('')
        setName('')
      }
    } catch (err) {
      toast.error((err as Error).message || '添加失败')
    } finally { setAdding(false) }
  }

  const wrap = async (s: XSubscription, fn: (s: XSubscription) => Promise<void>) => {
    setBusyId(s.id)
    try { await fn(s) }
    catch (err) { toast.error((err as Error).message || '操作失败') }
    finally { setBusyId(null) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">X 订阅管理</DialogTitle>
          <DialogDescription className="text-xs">
            时间线订阅用主页/list URL；搜索订阅用 X 高级搜索语法，两者都定时落库到 x_posts
          </DialogDescription>
        </DialogHeader>

        {editingSearchId == null ? (
          <div className="flex items-center gap-1.5">
            <Button type="button" size="sm" variant={kind === 'timeline' ? 'default' : 'outline'}
              className="h-7 text-xs" onClick={() => setKind('timeline')}>时间线</Button>
            <Button type="button" size="sm" variant={kind === 'search' ? 'default' : 'outline'}
              className="h-7 text-xs" onClick={() => setKind('search')}>搜索</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-xs text-amber-600">
            <Pencil className="w-3 h-3" /> 正在编辑搜索订阅
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs ml-auto"
              onClick={cancelEditSearch}>取消</Button>
          </div>
        )}

        <Input value={name} onChange={e => setName(e.target.value)}
          placeholder="名称（可选，留空自动命名）"
          className="h-8 text-xs" />

        {kind === 'timeline' ? (
          <form onSubmit={submit} className="flex items-center gap-2">
            <Input value={url} onChange={e => setUrl(e.target.value)}
              placeholder="https://x.com/elonmusk 或 https://x.com/i/lists/12345"
              className="h-8 text-xs flex-1" />
            <Button type="submit" size="sm" className="h-8 text-xs"
              disabled={adding || !url.trim()}>
              {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '添加'}
            </Button>
          </form>
        ) : (
          <form onSubmit={submit} className="space-y-2">
            <textarea value={rawQuery} onChange={e => setRawQuery(e.target.value)}
              rows={2} spellCheck={false}
              placeholder="X 高级搜索语法，如：(AI OR 大模型) min_faves:1500 lang:zh -filter:replies"
              className="w-full px-2 py-1.5 border border-zinc-200 dark:border-zinc-700 rounded bg-transparent text-xs font-mono outline-none focus:border-sky-400 resize-y" />
            <div className="flex flex-wrap gap-1">
              {QUICK_TOKENS.map(c => (
                <button type="button" key={c.label} onClick={() => insertToken(c.token)}
                  className="text-[11px] px-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:border-sky-400 hover:text-sky-500 transition-colors">
                  + {c.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-zinc-400 flex items-center gap-1">
                条数上限
                <Input type="number" value={maxResults}
                  onChange={e => setMaxResults(Number(e.target.value) || 1)}
                  className="h-7 w-20 text-xs" />
              </label>
              <Button type="submit" size="sm" className="h-8 text-xs ml-auto"
                disabled={adding || !rawQuery.trim()}>
                {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : (editingSearchId != null ? '保存修改' : '添加搜索订阅')}
              </Button>
            </div>
          </form>
        )}

        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-zinc-400 mb-1.5 px-0.5">
            已订阅 · {subs.length}
          </div>
          {subs.length === 0 ? (
            <div className="text-xs text-zinc-400 py-6 text-center border border-dashed rounded-md">
              暂无订阅
            </div>
          ) : (
            <div className="border border-zinc-200 dark:border-zinc-800 rounded-md max-h-72 overflow-y-auto">
              {subs.map(s => {
                const isEditing = editingId === s.id
                const commitEdit = async () => {
                  const next = editValue.trim()
                  if (next && next !== s.label) {
                    setBusyId(s.id)
                    try { await onRename(s, next) }
                    catch (err) { toast.error((err as Error).message || '改名失败') }
                    finally { setBusyId(null) }
                  }
                  setEditingId(null)
                }
                return (
                  <div key={s.id} className={cn(
                    'flex items-center gap-2 px-2.5 py-1.5 border-b border-zinc-100 dark:border-zinc-800 last:border-0',
                    !s.enabled && 'opacity-50',
                  )}>
                    <Bird className={cn(
                      'w-4 h-4 flex-shrink-0',
                      s.enabled ? 'text-sky-500' : 'text-zinc-400',
                    )} />
                    <div className="flex-1 min-w-0">
                      {isEditing ? (
                        <Input
                          autoFocus
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') commitEdit()
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          className="h-6 text-xs px-1"
                        />
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <div className="text-xs font-medium truncate">{s.label || '未命名'}</div>
                          <span className={cn(
                            'text-[10px] px-1 rounded flex-shrink-0',
                            s.kind === 'search'
                              ? 'bg-violet-100 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400'
                              : 'bg-sky-100 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400',
                          )}>
                            {s.kind === 'search' ? '搜索' : '时间线'}
                          </span>
                        </div>
                      )}
                      {(s.kind === 'search' ? s.raw_query : s.url) && (
                        <div className="text-[11px] text-zinc-500 font-mono break-words whitespace-pre-wrap"
                          title={(s.kind === 'search' ? s.raw_query : s.url) || ''}>
                          {s.kind === 'search' ? s.raw_query : s.url}
                        </div>
                      )}
                      <div className="text-[11px] text-zinc-400 truncate">
                        {s.post_count} 帖 · {s.last_collected_at
                          ? fmtRelTime(s.last_collected_at) + ' 采集'
                          : '未采集'}
                        {s.last_error && (
                          <span className="text-red-500 ml-1">⚠ {s.last_error}</span>
                        )}
                      </div>
                    </div>
                    {isEditing ? (
                      <>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-emerald-500"
                          onClick={commitEdit}><Check className="w-3 h-3" /></Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-zinc-400"
                          onClick={() => setEditingId(null)}><X className="w-3 h-3" /></Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                          disabled={busyId === s.id}
                          onClick={() => {
                            if (s.kind === 'search') {
                              startEditSearch(s)
                            } else {
                              setEditValue(s.label); setEditingId(s.id)
                            }
                          }}
                          title={s.kind === 'search' ? '编辑' : '重命名'}>
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Switch checked={s.enabled} onCheckedChange={() => wrap(s, onToggle)}
                          disabled={busyId === s.id} />
                        <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 px-2"
                          disabled={busyId === s.id || actingId === s.id}
                          onClick={() => wrap(s, onCollect)}>
                          {actingId === s.id
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <RefreshCw className="w-3 h-3" />}
                          采集
                        </Button>
                        <Button size="sm" variant="ghost"
                          className="h-7 w-7 p-0 text-red-400 hover:text-red-600"
                          disabled={busyId === s.id}
                          onClick={async () => {
                            if (!confirm(`删除订阅「${s.label}」？关联帖子也会被清掉。`)) return
                            await wrap(s, onDelete)
                          }}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </>
                    )}
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
