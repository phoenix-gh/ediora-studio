'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { Flame, Newspaper, Zap, RefreshCw, Search, ThumbsUp, Eye, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { KrArticle, KrFeedType, getKrArticles, getKrArticle, collectKr } from '@/lib/api/kr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ResponsiveArticleReader, ReaderMeta } from '@/components/features/ArticleReader'
import { useMediaQuery } from '@/lib/use-media-query'
import { fmtRelTime, fmtNum } from '@/lib/format'
import { useInfiniteScroll } from '@/lib/use-infinite-scroll'
import { AddToTopicPopover } from '@/components/features/AddToTopicPopover'
import { PushToStudioPopover } from '@/components/features/PushToStudioPopover'

const TABS: { key: KrFeedType; label: string; icon: typeof Flame; color: string }[] = [
  { key: 'hot',       label: '热榜',     icon: Flame,     color: 'text-orange-500' },
  { key: 'article',   label: '最新文章', icon: Newspaper, color: 'text-blue-500' },
  { key: 'newsflash', label: '快讯',     icon: Zap,       color: 'text-yellow-500' },
]

const PAGE_SIZE = 30

// ── Unified Card (cover + meta + stats footer) ─────────────────────────────────

function KrCard({
  article,
  rank,
  accent = 'orange',
  placeholderIcon: PlaceholderIcon = Flame,
}: {
  article: KrArticle
  rank?: number
  accent?: 'orange' | 'blue' | 'yellow'
  placeholderIcon?: typeof Flame
}) {
  const isTopRank = rank != null && rank <= 3
  const hoverTitle = {
    orange: 'group-hover:text-orange-600 dark:group-hover:text-orange-400',
    blue: 'group-hover:text-blue-600 dark:group-hover:text-blue-400',
    yellow: 'group-hover:text-yellow-600 dark:group-hover:text-yellow-400',
  }[accent]
  const rankColor = {
    orange: 'text-orange-500',
    blue: 'text-blue-500',
    yellow: 'text-yellow-500',
  }[accent]

  return (
    <div className="group relative w-full text-left flex gap-4 py-4 px-3 -mx-3 rounded-xl border-b border-zinc-100 dark:border-zinc-900 last:border-0 hover:bg-zinc-50/70 dark:hover:bg-zinc-900/40 transition-colors">
      {rank != null && (
        <div className="flex-shrink-0 flex flex-col items-center pt-1 w-7">
          <span className={cn(
            'text-base font-bold tabular-nums leading-none',
            isTopRank ? rankColor : 'text-zinc-300 dark:text-zinc-600',
          )}>
            {rank}
          </span>
        </div>
      )}

      <div className="flex-shrink-0 w-28 h-20 rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800/60 ring-1 ring-zinc-200/60 dark:ring-zinc-800 flex items-center justify-center">
        {article.image_url ? (
          <img
            src={article.image_url}
            alt=""
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
          />
        ) : (
          <PlaceholderIcon className="w-6 h-6 text-zinc-300 dark:text-zinc-700" />
        )}
      </div>

      <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
        <h3 className={cn(
          'text-[14px] font-semibold text-zinc-900 dark:text-zinc-100 truncate leading-snug transition-colors',
          hoverTitle,
        )}>
          {article.title}
        </h3>

        <div className="flex items-center gap-2 text-[11px] text-zinc-400 dark:text-zinc-500 flex-wrap min-w-0">
          <span>{fmtRelTime(article.published_at)}</span>
          {article.author && (
            <>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span className="text-zinc-600 dark:text-zinc-300 font-medium truncate max-w-[140px]">
                {article.author}
              </span>
            </>
          )}
        </div>

        <div className="flex items-center">
          <div className="flex items-center gap-2.5 text-[11px] text-zinc-400 dark:text-zinc-500">
            {article.stat_read > 0 && (
              <span className="flex items-center gap-1"><Eye className="w-3.5 h-3.5" />{fmtNum(article.stat_read)}</span>
            )}
            {article.stat_like > 0 && (
              <span className="flex items-center gap-1"><ThumbsUp className="w-3.5 h-3.5" />{fmtNum(article.stat_like)}</span>
            )}
            {article.stat_comment > 0 && (
              <span className="flex items-center gap-1"><MessageSquare className="w-3.5 h-3.5" />{fmtNum(article.stat_comment)}</span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            <AddToTopicPopover
              url={article.url}
              title={article.title}
              summary={article.summary ?? ''}
              platform="36kr"
            />
            <PushToStudioPopover
              url={article.url}
              title={article.title}
              summary={article.summary ?? ''}
              content={article.content ?? ''}
              platform="36kr"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function KrCardClickable(props: { article: KrArticle; rank?: number; accent?: 'orange' | 'blue' | 'yellow'; placeholderIcon?: typeof Flame; onOpen: () => void }) {
  const { onOpen, ...rest } = props
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="cursor-pointer"
    >
      <KrCard {...rest} />
    </div>
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
      resetScroll()
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

  const { visibleCount, sentinelRef, hasMore, reset: resetScroll } = useInfiniteScroll({
    totalCount: filtered.length,
    pageSize: PAGE_SIZE,
  })
  const visible = filtered.slice(0, visibleCount)

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
                onChange={e => { setSearch(e.target.value); resetScroll() }}
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
                onClick={() => { setActiveTab(t.key); resetScroll() }}
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
                if (activeTab === 'hot') return <KrCardClickable key={a.id} article={a} rank={a.rank} accent="orange" onOpen={() => openReader(a)} />
                if (activeTab === 'newsflash') return <KrCardClickable key={a.id} article={a} accent="yellow" placeholderIcon={Zap} onOpen={() => openReader(a)} />
                return <KrCardClickable key={a.id} article={a} accent="blue" placeholderIcon={Newspaper} onOpen={() => openReader(a)} />
              })}
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
        loading={readerLoading}
        accent={accent}
        headerActions={readerMeta && (
          <PushToStudioPopover
            url={readerMeta.url}
            title={readerMeta.title}
            content={readerMeta.content}
            platform="36kr"
            label="推送到工作室"
          />
        )}
      />
    </div>
  )
}
