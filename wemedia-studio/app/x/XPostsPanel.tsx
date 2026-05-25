'use client'

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { RefreshCw, MessageCircle, Heart, Eye, Repeat2, ExternalLink, TrendingUp, Loader2, Flame, Users, PauseCircle, PlayCircle, Lightbulb, X as XIcon, PenLine, Check, BookMarked, ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { XPost, getXPosts } from '@/lib/api/x'
import { AddToTopicPopover } from '@/components/features/AddToTopicPopover'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api'

// ── Inspire modal ──────────────────────────────────────────────────────────────

function InspirationModal({
  post,
  onClose,
}: {
  post: XPost
  onClose: () => void
}) {
  const [loading, setLoading] = useState(true)
  const [analysis, setAnalysis] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setAnalysis('')
    setError('')
    fetch(`${API}/x/posts/${post.tweet_id}/inspire`, { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        if (data.ok) setAnalysis(data.analysis)
        else setError(data.detail || '分析失败')
      })
      .catch(e => { if (!cancelled) setError(String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [post.tweet_id])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 shadow-2xl border border-zinc-200 dark:border-zinc-700"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start gap-3 p-5 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
          <div className="w-8 h-8 rounded-full bg-amber-100 dark:bg-amber-950/60 flex items-center justify-center flex-shrink-0">
            <Lightbulb className="w-4 h-4 text-amber-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">内容灵感分析</p>
            <p className="text-[11px] text-zinc-400 mt-0.5 line-clamp-1">
              {post.display_name || `@${post.username}`} · {post.content.slice(0, 60)}{post.content.length > 60 ? '…' : ''}
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 flex-shrink-0">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-400 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-amber-400" />
              <p className="text-sm">正在分析帖子内容…</p>
            </div>
          ) : error ? (
            <div className="text-sm text-red-500 bg-red-50 dark:bg-red-950/30 rounded-lg p-4">{error}</div>
          ) : (
            <MarkdownLike text={analysis} />
          )}
        </div>
      </div>
    </div>
  )
}

function MarkdownLike({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <div className="space-y-1 text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed">
      {lines.map((line, i) => {
        if (line.startsWith('## ')) {
          return (
            <h3 key={i} className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mt-5 mb-2 first:mt-0">
              {line.slice(3)}
            </h3>
          )
        }
        if (line.startsWith('### ')) {
          return <h4 key={i} className="font-semibold text-zinc-800 dark:text-zinc-200 mt-3 mb-1">{line.slice(4)}</h4>
        }
        // Bold: **text**
        const parts = line.split(/(\*\*[^*]+\*\*)/)
        const rendered = parts.map((part, j) =>
          part.startsWith('**') && part.endsWith('**')
            ? <strong key={j} className="font-semibold text-zinc-900 dark:text-zinc-100">{part.slice(2, -2)}</strong>
            : part
        )
        if (line.startsWith('- ') || line.match(/^\d+\./)) {
          return <p key={i} className="pl-3 border-l-2 border-amber-300 dark:border-amber-700 py-0.5">{rendered}</p>
        }
        if (!line.trim()) return <div key={i} className="h-1" />
        return <p key={i}>{rendered}</p>
      })}
    </div>
  )
}

// ── Create article modal ───────────────────────────────────────────────────────

type CreateMode = 'secondary' | 'rewrite'

