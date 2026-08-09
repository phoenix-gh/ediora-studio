'use client'

import { useState, useMemo, useCallback } from 'react'
import { marked } from 'marked'
import {
  Hash, RefreshCw, Trash2, Volume2, VolumeX, ExternalLink,
  Search, MessageCircle, Loader2, Settings, TrendingUp, Clock, ArrowUp,
} from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  RedditSubscription, RedditPost, RedditView,
  getRedditSubscriptions, getRedditPosts,
  addRedditSubscription, updateRedditSubscription, deleteRedditSubscription,
  collectRedditAll, collectRedditSubscription,
} from '@/lib/api/reddit'
import { AddToTopicPopover } from '@/components/features/AddToTopicPopover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ResponsiveArticleReader, ReaderMeta } from '@/components/features/ArticleReader'
import { useMediaQuery } from '@/lib/use-media-query'
import { fmtRelTime } from '@/lib/format'
import { useInfiniteScroll } from '@/lib/use-infinite-scroll'

const PAGE_SIZE = 30

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function buildStructuredPostText(post: RedditPost): string {
  const parts: string[] = []
  const body = post.body?.trim()
  const comments = Array.isArray(post.comments) ? post.comments : []

  if (body) {
    parts.push('## 正文')
    parts.push('')
    parts.push(body)
  }

  if (!post.is_self && post.linked_url) {
    if (parts.length > 0) parts.push('')
    parts.push(`[原始外链](${post.linked_url})`)
  }

  const renderedComments = comments
    .map((comment, index) => {
      const text = asText(comment.body)
      if (!text) return ''
      const author = asText(comment.author) || '[deleted]'
      const score = typeof comment.score === 'number' ? comment.score : 0
      return [`### #${index + 1} u/${author} · ${score} 分`, '', text].join('\n')
    })
    .filter(Boolean)

  if (renderedComments.length > 0) {
    if (parts.length > 0) parts.push('')
    parts.push('---')
    parts.push('')
    parts.push(`## 评论（Top ${renderedComments.length}）`)
    parts.push('')
    parts.push(renderedComments.join('\n\n'))
  }

  return parts.join('\n').trim() || post.content
}

function renderStructuredPostHtml(post: RedditPost): string {
  return marked(buildStructuredPostText(post)) as string
}

// ── Subscribe Dialog ───────────────────────────────────────────────────────────

