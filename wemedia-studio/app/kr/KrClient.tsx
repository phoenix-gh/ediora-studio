'use client'

import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { Flame, Newspaper, Zap, RefreshCw, Search, ExternalLink, ThumbsUp, Eye, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { KrArticle, KrFeedType, getKrArticles, getKrArticle, collectKr } from '@/lib/api/kr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ArticleReaderModal, ArticleReaderPanel, ReaderMeta } from '@/components/features/ArticleReader'
import { useMediaQuery } from '@/lib/use-media-query'

const TABS: { key: KrFeedType; label: string; icon: typeof Flame; color: string }[] = [
  { key: 'hot',       label: '热榜',     icon: Flame,     color: 'text-orange-500' },
  { key: 'article',   label: '最新文章', icon: Newspaper, color: 'text-blue-500' },
  { key: 'newsflash', label: '快讯',     icon: Zap,       color: 'text-yellow-500' },
]

const PAGE_SIZE = 30

function fmtRelTime(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function fmtNum(n: number) {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// ── Hot Card: ranked layout with cover ─────────────────────────────────────────

function HotCard({ article, onOpen }: { article: KrArticle; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full text-left flex gap-3 py-3 px-2 -mx-2 rounded-lg border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors"
    >
      <span className={cn(
        'flex-shrink-0 w-6 text-center text-sm font-semibold pt-0.5',
        article.rank <= 3 ? 'text-orange-500' : 'text-zinc-400',
      )}>
        {article.rank}
      </span>

      {article.image_url && (
        <div className="flex-shrink-0 w-24 h-16 rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800">
          <img src={article.image_url} alt=""
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100 line-clamp-2 leading-snug
                      group-hover:text-orange-600 dark:group-hover:text-orange-400 transition-colors">
          {article.title}
        </p>
        <div className="mt-1.5 flex items-center gap-3 text-[11px] text-zinc-400">
          {article.author && (
            <span className="text-zinc-500 truncate max-w-[120px]">{article.author}</span>
          )}
          {article.stat_read > 0 && (
            <span className="flex items-center gap-0.5"><Eye className="w-3 h-3" />{fmtNum(article.stat_read)}</span>
          )}
          {article.stat_like > 0 && (
            <span className="flex items-center gap-0.5"><ThumbsUp className="w-3 h-3" />{fmtNum(article.stat_like)}</span>
          )}
          {article.stat_comment > 0 && (
            <span className="flex items-center gap-0.5"><MessageSquare className="w-3 h-3" />{fmtNum(article.stat_comment)}</span>
          )}
          <span className="ml-auto">{fmtRelTime(article.published_at)}</span>
        </div>
      </div>
    </button>
  )
}

// ── Article Card (latest articles, like Hot but no rank) ───────────────────────

function ArticleCard({ article, onOpen }: { article: KrArticle; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full text-left flex gap-3 py-3 px-2 -mx-2 rounded-lg border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors"
    >
      {article.image_url && (
        <div className="flex-shrink-0 w-24 h-16 rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800">
          <img src={article.image_url} alt=""
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100 line-clamp-2 leading-snug
                      group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
          {article.title}
        </p>
        {article.summary && (
          <p className="mt-1 text-[11px] text-zinc-400 line-clamp-1">{article.summary}</p>
        )}
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-zinc-400">
          {article.author && (
            <>
              <span className="text-zinc-500 truncate max-w-[120px]">{article.author}</span>
              <span>·</span>
            </>
          )}
          <span>{fmtRelTime(article.published_at)}</span>
          <ExternalLink className="w-3 h-3 ml-1 opacity-0 group-hover:opacity-60 transition-opacity" />
        </div>
      </div>
    </button>
  )
}

// ── Newsflash Card (compact, no image) ─────────────────────────────────────────

function NewsflashCard({ article, onOpen }: { article: KrArticle; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group w-full text-left block py-2.5 px-2 -mx-2 rounded-lg border-b border-zinc-100 dark:border-zinc-800 last:border-0 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors"
    >
      <div className="flex items-start gap-2">
        <Zap className="w-3.5 h-3.5 text-yellow-500 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-zinc-900 dark:text-zinc-100 leading-snug
                        group-hover:text-yellow-600 dark:group-hover:text-yellow-400 transition-colors">
            {article.title}
          </p>
          {article.summary && (
            <p className="mt-0.5 text-[11px] text-zinc-500 line-clamp-2 leading-relaxed">{article.summary}</p>
          )}
          <p className="mt-1 text-[11px] text-zinc-400">{fmtRelTime(article.published_at)}</p>
        </div>
      </div>
    </button>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function KrClient({ initial }: { initial: KrArticle[] }) {
  const [activeTab, setActiveTab] = useState<KrFeedType>('hot')
  const [articles, setArticles] = useState<Record<KrFeedType, KrArticle[]>>({
    hot: initial,
    article: [],
    newsflash: [],
  })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [collecting, setCollecting] = useState(false)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Reader state — switches between right-side panel (wide screens) and modal
  const useSidePanel = useMediaQuery('(min-width: 1280px)')
  const [readerOpen, setReaderOpen] = useState(false)
  const [readerLoading, setReaderLoading] = useState(false)
  const [readerMeta, setReaderMeta] = useState<ReaderMeta | null>(null)

  async function openReader(article: KrArticle) {
    setReaderOpen(true)
    setReaderMeta({
      title: article.title,
      author: article.author,
      source: '36 氪',
      published_at: article.published_at,
      url: article.url,
      content: article.content,
    })

    // Lazy fetch if content missing (hot/article may not have been backfilled yet)
    if (!article.content && article.feed_type !== 'newsflash') {
      setReaderLoading(true)
      try {
        const full = await getKrArticle(article.id)
        setReaderMeta({
          title: full.title,
          author: full.author,
          source: '36 氪',
          published_at: full.published_at,
          url: full.url,
          content: full.content,
        })
        // Also patch the in-memory list
        setArticles(prev => ({
          ...prev,
          [full.feed_type]: prev[full.feed_type].map(a => a.id === full.id ? full : a),
        }))
      } catch (e) {
        toast.error('正文加载失败')
      } finally {
        setReaderLoading(false)
      }
    }
  }

  const load = useCallback(async (tab: KrFeedType) => {
    setLoading(true)
    try {
      const data = await getKrArticles({
        feed_type: tab,
        days: tab === 'newsflash' ? 3 : tab === 'article' ? 7 : 365,
        limit: tab === 'hot' ? 50 : 100,
        search: search || undefined,
      })
      setArticles(prev => ({ ...prev, [tab]: data }))
      setVisibleCount(PAGE_SIZE)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [search])

  // Load when tab changes (if data is empty) or search changes
  useEffect(() => {
    if (articles[activeTab].length === 0) {
      load(activeTab)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  useEffect(() => {
    if (!search) return
    const t = setTimeout(() => load(activeTab), 300)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  async function handleCollect() {
    setCollecting(true)
    try {
      await collectKr(activeTab)
      toast.success('采集已启动')
      setTimeout(() => load(activeTab), 3000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '采集失败')
    } finally {
      setCollecting(false)
    }
  }

  const list = articles[activeTab]
  const filtered = useMemo(() => {
    if (!search) return list
    const q = search.toLowerCase()
    return list.filter(a => a.title.toLowerCase().includes(q))
  }, [list, search])

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

  const tabMeta = TABS.find(t => t.key === activeTab)!
  const TabIcon = tabMeta.icon

  const accent: 'orange' | 'yellow' | 'blue' =
    activeTab === 'hot' ? 'orange' : activeTab === 'newsflash' ? 'yellow' : 'blue'

  return (
    <div className="flex h-full">
      <div className={cn(
        'flex flex-col',
        useSidePanel
          ? 'w-[460px] flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800'
          : 'flex-1 min-w-0',
      )}>
      {/* Toolbar */}
      <div className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-6 py-3 flex-shrink-0">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <TabIcon className={cn('w-4 h-4', tabMeta.color)} />
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">36 氪 · {tabMeta.label}</span>
            <span className="text-xs text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full">
              {filtered.length} 条
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
              <Input
                value={search}
                onChange={e => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE) }}
                placeholder="搜索标题"
                className="h-8 text-xs pl-8 w-44"
              />
            </div>
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5"
              onClick={handleCollect} disabled={collecting}>
              <RefreshCw className={cn('w-3.5 h-3.5', collecting && 'animate-spin')} />
              {collecting ? '采集中…' : '立即采集'}
            </Button>
          </div>
        </div>

        {/* Tab pills */}
        <div className="flex items-center gap-1 mt-2.5">
          {TABS.map(t => {
            const Icon = t.icon
            const active = t.key === activeTab
            return (
              <button
                key={t.key}
                onClick={() => { setActiveTab(t.key); setVisibleCount(PAGE_SIZE) }}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1 rounded-full text-xs transition-colors',
                  active
                    ? 'bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-medium'
                    : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                )}
              >
                <Icon className={cn('w-3.5 h-3.5', active && t.color)} />
                {t.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-sm text-zinc-400">加载中…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 gap-3 text-zinc-400">
            <TabIcon className={cn('w-10 h-10 opacity-20', tabMeta.color)} />
            <p className="text-sm">点击「立即采集」获取最新数据</p>
          </div>
        ) : (
          <>
            <div className={useSidePanel ? '' : 'max-w-3xl'}>
              {visible.map(a => {
                if (activeTab === 'hot') return <HotCard key={a.id} article={a} onOpen={() => openReader(a)} />
                if (activeTab === 'newsflash') return <NewsflashCard key={a.id} article={a} onOpen={() => openReader(a)} />
                return <ArticleCard key={a.id} article={a} onOpen={() => openReader(a)} />
              })}
            </div>
            <div ref={sentinelRef} className="py-4">
              {hasMore && <span className="text-xs text-zinc-400">加载中…</span>}
            </div>
          </>
        )}
      </div>

      </div>

      {/* Side panel on wide screens */}
      {useSidePanel && (
        <ArticleReaderPanel
          open={readerOpen}
          onClose={() => setReaderOpen(false)}
          meta={readerMeta}
          loading={readerLoading}
          accent={accent}
        />
      )}

      {/* Modal on narrow screens */}
      {!useSidePanel && (
        <ArticleReaderModal
          open={readerOpen}
          onClose={() => setReaderOpen(false)}
          meta={readerMeta}
          loading={readerLoading}
          accent={accent}
        />
      )}
    </div>
  )
}
