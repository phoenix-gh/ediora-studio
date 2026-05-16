'use client'

import { useState, useMemo, useEffect, useRef } from 'react'
import { ExternalLink, RefreshCw, Search, Rocket, ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProductHuntPost, getProductHuntPosts, collectProductHunt } from '@/lib/api/producthunt'

const DAYS_OPTIONS = [1, 3, 7, 14, 30]
const PAGE_SIZE = 24

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

// ── Image Carousel ─────────────────────────────────────────────────────────────

function ImageCarousel({ images, title }: { images: string[]; title: string }) {
  const [idx, setIdx] = useState(0)
  const [errSet, setErrSet] = useState<Set<number>>(new Set())

  const validImages = images.filter((_, i) => !errSet.has(i))
  const current = images[idx]
  const hasErr = errSet.has(idx)

  if (!images.length || (validImages.length === 0)) {
    return (
      <div className="w-full aspect-video bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center flex-shrink-0">
        <Rocket className="w-10 h-10 text-orange-300 dark:text-orange-700" />
      </div>
    )
  }

  return (
    <div className="relative w-full aspect-video bg-zinc-100 dark:bg-zinc-800 overflow-hidden flex-shrink-0 group/carousel">
      {/* Current image */}
      {!hasErr && current ? (
        <img
          key={idx}
          src={current}
          alt={`${title} - ${idx + 1}`}
          className="w-full h-full object-cover"
          onError={() => setErrSet(s => new Set([...s, idx]))}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <Rocket className="w-10 h-10 text-orange-300 dark:text-orange-700" />
        </div>
      )}

      {/* Left / right click zones */}
      {images.length > 1 && (
        <>
          <button
            onClick={e => { e.preventDefault(); e.stopPropagation(); setIdx(i => (i - 1 + images.length) % images.length) }}
            className="absolute left-0 top-0 h-full w-2/5 flex items-center justify-start pl-2 opacity-0 group-hover/carousel:opacity-100 transition-opacity"
          >
            <span className="bg-black/40 hover:bg-black/60 rounded-full p-1 transition-colors">
              <ChevronLeft className="w-4 h-4 text-white" />
            </span>
          </button>
          <button
            onClick={e => { e.preventDefault(); e.stopPropagation(); setIdx(i => (i + 1) % images.length) }}
            className="absolute right-0 top-0 h-full w-2/5 flex items-center justify-end pr-2 opacity-0 group-hover/carousel:opacity-100 transition-opacity"
          >
            <span className="bg-black/40 hover:bg-black/60 rounded-full p-1 transition-colors">
              <ChevronRight className="w-4 h-4 text-white" />
            </span>
          </button>
          {/* Position dots — indicator only */}
          <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1 pointer-events-none">
            {images.map((_, i) => (
              <span
                key={i}
                className={cn(
                  'w-1.5 h-1.5 rounded-full transition-all',
                  i === idx ? 'bg-white shadow' : 'bg-white/40',
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Product Card ───────────────────────────────────────────────────────────────

function ProductCard({ post }: { post: ProductHuntPost }) {
  return (
    <a
      href={post.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col rounded-xl border border-zinc-100 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600 hover:shadow-md transition-all overflow-hidden bg-white dark:bg-zinc-900"
    >
      <ImageCarousel images={post.images?.length ? post.images : (post.thumbnail_url ? [post.thumbnail_url] : [])} title={post.title} />

      {/* Content */}
      <div className="flex flex-col flex-1 p-3 gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-100 line-clamp-1 leading-snug flex-1 min-w-0">
            {post.title}
          </p>
          <ExternalLink className="w-3 h-3 text-zinc-300 group-hover:text-orange-400 flex-shrink-0 mt-0.5 transition-colors" />
        </div>

        {post.tagline && (
          <p className="text-[12px] text-zinc-500 dark:text-zinc-400 line-clamp-2 leading-relaxed">
            {post.tagline}
          </p>
        )}

        <div className="flex items-center gap-2 mt-auto pt-1.5">
          {post.topics.length > 0 && (
            <div className="flex gap-1 flex-wrap flex-1 min-w-0">
              {post.topics.slice(0, 3).map(t => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-50 dark:bg-orange-950/40 text-orange-600 dark:text-orange-400 font-medium truncate max-w-[80px]">
                  {t}
                </span>
              ))}
            </div>
          )}
          <span className="text-[11px] text-zinc-400 flex-shrink-0 ml-auto">{fmtDate(post.published_at)}</span>
        </div>
      </div>
    </a>
  )
}

// ── Main Client ────────────────────────────────────────────────────────────────

export function ProductHuntClient({ initialPosts }: { initialPosts: ProductHuntPost[] }) {
  const [posts, setPosts] = useState(initialPosts)
  const [days, setDays] = useState(7)
  const [search, setSearch] = useState('')
  const [collecting, setCollecting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    if (!search.trim()) return posts
    const q = search.toLowerCase()
    return posts.filter(p =>
      p.title.toLowerCase().includes(q) ||
      p.tagline.toLowerCase().includes(q) ||
      p.topics.some(t => t.toLowerCase().includes(q))
    )
  }, [posts, search])

  const visible = filtered.slice(0, visibleCount)
  const hasMore = visibleCount < filtered.length

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting && hasMore) setVisibleCount(c => c + PAGE_SIZE) },
      { rootMargin: '200px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore])

  async function loadPosts(daysVal: number) {
    setLoading(true)
    try {
      const data = await getProductHuntPosts({ days: daysVal, limit: 200 })
      setPosts(data)
      setVisibleCount(PAGE_SIZE)
    } catch {
      toast.error('加载失败')
    } finally {
      setLoading(false)
    }
  }

  async function handleCollect() {
    setCollecting(true)
    try {
      const res = await collectProductHunt()
      toast.success(`采集完成，新增 ${res.new_posts} 条`)
      await loadPosts(days)
    } catch {
      toast.error('采集失败')
    } finally {
      setCollecting(false)
    }
  }

  async function handleDaysChange(d: number) {
    setDays(d)
    setSearch('')
    await loadPosts(d)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-6 py-3 flex-shrink-0">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-orange-500 flex items-center justify-center flex-shrink-0">
              <Rocket className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">Product Hunt</span>
            <span className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full">
              {filtered.length} 个产品
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
              <Input
                value={search}
                onChange={e => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE) }}
                placeholder="搜索产品名、标签…"
                className="h-8 text-xs pl-8 w-44"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={handleCollect}
              disabled={collecting || loading}
            >
              <RefreshCw className={cn('w-3.5 h-3.5', collecting && 'animate-spin')} />
              {collecting ? '采集中…' : '立即采集'}
            </Button>
          </div>
        </div>

        {/* Days filter */}
        <div className="flex items-center gap-1 mt-2.5">
          <span className="text-xs text-zinc-400">最近</span>
          {DAYS_OPTIONS.map(d => (
            <button
              key={d}
              onClick={() => handleDaysChange(d)}
              disabled={loading}
              className={cn(
                'px-2 py-0.5 rounded text-xs transition-colors disabled:opacity-40',
                days === d
                  ? 'bg-orange-100 dark:bg-orange-950/50 text-orange-700 dark:text-orange-300 font-medium'
                  : 'text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800',
              )}
            >
              {d}天
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-400">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3 text-zinc-400">
            <Rocket className="w-10 h-10 opacity-20 text-orange-500" />
            <p className="text-sm">暂无数据，点击「立即采集」获取 Product Hunt 最新产品</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
              {visible.map(post => (
                <ProductCard key={post.id} post={post} />
              ))}
            </div>
            <div ref={sentinelRef} className="flex items-center justify-center py-6">
              {hasMore && <span className="text-xs text-zinc-400">加载中…</span>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
