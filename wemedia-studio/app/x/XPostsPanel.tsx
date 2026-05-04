'use client'

import { useState, useCallback, useMemo } from 'react'
import { RefreshCw, MessageCircle, Heart, Eye, Repeat2, ExternalLink, TrendingUp, Loader2, Flame, Users } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { XPost, XMetricsPoint, getXPosts } from '@/lib/api/x'

// ── Sparkline ──────────────────────────────────────────────────────────────────

function Sparkline({
  data,
  color = '#6366f1',
  width = 64,
  height = 22,
}: {
  data: number[]
  color?: string
  width?: number
  height?: number
}) {
  if (data.length < 2) {
    return <span className="inline-block w-[64px] h-[22px]" />
  }
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pad = 2

  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2)
    const y = pad + ((max - v) / range) * (height - pad * 2)
    return `${x},${y}`
  })
  const d = `M ${pts.join(' L ')}`

  return (
    <svg width={width} height={height} className="overflow-visible">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      {/* Highlight last point */}
      <circle
        cx={pts[pts.length - 1].split(',')[0]}
        cy={pts[pts.length - 1].split(',')[1]}
        r={2.5}
        fill={color}
      />
    </svg>
  )
}

// ── Metric cell ────────────────────────────────────────────────────────────────

function MetricCell({
  icon: Icon,
  value,
  history,
  color,
  label,
}: {
  icon: React.ElementType
  value: number
  history: number[]
  color: string
  label: string
}) {
  const trend = history.length >= 2
    ? history[history.length - 1] - history[history.length - 2]
    : 0

  return (
    <div className="flex flex-col items-center gap-0.5 min-w-[72px]">
      <div className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
        <Icon className="w-3 h-3" />
        <span className="text-[10px]">{label}</span>
      </div>
      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {formatCount(value)}
      </span>
      <div className="flex items-center gap-1">
        <Sparkline data={history.length ? history : [value]} color={color} />
        {trend !== 0 && (
          <span className={cn('text-[9px] font-medium', trend > 0 ? 'text-emerald-500' : 'text-red-400')}>
            {trend > 0 ? '+' : ''}{formatCount(trend)}
          </span>
        )}
      </div>
    </div>
  )
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatRelTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return `${Math.round(diff)}s 前`
  if (diff < 3600) return `${Math.round(diff / 60)}m 前`
  if (diff < 86400) return `${Math.round(diff / 3600)}h 前`
  return `${Math.round(diff / 86400)}d 前`
}

// ── Main panel ─────────────────────────────────────────────────────────────────

const HOURS_OPTIONS = [2, 6, 12, 24] as const
type PostFilter = 'all' | 'viral'
const VIRAL_RATIO = 1.5