function CreateModal({ post, onClose }: { post: XPost; onClose: () => void }) {
  const [mode, setMode] = useState<CreateMode>('secondary')
  const [extraPrompt, setExtraPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !generating) onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, generating])

  async function handleGenerate() {
    setGenerating(true)
    setError('')
    setContent('')
    setTitle('')
    setSaved(false)
    try {
      const res = await fetch(`${API}/x/posts/${post.tweet_id}/create-article`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, extra_prompt: extraPrompt }),
      })
      const data = await res.json()
      if (data.ok) {
        setTitle(data.title)
        setContent(data.content)
      } else {
        setError(data.detail || '生成失败')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setGenerating(false)
    }
  }

  async function handleSaveDraft() {
    setSaving(true)
    try {
      const res = await fetch(`${API}/x/save-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, source_tweet_id: post.tweet_id }),
      })
      const data = await res.json()
      if (data.ok) {
        setSaved(true)
        toast.success(`已加入草稿箱：${data.title}`)
      } else {
        toast.error('保存失败')
      }
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const hasResult = Boolean(content)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => !generating && onClose()}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative z-10 w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white dark:bg-zinc-900 shadow-2xl border border-zinc-200 dark:border-zinc-700"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-100 dark:border-zinc-800 flex-shrink-0">
          <div className="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-950/60 flex items-center justify-center">
            <PenLine className="w-3.5 h-3.5 text-indigo-500" />
          </div>
          <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">基于帖子创作</span>
          <span className="text-xs text-zinc-400 truncate flex-1">
            {post.content.slice(0, 50)}{post.content.length > 50 ? '…' : ''}
          </span>
          <button onClick={onClose} disabled={generating} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-30">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Controls (always visible at top) */}
          <div className="p-5 space-y-4 border-b border-zinc-100 dark:border-zinc-800">
            {/* Mode selector */}
            <div className="flex gap-2">
              {([['secondary', '二创', '以此为灵感，独立原创'], ['rewrite', '改写', '保留核心观点，扩展细节']] as const).map(([key, label, desc]) => (
                <button
                  key={key}
                  type="button"
                  disabled={generating}
                  onClick={() => setMode(key)}
                  className={cn(
                    'flex-1 rounded-xl border px-4 py-3 text-left transition-all disabled:opacity-50',
                    mode === key
                      ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 dark:border-indigo-600'
                      : 'border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
                  )}
                >
                  <p className={cn('text-sm font-medium', mode === key ? 'text-indigo-700 dark:text-indigo-300' : 'text-zinc-700 dark:text-zinc-300')}>{label}</p>
                  <p className="text-[11px] text-zinc-400 mt-0.5">{desc}</p>
                </button>
              ))}
            </div>

            {/* Extra prompt */}
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500">追加提示词（可选）</label>
              <textarea
                value={extraPrompt}
                onChange={e => setExtraPrompt(e.target.value)}
                disabled={generating}
                placeholder="例：风格轻松幽默；重点讲技术细节；面向初学者；不超过500字…"
                rows={2}
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-none disabled:opacity-50"
              />
            </div>

            <Button onClick={handleGenerate} disabled={generating} size="sm" className="gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white border-0">
              {generating
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />生成中…</>
                : <><PenLine className="w-3.5 h-3.5" />{hasResult ? '重新生成' : '开始生成'}</>}
            </Button>
          </div>

          {/* Result area */}
          {error && (
            <div className="mx-5 mt-4 text-sm text-red-500 bg-red-50 dark:bg-red-950/30 rounded-lg p-4">{error}</div>
          )}

          {generating && !content && (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-400 gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-400" />
              <p className="text-sm">正在创作中，请稍候…</p>
            </div>
          )}

          {hasResult && (
            <div className="p-5 space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-500">标题</label>
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-zinc-500">正文（可编辑）</label>
                <textarea
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  rows={14}
                  className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-y"
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {hasResult && (
          <div className="flex items-center gap-3 px-5 py-3 border-t border-zinc-100 dark:border-zinc-800 flex-shrink-0 bg-zinc-50 dark:bg-zinc-800/50 rounded-b-2xl">
            <span className="text-xs text-zinc-400 flex-1">审核内容后可加入草稿箱</span>
            <Button
              onClick={handleSaveDraft}
              disabled={saving || saved}
              size="sm"
              variant={saved ? 'outline' : 'default'}
              className={cn('gap-1.5', saved && 'text-emerald-600 border-emerald-300 dark:border-emerald-700')}
            >
              {saved
                ? <><Check className="w-3.5 h-3.5" />已加入草稿箱</>
                : saving
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />保存中…</>
                  : <><BookMarked className="w-3.5 h-3.5" />加入草稿箱</>}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Metric cell ────────────────────────────────────────────────────────────────

function MetricCell({
  icon: Icon,
  value,
  color,
  label,
}: {
  icon: React.ElementType
  value: number
  color: string
  label: string
}) {
  return (
    <div className="flex flex-col items-center gap-0.5 min-w-[56px]">
      <div className="flex items-center gap-1 text-zinc-500 dark:text-zinc-400">
        <Icon className="w-3 h-3" style={{ color }} />
        <span className="text-[10px]">{label}</span>
      </div>
      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
        {formatCount(value)}
      </span>
    </div>
  )
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatRelTime(iso: string): string {
  const utc = /Z|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z'
  const diff = (Date.now() - new Date(utc).getTime()) / 1000
  if (diff < 60) return `${Math.round(diff)}s 前`
  if (diff < 3600) return `${Math.round(diff / 60)}m 前`
  if (diff < 86400) return `${Math.round(diff / 3600)}h 前`
  return `${Math.round(diff / 86400)}d 前`
}

// ── Main panel ─────────────────────────────────────────────────────────────────

const HOURS_OPTIONS = [2, 6, 12, 24] as const
type PostFilter = 'all' | 'viral'
type SortKey = 'views' | 'time' | 'replies' | 'likes' | 'reposts'
const VIRAL_RATIO = 1.5

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'time',    label: '时间' },
  { key: 'views',   label: '阅读' },
  { key: 'replies', label: '回复' },
  { key: 'likes',   label: '点赞' },
  { key: 'reposts', label: '转发' },
]

const AUTO_REFRESH_SEC = 30

export function XPostsPanel({ initialPosts }: { initialPosts: XPost[] }) {
  const [posts, setPosts] = useState<XPost[]>(initialPosts)
  const [hours, setHours] = useState<number>(24)
  const [filter, setFilter] = useState<PostFilter>('all')
  const [refreshing, setRefreshing] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(() => {
    if (typeof window === 'undefined') return true
    return localStorage.getItem('x_posts_auto_refresh') !== '0'
  })
  const [countdown, setCountdown] = useState(AUTO_REFRESH_SEC)
  const [sortBy, setSortBy] = useState<SortKey>('views')
  const [inspirePost, setInspirePost] = useState<XPost | null>(null)
  const [createPost, setCreatePost] = useState<XPost | null>(null)
  const hoursRef = useRef(hours)
  hoursRef.current = hours

  const refresh = useCallback(async (h?: number) => {
    setRefreshing(true)
    try {
      const fresh = await getXPosts(h ?? hoursRef.current)
      setPosts(fresh)
    } catch {
      toast.error('刷新失败')
    } finally {
      setRefreshing(false)
    }
  }, [])

  const handleHours = (h: number) => {
    setHours(h)
    refresh(h)
  }

  // Auto-refresh every 30s
  useEffect(() => {
    if (!autoRefresh) return
    setCountdown(AUTO_REFRESH_SEC)
    const tick = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          refresh()
          return AUTO_REFRESH_SEC
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(tick)
  }, [autoRefresh, refresh])

  const [page, setPage] = useState(1)
  const PAGE_SIZE = 20

  const viralCount = useMemo(() => posts.filter(p => p.is_viral).length, [posts])

  const sorted = useMemo(() => {
    const base = filter === 'viral' ? posts.filter(p => p.is_viral) : posts
    return [...base].sort((a, b) => {
      switch (sortBy) {
        case 'time':    return new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
        case 'replies': return b.latest_replies - a.latest_replies
        case 'likes':   return b.latest_likes - a.latest_likes
        case 'reposts': return b.latest_reposts - a.latest_reposts
        default:        return b.latest_views - a.latest_views
      }
    })
  }, [posts, filter, sortBy])

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const paginated = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  useEffect(() => { setPage(1) }, [filter, hours, posts, sortBy])

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

        {/* Sort */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-400">排序</span>
          <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-sm">
            {SORT_OPTIONS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                className={cn(
                  'px-3 py-1.5 transition-colors',
                  sortBy === key
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                    : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <span className="text-xs text-zinc-400">浏览量 &gt; 粉丝数 × {VIRAL_RATIO} 视为超粉丝浏览</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setAutoRefresh(v => {
              const next = !v
              localStorage.setItem('x_posts_auto_refresh', next ? '1' : '0')
              return next
            })}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors',
              autoRefresh
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400'
                : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            )}
          >
            {autoRefresh
              ? <><PauseCircle className="w-3.5 h-3.5" />自动刷新 {countdown}s</>
              : <><PlayCircle className="w-3.5 h-3.5" />自动刷新</>}
          </button>
          <Button variant="outline" size="sm" onClick={() => refresh()} disabled={refreshing}>
            <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', refreshing && 'animate-spin')} />
            刷新
          </Button>
        </div>
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
          {paginated.map(post => {
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
                    <span className="text-[10px] text-zinc-500">· 收录 {formatRelTime(post.collected_at)}</span>
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
                    <span className={cn(
                      'text-[10px] px-1.5 py-0.5 rounded font-mono',
                      post.source === 'tl1'
                        ? 'bg-violet-100 text-violet-600 dark:bg-violet-950/50 dark:text-violet-400'
                        : post.source === 'camofox'
                          ? 'bg-amber-100 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400'
                          : 'bg-sky-100 text-sky-600 dark:bg-sky-950/50 dark:text-sky-400'
                    )}>
                      {post.source === 'tl1' ? 'tl1' : post.source === 'camofox' ? 'camofox' : 'API'}
                    </span>
                    {post.category && (
                      <span className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                        post.category === '通告'
                          ? 'bg-rose-100 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400'
                          : post.category === '科普'
                            ? 'bg-cyan-100 text-cyan-600 dark:bg-cyan-950/50 dark:text-cyan-400'
                            : post.category === '教程'
                              ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400'
                              : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                      )}>
                        {post.category}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => setInspirePost(post)}
                        title="内容灵感分析"
                        className="text-zinc-300 hover:text-amber-500 transition-colors"
                      >
                        <Lightbulb className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setCreatePost(post)}
                        title="基于帖子创作"
                        className="text-zinc-300 hover:text-indigo-500 transition-colors"
                      >
                        <PenLine className="w-3.5 h-3.5" />
                      </button>
                      <a
                        href={post.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-zinc-300 hover:text-zinc-500 transition-colors"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                      <AddToTopicPopover
                        url={post.url}
                        title={`${post.display_name || post.username}: ${post.content.slice(0, 60)}`}
                        summary={post.content.slice(0, 200)}
                        platform="x"
                        className="!w-6 !h-6"
                      />
                    </div>
                  </div>
                  <p className="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-3 leading-relaxed">
                    {post.content || <span className="italic text-zinc-400">（无文字内容）</span>}
                  </p>
                </div>

                {/* Latest metrics */}
                <div className="flex items-center gap-4 flex-shrink-0 border-l border-zinc-100 dark:border-zinc-800 pl-4">
                  <MetricCell icon={MessageCircle} value={post.latest_replies} color="#8b5cf6" label="回复" />
                  <MetricCell icon={Repeat2} value={post.latest_reposts} color="#10b981" label="转发" />
                  <MetricCell icon={Heart} value={post.latest_likes} color="#ec4899" label="点赞" />
                  <MetricCell icon={Eye} value={post.latest_views} color="#0ea5e9" label="阅读" />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Inspiration modal */}
      {inspirePost && (
        <InspirationModal post={inspirePost} onClose={() => setInspirePost(null)} />
      )}

      {/* Create article modal */}
      {createPost && (
        <CreateModal post={createPost} onClose={() => setCreatePost(null)} />
      )}

      {/* Pagination */}
      {sorted.length > 0 && totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-zinc-400">
            共 {sorted.length} 条，第 {page}/{totalPages} 页
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="h-7 text-xs gap-1"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="h-7 text-xs gap-1"
            >
              下一页
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
