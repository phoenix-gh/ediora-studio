'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bird,
  ExternalLink,
  Eye,
  Globe,
  Heart,
  ListFilter,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Repeat2,
  Search,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { fmtDateTime, fmtRelTime } from '@/lib/format'
import {
  type XSubscription,
  type XPost,
  type XSearchPost,
  type CreateXSubscriptionInput,
  type XSubscriptionPatch,
  listXSubscriptions,
  listXPosts,
  searchX,
  createXSubscription,
  patchXSubscription,
  deleteXSubscription,
  collectXSubscription,
  collectAllXSubscriptions,
  backfillXSubscription,
  backfillXSubscriptionIngestion,
} from '@/lib/api/x'
import { externalHttpUrl } from './x-post-url'
import { XSubscriptionDialog } from './XSubscriptionDialog'

const HOURS_OPTIONS = [
  { v: 24, label: '24h' },
  { v: 168, label: '7d' },
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
  const [loadingFeed, setLoadingFeed] = useState(initialPosts.length === 0)
  const [collectingAll, setCollectingAll] = useState(false)
  const [subscriptionDialog, setSubscriptionDialog] = useState<{
    mode: 'create' | 'edit'
    subscription: XSubscription | null
  } | null>(null)
  const feedRequestIdentityRef = useRef(0)
  const initialRecoveryRef = useRef<{
    identity: number
    request: Promise<XPost[]>
  } | null>(null)

  useEffect(() => {
    if (initialPosts.length > 0) return
    let cancelled = false
    let recovery = initialRecoveryRef.current
    if (!recovery) {
      recovery = {
        identity: feedRequestIdentityRef.current + 1,
        request: listXPosts({ hours: 168 }),
      }
      feedRequestIdentityRef.current = recovery.identity
      initialRecoveryRef.current = recovery
    }
    void recovery.request
      .then(items => {
        if (!cancelled && feedRequestIdentityRef.current === recovery.identity) {
          setPosts(items)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled && feedRequestIdentityRef.current === recovery.identity) {
          setLoadingFeed(false)
        }
      })
    return () => { cancelled = true }
  }, [initialPosts.length])

  const reloadSubs = async () => setSubs(await listXSubscriptions().catch(() => []))

  const reloadPosts = async (sel: Selection = selection, h: number = hours) => {
    if (sel.kind === 'search') return
    const requestIdentity = feedRequestIdentityRef.current + 1
    feedRequestIdentityRef.current = requestIdentity
    setLoadingFeed(true)
    try {
      const items = await listXPosts({
        subscription_id: sel.kind === 'sub' ? sel.id : undefined,
        hours: h,
      })
      if (feedRequestIdentityRef.current === requestIdentity) setPosts(items)
    } catch {
      // silent
    } finally {
      if (feedRequestIdentityRef.current === requestIdentity) setLoadingFeed(false)
    }
  }

  const selectFeed = (next: Selection) => {
    setSelection(next)
    void reloadPosts(next, hours)
  }

  const selectHours = (next: number) => {
    setHours(next)
    void reloadPosts(selection, next)
  }

  const handleAdd = async (input: CreateXSubscriptionInput) => {
    await createXSubscription(input)
    await Promise.all([reloadSubs(), reloadPosts()])
    toast.success('订阅已添加')
  }

  const handleSaveSubscription = async (id: number, body: XSubscriptionPatch) => {
    await patchXSubscription(id, body)
    await reloadSubs()
    toast.success('订阅设置已保存')
  }

  const handleDelete = async (subscription: XSubscription) => {
    await deleteXSubscription(subscription.id)
    let nextSelection = selection
    if (selection.kind === 'sub' && selection.id === subscription.id) {
      nextSelection = { kind: 'all' }
      setSelection(nextSelection)
    }
    await Promise.all([reloadSubs(), reloadPosts(nextSelection)])
  }

  const handleCollectOne = async (subscription: XSubscription) => {
    try {
      const result = await collectXSubscription(subscription.id)
      toast.success(`@${subscription.label}：新增 ${result.new_posts} 帖`)
      await Promise.all([reloadSubs(), reloadPosts()])
    } catch (error) {
      toast.error((error as Error).message || '采集失败')
    }
  }

  const handleBackfill = async (subscription: XSubscription, days: number) => {
    const result = await backfillXSubscription(subscription.id, days)
    toast.success(`@${subscription.label}：回溯 ${days} 天，新增 ${result.new_posts} 帖`)
    await Promise.all([reloadSubs(), reloadPosts()])
  }

  const handleIngestExisting = async (subscription: XSubscription, days: number) => {
    const result = await backfillXSubscriptionIngestion(subscription.id, days)
    if (result.candidate_count === 0) {
      toast.success(`@${subscription.label}：最近 ${days} 天没有待处理的帖子（已跳过 ${result.skipped_count} 条）`)
    } else {
      toast.success(
        `@${subscription.label}：待处理 ${result.candidate_count} 条，跳过 ${result.skipped_count} 条，已创建 ${result.created} 个任务`,
      )
    }
    await Promise.all([reloadSubs(), reloadPosts()])
  }

  const handleCollectAll = async () => {
    setCollectingAll(true)
    try {
      const result = await collectAllXSubscriptions()
      toast.success(
        `已采集 ${result.checked} 源，新增 ${result.new_posts} 帖`
        + (result.failed.length ? `（${result.failed.length} 源失败）` : ''),
      )
      await Promise.all([reloadSubs(), reloadPosts()])
    } catch (error) {
      toast.error((error as Error).message || '采集失败')
    } finally {
      setCollectingAll(false)
    }
  }

  const selectedSub = useMemo(() => {
    if (selection.kind !== 'sub') return null
    return subs.find(subscription => subscription.id === selection.id) ?? null
  }, [selection, subs])

  const totalPostCount = useMemo(
    () => subs.reduce((sum, subscription) => sum + subscription.post_count, 0),
    [subs],
  )

  const headerTitle =
    selection.kind === 'all' ? 'X 订阅 · 全部' :
    selection.kind === 'search' ? '实时搜索' :
    selectedSub?.label || '订阅'

  return (
    <div className="flex h-full">
      <div className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-[var(--app-header-height)] min-h-[var(--app-header-height)] items-center border-b border-border px-3 py-3">
          <p className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">X 订阅</p>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <SidebarRow
            icon={Search}
            iconColor="text-emerald-500"
            label="实时搜索"
            active={selection.kind === 'search'}
            onClick={() => selectFeed({ kind: 'search' })}
          />
          <div className="mb-1 mt-3 px-2 text-[11px] uppercase tracking-wider text-foreground-subtle">
            已订阅 · {subs.length}
          </div>
          <SidebarRow
            icon={Globe}
            iconColor="text-sky-500"
            label="全部"
            badge={totalPostCount > 0 ? String(totalPostCount) : undefined}
            active={selection.kind === 'all'}
            onClick={() => selectFeed({ kind: 'all' })}
          />
          {subs.length === 0 ? (
            <p className="mt-2 px-3 text-center text-xs text-foreground-subtle">点右上角「新增订阅」添加</p>
          ) : (
            subs.map(subscription => (
              <SidebarRow
                key={subscription.id}
                icon={Bird}
                iconColor={subscription.enabled ? 'text-sky-500' : 'text-foreground-subtle'}
                label={subscription.label}
                badge={subscription.post_count > 0 ? String(subscription.post_count) : undefined}
                active={selection.kind === 'sub' && selection.id === subscription.id}
                muted={!subscription.enabled}
                hasError={!!subscription.last_error}
                onClick={() => selectFeed({ kind: 'sub', id: subscription.id })}
                onEdit={() => setSubscriptionDialog({ mode: 'edit', subscription })}
              />
            ))
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-shrink-0 border-b border-border bg-surface">
          <div data-slot="page-header" className="flex h-[var(--app-header-height)] min-h-[var(--app-header-height)] items-center justify-between gap-4 overflow-hidden px-6">
            <div className="flex min-w-0 items-center gap-2">
              <Bird className="size-4 shrink-0 text-sky-500" />
              <span className="truncate text-sm font-medium text-foreground">{headerTitle}</span>
              {selection.kind !== 'search' ? (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground-subtle">{posts.length} 帖</span>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {selection.kind !== 'search' ? (
                <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={handleCollectAll} disabled={collectingAll}>
                  <RefreshCw className={cn('size-3.5', collectingAll && 'animate-spin')} />
                  {collectingAll ? '采集中…' : '立即采集'}
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => setSubscriptionDialog({ mode: 'create', subscription: null })}
              >
                <Plus className="size-3.5" />
                新增订阅
              </Button>
            </div>
          </div>

          {selection.kind !== 'search' ? (
            <div className="flex items-center gap-1 overflow-x-auto px-6 pb-3">
              <span className="mr-1 text-xs text-foreground-subtle">最近</span>
              {HOURS_OPTIONS.map(({ v, label }) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => selectHours(v)}
                  className={cn(
                    'rounded px-2 py-0.5 text-xs transition-colors',
                    hours === v
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted',
                  )}
                >
                  {label}
                </button>
              ))}
              {selectedSub?.last_error ? <span className="ml-3 truncate text-xs text-red-500">⚠ {selectedSub.last_error}</span> : null}
            </div>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {selection.kind === 'search'
            ? <SearchPanel />
            : <FeedPanel posts={posts} loading={loadingFeed} subsCount={subs.length} />}
        </div>
      </div>

      {subscriptionDialog ? (
        <XSubscriptionDialog
          key={`${subscriptionDialog.mode}-${subscriptionDialog.subscription?.id ?? 'new'}`}
          open
          mode={subscriptionDialog.mode}
          subscription={subscriptionDialog.subscription}
          onOpenChange={open => { if (!open) setSubscriptionDialog(null) }}
          onAdd={handleAdd}
          onSave={handleSaveSubscription}
          onDelete={handleDelete}
          onCollect={handleCollectOne}
          onBackfill={handleBackfill}
          onIngestExisting={handleIngestExisting}
        />
      ) : null}
    </div>
  )
}

function SidebarRow({
  icon: Icon,
  iconColor,
  label,
  badge,
  active,
  muted,
  hasError,
  onClick,
  onEdit,
}: {
  icon: typeof Bird
  iconColor: string
  label: string
  badge?: string
  active?: boolean
  muted?: boolean
  hasError?: boolean
  onClick: () => void
  onEdit?: () => void
}) {
  return (
    <div className={cn(
      'mb-0.5 flex w-full items-center gap-1 rounded transition-colors',
      active
        ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300'
        : 'hover:bg-surface-muted',
      muted && 'opacity-50',
    )}>
      <button type="button" onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left">
        <Icon className={cn('size-4 shrink-0', iconColor)} />
        <span className="flex-1 truncate text-xs font-medium">{label}</span>
        {hasError ? <span className="size-1.5 shrink-0 rounded-full bg-red-500" /> : null}
        {badge ? <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-foreground-subtle">{badge}</span> : null}
      </button>
      {onEdit ? (
        <button
          type="button"
          aria-label={`编辑订阅：${label}`}
          title={`编辑订阅：${label}`}
          onClick={event => {
            event.stopPropagation()
            onEdit()
          }}
          className="mr-1 rounded p-1 text-foreground-subtle transition-colors hover:bg-muted hover:text-sky-500"
        >
          <Pencil className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

function FeedPanel({ posts, loading, subsCount }: { posts: XPost[]; loading: boolean; subsCount: number }) {
  if (loading && posts.length === 0) return <div className="flex h-32 items-center justify-center text-sm text-foreground-subtle">加载中…</div>
  if (posts.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 text-foreground-subtle">
        <Bird className="size-10 text-sky-500 opacity-20" />
        <p className="text-sm">{subsCount === 0 ? '点右上角「新增订阅」添加 X URL 开始' : '该范围暂无帖子，试试「立即采集」或换时间窗'}</p>
      </div>
    )
  }
  return <div className="max-w-3xl space-y-2">{posts.map(post => <PostCard key={post.tweet_id} post={post} />)}</div>
}

function SearchPanel() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<XSearchPost[]>([])
  const [error, setError] = useState('')

  const run = async () => {
    const trimmed = query.trim()
    if (!trimmed) return
    setLoading(true)
    setError('')
    setResults([])
    try {
      setResults(await searchX(trimmed))
    } catch (cause) {
      setError((cause as Error).message || '搜索失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center gap-2 text-xs text-foreground-subtle"><ListFilter className="size-3.5" /><span>实时通过 feedgrab 查询 X · 结果不入库</span></div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle" />
          <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="输入关键词，例如：AI agent" className="h-8 pl-8 text-sm" onKeyDown={event => { if (event.key === 'Enter') void run() }} />
        </div>
        <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void run()} disabled={loading}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
          搜索
        </Button>
      </div>
      {error ? <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">{error}</div> : null}
      {results.length > 0 ? <div className="space-y-2"><p className="text-xs text-foreground-subtle">{results.length} 条结果</p>{results.map(post => <PostCard key={post.tweet_id} post={post} />)}</div> : null}
      {!loading && !error && results.length === 0 ? <p className="text-xs text-foreground-subtle">输入关键词后回车搜索</p> : null}
    </div>
  )
}

function PostCard({ post }: { post: XPost | XSearchPost }) {
  const avatar = post.author_avatar || `https://unavatar.io/x/${post.username}`
  const sourceUrl = externalHttpUrl(post.url)

  return (
      <div className="rounded-lg border border-border bg-surface px-4 py-3 transition-colors hover:bg-surface-muted">
      <div className="flex items-start gap-3">
        <a href={`https://x.com/${post.username}`} target="_blank" rel="noreferrer" className="shrink-0">
          <img src={avatar} alt={post.username} loading="lazy" referrerPolicy="no-referrer" className="size-10 rounded-full bg-muted object-cover" onError={event => { event.currentTarget.style.visibility = 'hidden' }} />
        </a>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex min-w-0 items-center gap-1.5 text-sm">
              <span className="truncate font-medium text-foreground">{post.display_name || post.username}</span>
              <span className="truncate text-xs text-foreground-subtle">@{post.username}</span>
            </div>
            {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-1 text-xs text-foreground-subtle hover:text-sky-500" title={fmtDateTime(post.published_at)}>{fmtRelTime(post.published_at)}<ExternalLink className="size-3" /></a> : <span className="shrink-0 text-xs text-foreground-subtle" title={fmtDateTime(post.published_at)}>{fmtRelTime(post.published_at)}</span>}
          </div>
          <p className="mb-2 whitespace-pre-wrap text-sm text-foreground">{post.content}</p>
          {post.cover_image && sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer" className="mb-2 block overflow-hidden rounded-lg border border-border"><img src={post.cover_image} alt="" loading="lazy" referrerPolicy="no-referrer" className="block h-auto max-h-[420px] max-w-full object-contain w-auto" onError={event => { (event.currentTarget.parentElement as HTMLElement).style.display = 'none' }} /></a> : null}
          <div className="flex items-center gap-4 text-xs text-foreground-subtle">
            <span className="flex items-center gap-1"><Eye className="size-3" />{post.views.toLocaleString()}</span>
            <span className="flex items-center gap-1"><Repeat2 className="size-3" />{post.reposts.toLocaleString()}</span>
            <span className="flex items-center gap-1"><Heart className="size-3" />{post.likes.toLocaleString()}</span>
            <span className="flex items-center gap-1"><MessageSquare className="size-3" />{post.replies.toLocaleString()}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
