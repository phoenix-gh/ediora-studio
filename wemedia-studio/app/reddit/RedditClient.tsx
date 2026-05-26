'use client'

import { useState, useMemo, useCallback } from 'react'
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
              'hover:bg-zinc-50 dark:hover:bg-zinc-900',
              s.muted && 'opacity-50',
            )}>
              <Hash className="w-3.5 h-3.5 text-orange-500 shrink-0" />
              <span className="flex-1 font-medium truncate">{s.label}</span>
              <span className="text-zinc-400 text-xs">{s.post_count} 帖</span>
              {actingId === s.id
                ? <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
                : <>
                  <button
                    onClick={() => wrap(s, onCollect)}
                    className="text-zinc-400 hover:text-blue-500"
                    title="立即采集"
                  ><RefreshCw className="w-3.5 h-3.5" /></button>
                  <button
                    onClick={() => wrap(s, onMute)}
                    className="text-zinc-400 hover:text-yellow-500"
                    title={s.muted ? '取消静音' : '静音'}
                  >{s.muted ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}</button>
                  <button
                    onClick={() => wrap(s, onDelete)}
                    className="text-zinc-400 hover:text-red-500"
                    title="删除"
                  ><Trash2 className="w-3.5 h-3.5" /></button>
                </>
              }
            </div>
          ))}
          {subs.length === 0 && (
            <p className="text-center text-zinc-400 text-sm py-6">还没有订阅任何版块</p>
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
        'w-full text-left px-4 py-3 border-b border-zinc-100 dark:border-zinc-800',
        'hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors',
        active && 'bg-indigo-50 dark:bg-indigo-950/30',
      )}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium line-clamp-2 text-zinc-900 dark:text-zinc-100 leading-snug">
            {post.title}
          </p>
          <div className="flex items-center gap-3 mt-1.5 text-xs text-zinc-400">
            <span className="flex items-center gap-0.5">
              <ArrowUp className="w-3 h-3" />{post.score.toLocaleString()}
            </span>
            <span className="flex items-center gap-0.5">
              <MessageCircle className="w-3 h-3" />{post.comment_count}
            </span>
            <span className="text-zinc-300">r/{post.subreddit}</span>
            {post.flair && (
              <span className="px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400">
                {post.flair}
              </span>
            )}
            <span>{fmtRelTime(post.published_at)}</span>
          </div>
        </div>
        {!post.is_self && post.linked_url && (
          <ExternalLink className="w-3.5 h-3.5 text-zinc-300 shrink-0 mt-0.5" />
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
  }, [selectedSubId])

  const reloadSubs = useCallback(async () => {
    const s = await getRedditSubscriptions().catch(() => subs)
    setSubs(s)
  }, [])

  async function handleRefreshAll() {
    setRefreshing(true)
    try {
      await collectRedditAll()
      toast.success('采集任务已启动')
      setTimeout(async () => {
        await reloadSubs()
        await reloadPosts()
      }, 3000)
    } catch {
      toast.error('采集失败')
    } finally {
      setRefreshing(false)
    }
  }

  async function handleAdd(body: { subreddit: string; label?: string }) {
    await addRedditSubscription(body)
    await reloadSubs()
    await reloadPosts()
    toast.success(`已订阅 r/${body.subreddit}`)
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
    toast.success(`已触发 r/${s.subreddit} 采集`)
    setTimeout(async () => {
      await reloadSubs()
      await reloadPosts()
    }, 4000)
  }

  const readerMeta: ReaderMeta | null = readerPost
    ? {
        title: readerPost.title,
        url: readerPost.url,
        author: `u/${readerPost.author}`,
        published_at: readerPost.published_at,
        content: readerPost.content,
      }
    : null

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Left sidebar */}
      <aside className="w-52 shrink-0 border-r border-zinc-200 dark:border-zinc-800 flex flex-col overflow-hidden">
        <div className="px-3 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2">
          <span className="font-semibold text-sm flex-1">Reddit</span>
          <button
            onClick={handleRefreshAll}
            disabled={refreshing}
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            title="全量采集"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
          </button>
          <button
            onClick={() => setDialogOpen(true)}
            className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
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
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900',
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
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900',
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
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
          <div className="flex rounded-md overflow-hidden border border-zinc-200 dark:border-zinc-700 text-xs">
            {(['hot', 'new'] as RedditView[]).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  'px-3 py-1.5 flex items-center gap-1',
                  view === v
                    ? 'bg-indigo-600 text-white'
                    : 'text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800',
                )}
              >
                {v === 'hot' ? <TrendingUp className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
                {v === 'hot' ? 'Hot' : 'New'}
              </button>
            ))}
          </div>
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索标题…"
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-zinc-200 dark:border-zinc-700 rounded-md bg-transparent outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <span className="text-xs text-zinc-400">{filteredPosts.length} 帖</span>
        </div>

        {/* Post list */}
        <div className="flex-1 overflow-y-auto">
          {visiblePosts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-zinc-400 text-sm gap-2">
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
                    summary={post.content}
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