function SubscribeDialog({
  open, onOpenChange, subs, onAdd, onMute, onDelete, onCollect,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  subs: RedditSubscription[]
  onAdd: (body: { subreddit: string; label?: string }) => Promise<void>
  onMute: (s: RedditSubscription) => Promise<void>
  onDelete: (s: RedditSubscription) => Promise<void>
  onCollect: (s: RedditSubscription) => Promise<void>
}) {
  const [subreddit, setSubreddit] = useState('')
  const [label, setLabel] = useState('')
  const [adding, setAdding] = useState(false)
  const [actingId, setActingId] = useState<number | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const sub = subreddit.trim().replace(/^r\//, '')
    if (!sub) return
    setAdding(true)
    try {
      await onAdd({ subreddit: sub, label: label.trim() || undefined })
      setSubreddit('')
      setLabel('')
    } finally {
      setAdding(false)
    }
  }

  async function wrap(s: RedditSubscription, fn: (x: RedditSubscription) => Promise<void>) {
    setActingId(s.id)
    try { await fn(s) } finally { setActingId(null) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>订阅管理 · Reddit</DialogTitle>
          <DialogDescription>
            输入版块名（如 programming 或 r/rust），系统每小时自动采集 hot + new 两榜。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-2">
          <div className="flex gap-2">
            <Input
              placeholder="版块名，如 programming"
              value={subreddit}
              onChange={e => setSubreddit(e.target.value)}
              className="flex-1"
            />
            <Input
              placeholder="自定义标签（可选）"
              value={label}
              onChange={e => setLabel(e.target.value)}
              className="w-36"
            />
            <Button type="submit" disabled={adding || !subreddit.trim()}>
              {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : '订阅'}
            </Button>
          </div>
        </form>

        <div className="space-y-1 max-h-80 overflow-y-auto">
          {subs.map(s => (
            <div key={s.id} className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-md text-sm',
              'hover:bg-surface-muted',
              s.muted && 'opacity-50',
            )}>
              <Hash className="w-3.5 h-3.5 text-orange-500 shrink-0" />
              <span className="flex-1 font-medium truncate">{s.label}</span>
              <span className="text-foreground-subtle text-xs">{s.post_count} 帖</span>
              {actingId === s.id
                ? <Loader2 className="w-3.5 h-3.5 animate-spin text-foreground-subtle" />
                : <>
                  <button
                    onClick={() => wrap(s, onCollect)}
                    className="text-foreground-subtle hover:text-blue-500"
                    title="立即采集"
                  ><RefreshCw className="w-3.5 h-3.5" /></button>
                  <button
                    onClick={() => wrap(s, onMute)}
                    className="text-foreground-subtle hover:text-yellow-500"
                    title={s.muted ? '取消静音' : '静音'}
                  >{s.muted ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}</button>
                  <button
                    onClick={() => wrap(s, onDelete)}
                    className="text-foreground-subtle hover:text-red-500"
                    title="删除"
                  ><Trash2 className="w-3.5 h-3.5" /></button>
                </>
              }
            </div>
          ))}
          {subs.length === 0 && (
            <p className="text-center text-foreground-subtle text-sm py-6">还没有订阅任何版块</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Post Card ─────────────────────────────────────────────────────────────────

function PostCard({
  post, active, onClick,
}: {
  post: RedditPost
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full text-left px-4 py-3 border-b border-border',
        'hover:bg-surface-muted transition-colors',
        active && 'bg-indigo-50 dark:bg-indigo-950/30',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium line-clamp-2 text-foreground leading-snug">
            {post.title}
          </p>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-foreground-subtle">
            <span className="flex items-center gap-0.5">
              <ArrowUp className="w-3 h-3" />{post.score.toLocaleString()}
            </span>
            <span className="flex items-center gap-0.5">
              <MessageCircle className="w-3 h-3" />{post.comment_count}
            </span>
            <span className="text-foreground-subtle">r/{post.subreddit}</span>
            {post.flair && (
              <span className="px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400">
                {post.flair}
              </span>
            )}
            <span>{fmtRelTime(post.published_at)}</span>
          </div>
        </div>
        {!post.is_self && post.linked_url && (
          <ExternalLink className="w-3.5 h-3.5 text-foreground-subtle shrink-0 mt-0.5" />
        )}
      </div>
    </button>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function RedditClient({
  initialSubs,
  initialPosts,
}: {
  initialSubs: RedditSubscription[]
  initialPosts: RedditPost[]
}) {
  const [subs, setSubs] = useState(initialSubs)
  const [allPosts, setAllPosts] = useState(initialPosts)
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null)
  const [view, setView] = useState<RedditView>('hot')
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [readerPost, setReaderPost] = useState<RedditPost | null>(null)
  const isMd = useMediaQuery('(min-width: 768px)')

  const filteredPosts = useMemo(() => {
    let list = selectedSubId != null
      ? allPosts.filter(p => p.subscription_id === selectedSubId)
      : allPosts
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(p => p.title.toLowerCase().includes(q))
    }
    list = [...list].sort((a, b) =>
      view === 'hot'
        ? b.score - a.score
        : new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
    )
    return list
  }, [allPosts, selectedSubId, view, search])

  const { visibleCount, sentinelRef } = useInfiniteScroll({
    totalCount: filteredPosts.length,
    pageSize: PAGE_SIZE,
  })
  const visiblePosts = filteredPosts.slice(0, visibleCount)

  const reloadPosts = useCallback(async () => {
    const posts = await getRedditPosts({
      view: 'all',
      days: 14,
      limit: 500,
      subscription_id: selectedSubId ?? undefined,
    }).catch(() => allPosts)
    setAllPosts(posts)
  }, [allPosts, selectedSubId])

  const reloadSubs = useCallback(async () => {
    const s = await getRedditSubscriptions().catch(() => subs)
    setSubs(s)
  }, [subs])

  // Poll every 10s until last_collected_at changes (max 3 min), then reload posts.
  function _pollUntilDone(before: { id: number; ts: string | null }[]) {
    const deadline = Date.now() + 3 * 60 * 1000
    const interval = setInterval(async () => {
      if (Date.now() > deadline) { clearInterval(interval); setRefreshing(false); return }
      const fresh = await getRedditSubscriptions().catch(() => null)
      if (!fresh) return
      setSubs(fresh)
      const changed = before.some(b => {
        const f = fresh.find(s => s.id === b.id)
        return f && f.last_collected_at !== b.ts
      })
      if (changed) {
        clearInterval(interval)
        await reloadPosts()
        setRefreshing(false)
        toast.success('采集完成，帖子已更新')
      }
    }, 10000)
  }

  async function handleRefreshAll() {
    setRefreshing(true)
    try {
      await collectRedditAll()
      toast.info('采集任务已启动，Reddit 需要 1-2 分钟，完成后自动刷新…')
      _pollUntilDone(subs.map(s => ({ id: s.id, ts: s.last_collected_at })))
    } catch {
      toast.error('采集失败')
      setRefreshing(false)
    }
  }

  async function handleAdd(body: { subreddit: string; label?: string }) {
    const sub = await addRedditSubscription(body)
    await reloadSubs()
    toast.info(`已订阅 r/${body.subreddit}，采集中，需要 1-2 分钟…`)
    setRefreshing(true)
    _pollUntilDone([{ id: sub.id, ts: sub.last_collected_at }])
  }

  async function handleMute(s: RedditSubscription) {
    await updateRedditSubscription(s.id, { muted: !s.muted })
    await reloadSubs()
    toast.success(s.muted ? '已取消静音' : '已静音')
  }

  async function handleDelete(s: RedditSubscription) {
    await deleteRedditSubscription(s.id)
    setSubs(prev => prev.filter(x => x.id !== s.id))
    setAllPosts(prev => prev.filter(x => x.subscription_id !== s.id))
    if (selectedSubId === s.id) setSelectedSubId(null)
    toast.success(`已删除 r/${s.subreddit}`)
  }

  async function handleCollect(s: RedditSubscription) {
    await collectRedditSubscription(s.id)
    toast.info(`r/${s.subreddit} 采集中，需要 1-2 分钟，完成后自动刷新…`)
    _pollUntilDone([{ id: s.id, ts: s.last_collected_at }])
  }

  const readerMeta: ReaderMeta | null = readerPost
    ? {
        title: readerPost.title,
        url: readerPost.url,
        author: `u/${readerPost.author}`,
        published_at: readerPost.published_at,
        content: renderStructuredPostHtml(readerPost),
      }
    : null

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left sidebar */}
      <aside className="w-52 shrink-0 border-r border-border flex flex-col overflow-hidden">
        <div className="flex h-[var(--app-header-height)] min-h-[var(--app-header-height)] items-center px-3 py-3 border-b border-border gap-2">
          <span className="font-semibold text-sm flex-1">Reddit</span>
          <button
            onClick={handleRefreshAll}
            disabled={refreshing}
            className="text-foreground-subtle hover:text-foreground"
            title="全量采集"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
          <button
            onClick={() => setDialogOpen(true)}
            className="text-foreground-subtle hover:text-foreground"
            title="管理订阅"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          <button
            onClick={() => setSelectedSubId(null)}
            className={cn(
              'w-full text-left px-3 py-2 text-sm rounded-md mx-1',
              selectedSubId === null
                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 font-medium'
                : 'text-muted-foreground hover:bg-surface-muted',
            )}
          >
            全部版块
          </button>
          {subs.map(s => (
            <button
              key={s.id}
              onClick={() => setSelectedSubId(s.id)}
              className={cn(
                'w-full text-left px-3 py-2 text-sm rounded-md mx-1 flex items-center gap-1.5',
                selectedSubId === s.id
                  ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300 font-medium'
                  : 'text-muted-foreground hover:bg-surface-muted',
                s.muted && 'opacity-40',
              )}
            >
              <Hash className="w-3 h-3 text-orange-500 shrink-0" />
              <span className="truncate flex-1">{s.label}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Post list */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div data-slot="page-header" className="flex h-[var(--app-header-height)] min-h-[var(--app-header-height)] items-center gap-2 px-4 py-2.5 border-b border-border bg-surface shrink-0">
          <div className="flex rounded-md overflow-hidden border border-input text-xs">
            {(['hot', 'new'] as RedditView[]).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  'px-3 py-1.5 flex items-center gap-1',
                  view === v
                    ? 'bg-indigo-600 text-white'
                    : 'text-muted-foreground hover:bg-muted',
                )}
              >
                {v === 'hot' ? <TrendingUp className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                {v === 'hot' ? 'Hot' : 'New'}
              </button>
            ))}
          </div>
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-foreground-subtle" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索标题…"
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-input rounded-md bg-control outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <span className="text-xs text-foreground-subtle">{filteredPosts.length} 帖</span>
        </div>

        {/* Post list */}
        <div className="flex-1 overflow-y-auto">
          {visiblePosts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-foreground-subtle text-sm gap-2">
              <Hash className="w-8 h-8 opacity-30" />
              <span>{subs.length === 0 ? '先在左侧订阅一个版块' : '暂无帖子，点击刷新按钮采集'}</span>
            </div>
          ) : (
            visiblePosts.map(post => (
              <div key={post.id} className="flex items-start">
                <div className="flex-1 min-w-0">
                  <PostCard
                    post={post}
                    active={readerPost?.id === post.id}
                    onClick={() => setReaderPost(post)}
                  />
                </div>
                <div className="shrink-0 flex items-center gap-1 px-2 pt-3">
                  <AddToTopicPopover
                    title={post.title}
                    summary={buildStructuredPostText(post)}
                    url={post.url}
                    platform="reddit"
                  />
                </div>
              </div>
            ))
          )}
          <div ref={sentinelRef} />
        </div>
      </main>

      {/* Article Reader */}
      <ResponsiveArticleReader
        asPanel={isMd}
        open={readerPost !== null}
        meta={readerMeta}
        onClose={() => setReaderPost(null)}
        accent="indigo"
      />

      <SubscribeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        subs={subs}
        onAdd={handleAdd}
        onMute={handleMute}
        onDelete={handleDelete}
        onCollect={handleCollect}
      />
    </div>
  )
}
