'use client'

import { useState, useMemo, useEffect, useCallback } from 'react'
import { Flame, RefreshCw, Search, ThumbsUp, Eye, MessageSquare, Star } from 'lucide-react'
import { toast } from 'sonner'
import {
  JuejinArticle,
  JuejinCategory,
  JuejinCategoryMeta,
  getJuejinArticles,
  getJuejinArticle,
  collectJuejin,
} from '@/lib/api/juejin'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { ResponsiveArticleReader, ReaderMeta } from '@/components/features/ArticleReader'
import { useMediaQuery } from '@/lib/use-media-query'
import { fmtRelTime, fmtNum } from '@/lib/format'
import { useInfiniteScroll } from '@/lib/use-infinite-scroll'
import { AddToTopicPopover } from '@/components/features/AddToTopicPopover'
import { PushToStudioPopover } from '@/components/features/PushToStudioPopover'

const PAGE_SIZE = 30

// ── Card (shared layout) ───────────────────────────────────────────────────────

function JuejinCard({
  article,
  rank,
  onOpen,
}: {
  article: JuejinArticle
  rank?: number
  onOpen: () => void
}) {
  const tags = article.tags ? article.tags.split(',').filter(Boolean).slice(0, 3) : []
  const isTopRank = rank != null && rank <= 3

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="group relative w-full text-left flex gap-4 py-4 px-3 -mx-3 rounded-xl border-b border-zinc-100 dark:border-zinc-900 last:border-0 hover:bg-zinc-50/70 dark:hover:bg-zinc-900/40 transition-colors cursor-pointer"
    >
      {/* Rank badge (outside the cover-aligned column) */}
      {rank != null && (
        <div className="flex-shrink-0 flex flex-col items-center pt-1 w-7">
          <span className={cn(
            'text-base font-bold tabular-nums leading-none',
            isTopRank ? 'text-blue-500' : 'text-zinc-300 dark:text-zinc-600',
          )}>
            {rank}
          </span>
        </div>
      )}

      {/* Cover (always reserves space; falls back to placeholder when missing) */}
      <div className="flex-shrink-0 w-28 h-20 rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800/60 ring-1 ring-zinc-200/60 dark:ring-zinc-800 flex items-center justify-center">
        {article.cover_url ? (
          <img
            src={article.cover_url}
            alt=""
            className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
          />
        ) : (
          <Flame className="w-6 h-6 text-zinc-300 dark:text-zinc-700" />
        )}
      </div>

      {/* Right side: title / meta / stats+actions — distributes to cover height */}
      <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
        <h3 className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100 truncate leading-snug
                       group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
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
          {tags.length > 0 && (
            <>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <div className="flex items-center gap-1 flex-wrap">
                {tags.map(t => (
                  <span
                    key={t}
                    className="px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-[10px] leading-none"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Last line: stats + action icon */}
        <div className="flex items-center">
          <div className="flex items-center gap-2.5 text-[11px] text-zinc-400 dark:text-zinc-500">
            {article.view_count > 0 && (
              <span className="flex items-center gap-1"><Eye className="w-3.5 h-3.5" />{fmtNum(article.view_count)}</span>
            )}
            {article.digg_count > 0 && (
              <span className="flex items-center gap-1"><ThumbsUp className="w-3.5 h-3.5" />{fmtNum(article.digg_count)}</span>
            )}
            {article.comment_count > 0 && (
              <span className="flex items-center gap-1"><MessageSquare className="w-3.5 h-3.5" />{fmtNum(article.comment_count)}</span>
            )}
            {article.collect_count > 0 && (
              <span className="flex items-center gap-1"><Star className="w-3.5 h-3.5" />{fmtNum(article.collect_count)}</span>
            )}
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            <AddToTopicPopover
              url={article.url}
              title={article.title}
              summary={article.brief ?? ''}
              platform="juejin"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main ───────────────────────────────────────────────────────────────────────

export function JuejinClient({
  initial,
  categories,
}: {
  initial: JuejinArticle[]
  categories: JuejinCategoryMeta[]
}) {
  const [activeCategory, setActiveCategory] = useState<JuejinCategory>('hot')
  const [articles, setArticles] = useState<Record<string, JuejinArticle[]>>({ hot: initial })
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(initial.length === 0)
  const [collecting, setCollecting] = useState(false)

  // Reader state — switches between right-side panel (wide screens) and modal
  const useSidePanel = useMediaQuery('(min-width: 1280px)')
  const [readerOpen, setReaderOpen] = useState(false)
  const [readerLoading, setReaderLoading] = useState(false)
  const [readerMeta, setReaderMeta] = useState<ReaderMeta | null>(null)

  async function openReader(article: JuejinArticle) {
    setReaderOpen(true)
    setReaderMeta({
      title: article.title,
      author: article.author,
      source: '掘金',
      published_at: article.published_at,
      url: article.url,
      content: article.content,
    })

    // Lazy fetch full body if not yet cached
    if (!article.content) {
      setReaderLoading(true)
      try {
        const full = await getJuejinArticle(article.id)
        setReaderMeta({
          title: full.title,
          author: full.author,
          source: '掘金',
          published_at: full.published_at,
          url: full.url,
          content: full.content,
        })
        setArticles(prev => ({
          ...prev,
          [full.category]: (prev[full.category] || []).map(a => a.id === full.id ? full : a),
        }))
      } catch (e) {
        toast.error('正文加载失败')
      } finally {
        setReaderLoading(false)
      }
    }
  }

  async function handleCollect() {
    setCollecting(true)
    try {
      await collectJuejin(activeCategory)
      toast.success('采集已启动')
      setTimeout(() => load(activeCategory), 3000)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '采集失败')
    } finally {
      setCollecting(false)
    }
  }

  const list = articles[activeCategory] || []
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

  const load = useCallback(async (cat: JuejinCategory) => {
    setLoading(true)
    try {
      const data = await getJuejinArticles({
        category: cat,
        limit: 100,
        search: search || undefined,
      })
      setArticles(prev => ({ ...prev, [cat]: data }))
      resetScroll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => {
    if (!search) return
    const t = setTimeout(() => load(activeCategory), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  useEffect(() => {
    if (initial.length > 0) return
    let cancelled = false
    void getJuejinArticles({ category: 'hot', limit: 100 })
      .then(data => {
        if (!cancelled) setArticles(prev => ({ ...prev, hot: data }))
      })
      .catch(error => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : '加载失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [initial.length])

  const currentLabel = categories.find(c => c.key === activeCategory)?.label || '热榜'

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
              <Flame className="w-4 h-4 text-blue-500" />
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">掘金 · {currentLabel}</span>
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

          {/* Category pills */}
          <div className="flex items-center gap-1 mt-2.5 overflow-x-auto">
            {categories.map(c => {
              const active = c.key === activeCategory
              return (
                <button
                  key={c.key}
                  onClick={() => {
                    setActiveCategory(c.key)
                    resetScroll()
                    if (!articles[c.key]?.length) void load(c.key)
                  }}
                  className={cn(
                    'flex-shrink-0 px-3 py-1 rounded-full text-xs transition-colors',
                    active
                      ? 'bg-zinc-200 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-medium'
                      : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                  )}
                >
                  {c.label}
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
              <Flame className="w-10 h-10 opacity-20 text-blue-500" />
              <p className="text-sm">点击「立即采集」获取最新数据</p>
            </div>
          ) : (
            <>
              <div className={useSidePanel ? '' : 'max-w-3xl'}>
                {visible.map(a => (
                  <JuejinCard
                    key={a.id}
                    article={a}
                    rank={activeCategory === 'hot' ? a.hot_rank : undefined}
                    onOpen={() => openReader(a)}
                  />
                ))}
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
        accent="blue"
        headerActions={readerMeta && (
          <PushToStudioPopover
            url={readerMeta.url}
            title={readerMeta.title}
            content={readerMeta.content}
            platform="juejin"
            label="推送到工作室"
          />
        )}
      />
    </div>
  )
}
