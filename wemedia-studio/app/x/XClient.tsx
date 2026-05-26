'use client'

import { useEffect, useState } from 'react'
import { RefreshCw, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import {
  type XSubscription,
  type XPost,
  type XSearchPost,
  listXSubscriptions,
  createXSubscription,
  patchXSubscription,
  deleteXSubscription,
  collectXSubscription,
  collectAllXSubscriptions,
  listXPosts,
  searchX,
} from '@/lib/api/x'

type TabKey = 'subs' | 'search'

export function XClient({
  initialSubs,
  initialPosts,
}: {
  initialSubs: XSubscription[]
  initialPosts: XPost[]
}) {
  const [tab, setTab] = useState<TabKey>('subs')

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      {/* Tab bar */}
      <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-sm w-fit">
        {([
          { key: 'subs', label: '订阅' },
          { key: 'search', label: '实时搜索' },
        ] as { key: TabKey; label: string }[]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2 transition-colors',
              tab === t.key
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'subs' && (
        <SubscriptionsTab initialSubs={initialSubs} initialPosts={initialPosts} />
      )}
      {tab === 'search' && <SearchTab />}
    </div>
  )
}

function SearchTab() {
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<XSearchPost[]>([])
  const [error, setError] = useState<string>('')

  const run = async () => {
    const trimmed = q.trim()
    if (!trimmed) return
    setLoading(true)
    setError('')
    setResults([])
    try {
      setResults(await searchX(trimmed))
    } catch (e) {
      setError((e as Error).message || '搜索失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* hint */}
      <p className="text-sm text-zinc-400 dark:text-zinc-500">
        实时通过 feedgrab 查询 X，结果不会保存到数据库
      </p>

      {/* search input */}
      <div className="flex gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="输入关键词，例如：AI agent"
          className="flex-1 h-8 text-sm"
          onKeyDown={(e) => { if (e.key === 'Enter') run() }}
        />
        <Button size="sm" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
          搜索
        </Button>
      </div>

      {/* error */}
      {error && (
        <div className="rounded border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* results */}
      {results.length === 0 ? (
        !loading && !error && (
          <p className="text-sm text-zinc-400">还没有结果，输入关键词后搜索</p>
        )
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <div className="px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
            <span className="text-xs text-zinc-400">结果 ({results.length})</span>
          </div>
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {results.map((p) => (
              <SearchResultCard key={p.tweet_id} post={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SearchResultCard({ post: p }: { post: XSearchPost }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-1">
        <div className="text-sm">
          <span className="font-medium text-zinc-800 dark:text-zinc-200">
            {p.display_name || p.username}
          </span>{' '}
          <span className="text-zinc-400">@{p.username}</span>
        </div>
        <div className="text-xs text-zinc-400">
          {new Date(p.published_at).toLocaleString()}
        </div>
      </div>
      <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap mb-1">
        {p.content}
      </p>
      <div className="text-xs text-zinc-400">
        浏览 {p.views.toLocaleString()} · 转发 {p.reposts} · 点赞 {p.likes} · 回复 {p.replies}
        <a
          href={p.url}
          target="_blank"
          rel="noreferrer"
          className="ml-3 text-blue-500 hover:underline"
        >
          查看原推
        </a>
      </div>
    </div>
  )
}

function SubscriptionsTab({
  initialSubs,
  initialPosts,
}: {
  initialSubs: XSubscription[]
  initialPosts: XPost[]
}) {
  const [subs, setSubs] = useState<XSubscription[]>(initialSubs)
  const [posts, setPosts] = useState<XPost[]>(initialPosts)
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [filterSub, setFilterSub] = useState<string>('all')
  const [hours, setHours] = useState<string>('168')
  const [loadingFeed, setLoadingFeed] = useState(false)

  const reloadSubs = async () => {
    setSubs(await listXSubscriptions().catch(() => []))
  }

  const reloadPosts = async (subId?: number, h?: number) => {
    setLoadingFeed(true)
    try {
      setPosts(
        await listXPosts({
          subscription_id: subId,
          hours: h,
        }),
      )
    } catch {
      // silent
    } finally {
      setLoadingFeed(false)
    }
  }

  useEffect(() => {
    const subId = filterSub === 'all' ? undefined : Number(filterSub)
    reloadPosts(subId, Number(hours))
  }, [filterSub, hours])

  const add = async () => {
    const trimmed = url.trim()
    if (!trimmed) return
    setAdding(true)
    try {
      await createXSubscription(trimmed)
      setUrl('')
      await Promise.all([reloadSubs(), reloadPosts(undefined, Number(hours))])
      toast.success('订阅已添加')
    } catch (e) {
      toast.error((e as Error).message || '添加失败')
    } finally {
      setAdding(false)
    }
  }

  const collectAll = async () => {
    try {
      const r = await collectAllXSubscriptions()
      toast.success(
        `已采集 ${r.checked} 源，新增 ${r.new_posts} 帖${r.failed.length ? `（${r.failed.length} 源失败）` : ''}`,
      )
      await Promise.all([reloadSubs(), reloadPosts(undefined, Number(hours))])
    } catch (e) {
      toast.error((e as Error).message || '采集失败')
    }
  }

  const afterAction = async () => {
    const subId = filterSub === 'all' ? undefined : Number(filterSub)
    await Promise.all([reloadSubs(), reloadPosts(subId, Number(hours))])
  }

  return (
    <div className="space-y-5">
      {/* Add subscription */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
        <h2 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">添加订阅</h2>
        <div className="flex gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://x.com/username  或  https://x.com/i/lists/{id}"
            className="flex-1 h-8 text-sm"
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <Button size="sm" onClick={add} disabled={adding}>
            {adding ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : null}
            添加
          </Button>
        </div>
      </div>

      {/* Subscription list */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            订阅列表 ({subs.length})
          </span>
          <Button variant="outline" size="sm" onClick={collectAll}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
            全部采集
          </Button>
        </div>
        {subs.length === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-400">还没有订阅</div>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {subs.map((s) => (
              <SubscriptionRow key={s.id} sub={s} onAfterAction={afterAction} />
            ))}
          </div>
        )}
      </div>

      {/* Post feed */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
          <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            帖子流 ({posts.length}){loadingFeed ? ' · 加载中…' : ''}
          </span>
          <div className="flex gap-2">
            <Select value={filterSub} onValueChange={(v) => setFilterSub(v ?? 'all')}>
              <SelectTrigger size="sm" className="w-36">
                <SelectValue placeholder="全部订阅" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部订阅</SelectItem>
                {subs.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={hours} onValueChange={(v) => setHours(v ?? '168')}>
              <SelectTrigger size="sm" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="24">24h</SelectItem>
                <SelectItem value="168">7d</SelectItem>
                <SelectItem value="720">30d</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {posts.length === 0 ? (
          <div className="py-12 text-center text-sm text-zinc-400">暂无帖子</div>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {posts.map((p) => (
              <PostCard key={p.tweet_id} post={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SubscriptionRow({
  sub,
  onAfterAction,
}: {
  sub: XSubscription
  onAfterAction: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)

  const handleCollect = async () => {
    setBusy(true)
    try {
      const r = await collectXSubscription(sub.id)
      toast.success(`新增 ${r.new_posts} 帖`)
      await onAfterAction()
    } catch (e) {
      toast.error((e as Error).message || '采集失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm(`删除订阅「${sub.label}」？关联帖子也会被清掉。`)) return
    try {
      await deleteXSubscription(sub.id)
      await onAfterAction()
    } catch (e) {
      toast.error((e as Error).message || '删除失败')
    }
  }

  const handleToggle = async (checked: boolean) => {
    try {
      await patchXSubscription(sub.id, { enabled: checked })
      await onAfterAction()
    } catch (e) {
      toast.error((e as Error).message || '更新失败')
    }
  }

  return (
    <div className="flex gap-3 items-center px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{sub.label}</div>
        <div className="text-xs text-zinc-400 truncate">{sub.url}</div>
        {sub.last_error && (
          <div className="text-xs text-red-500 mt-0.5">{sub.last_error}</div>
        )}
      </div>
      <div className="text-xs text-zinc-400 text-right shrink-0 min-w-[100px]">
        {sub.post_count} 帖<br />
        {sub.last_collected_at
          ? new Date(sub.last_collected_at).toLocaleString()
          : '未采集'}
      </div>
      <Switch checked={sub.enabled} onCheckedChange={handleToggle} />
      <Button size="sm" variant="outline" onClick={handleCollect} disabled={busy}>
        {busy && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
        采集
      </Button>
      <Button size="sm" variant="outline" onClick={handleDelete} className="text-red-600 hover:text-red-700 border-red-200 hover:border-red-300 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950">
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
    </div>
  )
}

function PostCard({ post: p }: { post: XPost }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between mb-1">
        <div className="text-sm">
          <span className="font-medium text-zinc-800 dark:text-zinc-200">
            {p.display_name || p.username}
          </span>{' '}
          <span className="text-zinc-400">@{p.username}</span>
        </div>
        <div className="text-xs text-zinc-400">
          {new Date(p.published_at).toLocaleString()}
        </div>
      </div>
      <p className="text-sm text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap mb-1">
        {p.content}
      </p>
      <div className="text-xs text-zinc-400">
        浏览 {p.views.toLocaleString()} · 转发 {p.reposts} · 点赞 {p.likes} · 回复 {p.replies}
        <a
          href={p.url}
          target="_blank"
          rel="noreferrer"
          className="ml-3 text-blue-500 hover:underline"
        >
          查看原推
        </a>
      </div>
    </div>
  )
}