export function XPostsPanel({ initialPosts }: { initialPosts: XPost[] }) {
  const [posts, setPosts] = useState<XPost[]>(initialPosts)
  const [hours, setHours] = useState<number>(24)
  const [filter, setFilter] = useState<PostFilter>('all')
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async (h = hours) => {
    setRefreshing(true)
    try {
      const fresh = await getXPosts(h)
      setPosts(fresh)
    } catch {
      toast.error('刷新失败')
    } finally {
      setRefreshing(false)
    }
  }, [hours])

  const handleHours = (h: number) => {
    setHours(h)
    refresh(h)
  }

  const viralCount = useMemo(() => posts.filter(p => p.is_viral).length, [posts])

  // Sort by views desc so hottest posts float up
  const sorted = useMemo(() => {
    const base = filter === 'viral' ? posts.filter(p => p.is_viral) : posts
    return [...base].sort((a, b) => b.latest_views - a.latest_views)
  }, [posts, filter])

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Time range */}
        <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-sm">
          {HOURS_OPTIONS.map(h => (
            <button
              key={h}
              onClick={() => handleHours(h)}
              className={cn(
                'px-3 py-1.5 transition-colors',
                hours === h
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
              )}
            >
              {h}h
            </button>
          ))}
        </div>

        {/* Viral filter */}
        <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-sm">
          <button
            onClick={() => setFilter('all')}
            className={cn(
              'px-3 py-1.5 transition-colors',
              filter === 'all'
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
            )}
          >
            全部
            <span className="ml-1.5 text-xs opacity-60">{posts.length}</span>
          </button>
          <button
            onClick={() => setFilter('viral')}
            className={cn(
              'flex items-center gap-1 px-3 py-1.5 transition-colors',
              filter === 'viral'
                ? 'bg-orange-500 text-white'
                : 'text-zinc-500 hover:text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-950/30 dark:hover:text-orange-400'
            )}
          >
            <Flame className="w-3 h-3" />
            超粉丝浏览
            <span className="ml-1 text-xs opacity-60">{viralCount}</span>
          </button>
        </div>

        <span className="text-xs text-zinc-400">浏览量 &gt; 粉丝数 × {VIRAL_RATIO} 视为超粉丝浏览</span>
        <Button variant="outline" size="sm" onClick={() => refresh()} disabled={refreshing} className="ml-auto">
          <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', refreshing && 'animate-spin')} />
          刷新
        </Button>
      </div>

      {/* Post list */}
      {sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-400">
          {filter === 'viral'
            ? <Flame className="w-10 h-10 mb-3 opacity-30" />
            : <TrendingUp className="w-10 h-10 mb-3 opacity-30" />}
          <p className="text-sm">
            {filter === 'viral' ? '暂无超粉丝浏览帖子' : '暂无帖子数据'}
          </p>
          <p className="text-xs mt-1">
            {filter === 'viral'
              ? `浏览量超过粉丝数 ${VIRAL_RATIO} 倍的帖子会在这里显示`
              : '采集任务运行后将自动收录近期帖子'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map(post => {
            const repliesHistory  = post.metrics_history.map(m => m.replies)
            const repostsHistory  = post.metrics_history.map(m => m.reposts)
            const likesHistory    = post.metrics_history.map(m => m.likes)
            const viewsHistory    = post.metrics_history.map(m => m.views)

            return (
              <div
                key={post.tweet_id}
                className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 flex gap-4 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
              >
                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <a
                      href={`https://x.com/${post.username}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100"
                    >
                      {post.display_name || `@${post.username}`}
                    </a>
                    {post.display_name && (
                      <span className="text-[10px] text-zinc-400">@{post.username}</span>
                    )}
                    {post.author_followers > 0 && (
                      <span className="text-[10px] text-zinc-400 flex items-center gap-0.5">
                        <Users className="w-2.5 h-2.5" />
                        {formatCount(post.author_followers)}
                      </span>
                    )}
                    <span className="text-[10px] text-zinc-400">{formatRelTime(post.published_at)}</span>
                    {post.is_viral && (
                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-orange-100 dark:bg-orange-950/50 text-orange-600 dark:text-orange-400 text-[10px] font-medium">
                        <Flame className="w-2.5 h-2.5" />
                        超粉丝浏览
                        {post.author_followers > 0 && (
                          <span className="opacity-70 ml-0.5">
                            ×{(post.latest_views / post.author_followers).toFixed(1)}
                          </span>
                        )}
                      </span>
                    )}
                    {post.metrics_history.length > 1 && (
                      <span className="text-[10px] text-indigo-400 flex items-center gap-0.5">
                        <TrendingUp className="w-2.5 h-2.5" />
                        {post.metrics_history.length} 次记录
                      </span>
                    )}
                    <a
                      href={post.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-auto text-zinc-300 hover:text-zinc-500 transition-colors flex-shrink-0"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                  <p className="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-3 leading-relaxed">
                    {post.content || <span className="italic text-zinc-400">（无文字内容）</span>}
                  </p>
                </div>

                {/* Metrics with sparklines */}
                <div className="flex items-center gap-5 flex-shrink-0 border-l border-zinc-100 dark:border-zinc-800 pl-4">
                  <MetricCell
                    icon={MessageCircle}
                    value={post.latest_replies}
                    history={repliesHistory}
                    color="#8b5cf6"
                    label="回复"
                  />
                  <MetricCell
                    icon={Repeat2}
                    value={post.latest_reposts}
                    history={repostsHistory}
                    color="#10b981"
                    label="转发"
                  />
                  <MetricCell
                    icon={Heart}
                    value={post.latest_likes}
                    history={likesHistory}
                    color="#ec4899"
                    label="点赞"
                  />
                  <MetricCell
                    icon={Eye}
                    value={post.latest_views}
                    history={viewsHistory}
                    color="#0ea5e9"
                    label="阅读"
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
