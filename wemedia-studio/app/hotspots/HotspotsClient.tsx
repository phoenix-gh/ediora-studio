'use client'

import { useState, useMemo } from 'react'
import { Hotspot } from '@/lib/types'
import { MiniSparkline } from '@/components/features/MiniSparkline'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  TrendingUp, TrendingDown, Minus, Flame, Filter,
  Clock, Globe, BarChart2, Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const CATEGORIES = ['大模型', '人工智能', '芯片', '开源', '编程工具', '安全', '量子计算']
const TRENDS = [
  { value: 'rising', label: '上升中', icon: TrendingUp, color: 'text-red-500', bg: 'bg-red-50 border-red-300 dark:bg-red-950 dark:border-red-700' },
  { value: 'peak', label: '峰值期', icon: Flame, color: 'text-amber-500', bg: 'bg-amber-50 border-amber-300 dark:bg-amber-950 dark:border-amber-700' },
  { value: 'declining', label: '下降中', icon: TrendingDown, color: 'text-zinc-400', bg: 'bg-zinc-100 border-zinc-300 dark:bg-zinc-800 dark:border-zinc-600' },
] as const

function formatRelativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return `${Math.floor(diff / 60000)} 分钟前`
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

const trendConfig = {
  rising: { label: '上升中', Icon: TrendingUp, color: 'text-red-500', ringColor: 'ring-red-200 dark:ring-red-800', heatColor: 'bg-red-500' },
  peak: { label: '峰值期', Icon: Flame, color: 'text-amber-500', ringColor: 'ring-amber-200 dark:ring-amber-800', heatColor: 'bg-amber-500' },
  declining: { label: '下降中', Icon: TrendingDown, color: 'text-zinc-400', ringColor: 'ring-zinc-200 dark:ring-zinc-700', heatColor: 'bg-zinc-400' },
}

const sparklineColor = { rising: '#ef4444', peak: '#f59e0b', declining: '#a1a1aa' }

function HotspotDetail({ hotspot, onClose }: { hotspot: Hotspot; onClose: () => void }) {
  const cfg = trendConfig[hotspot.trend]
  return (
    <Sheet open onOpenChange={open => !open && onClose()}>
      <SheetContent className="w-[440px] sm:max-w-[440px] p-0 flex flex-col">
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="outline" className="text-[11px] font-normal text-zinc-500">{hotspot.category}</Badge>
            <div className={cn('flex items-center gap-1 text-xs font-medium', cfg.color)}>
              <cfg.Icon className="w-3.5 h-3.5" />
              {cfg.label}
            </div>
          </div>
          <SheetTitle className="text-base font-semibold text-zinc-900 dark:text-zinc-100 text-left leading-snug">
            {hotspot.title}
          </SheetTitle>
          <div className="flex items-center gap-3 mt-2 text-xs text-zinc-400">
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              首次发现 {formatRelativeTime(hotspot.firstSeenAt)}
            </span>
            <span className="flex items-center gap-1">
              <Globe className="w-3 h-3" />
              {hotspot.platforms.length} 个平台
            </span>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="px-6 py-4 space-y-5">
            {/* 热度指数 */}
            <section>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">热度指数</h3>
              <div className="flex items-end gap-4">
                <div className="text-5xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">{hotspot.heat}</div>
                <div className="flex-1 pb-2">
                  <div className="h-2 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden mb-1">
                    <div
                      className={cn('h-full rounded-full transition-all', cfg.heatColor)}
                      style={{ width: `${hotspot.heat}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-zinc-400">相对于同期最高热度 100</p>
                </div>
              </div>
            </section>

            <Separator />

            {/* 24h 趋势 */}
            <section>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">24 小时趋势</h3>
              <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3">
                <MiniSparkline
                  data={hotspot.trendData}
                  height={72}
                  color={sparklineColor[hotspot.trend]}
                  fill
                />
                <div className="flex justify-between mt-1">
                  <span className="text-[10px] text-zinc-400">24h 前</span>
                  <span className="text-[10px] text-zinc-400">现在</span>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-3">
                <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-2.5 text-center">
                  <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200">{Math.max(...hotspot.trendData)}</p>
                  <p className="text-[10px] text-zinc-400 mt-0.5">峰值热度</p>
                </div>
                <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-2.5 text-center">
                  <p className="text-sm font-bold text-zinc-800 dark:text-zinc-200">{hotspot.trendData[hotspot.trendData.length - 1]}</p>
                  <p className="text-[10px] text-zinc-400 mt-0.5">当前热度</p>
                </div>
                <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-2.5 text-center">
                  <p className={cn('text-sm font-bold', hotspot.trend === 'rising' ? 'text-red-500' : hotspot.trend === 'peak' ? 'text-amber-500' : 'text-zinc-400')}>
                    {hotspot.trend === 'rising' ? '↑' : hotspot.trend === 'declining' ? '↓' : '→'}
                    {Math.abs(hotspot.trendData[hotspot.trendData.length - 1] - hotspot.trendData[0])}
                  </p>
                  <p className="text-[10px] text-zinc-400 mt-0.5">24h 变化</p>
                </div>
              </div>
            </section>

            <Separator />

            {/* 覆盖平台 */}
            <section>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">覆盖平台</h3>
              <div className="flex flex-wrap gap-2">
                {hotspot.platforms.map(p => (
                  <div key={p} className="flex items-center gap-1.5 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5">
                    <Globe className="w-3 h-3 text-zinc-400" />
                    <span className="text-xs text-zinc-700 dark:text-zinc-300 font-medium">{p}</span>
                  </div>
                ))}
              </div>
            </section>

            <Separator />

            {/* 选题建议 */}
            <section>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">选题建议</h3>
              <div className={cn(
                'rounded-lg px-3 py-2.5',
                hotspot.trend === 'rising' ? 'bg-red-50 dark:bg-red-950/40' :
                hotspot.trend === 'peak' ? 'bg-amber-50 dark:bg-amber-950/40' :
                'bg-zinc-50 dark:bg-zinc-800/50'
              )}>
                <p className={cn('text-xs leading-relaxed',
                  hotspot.trend === 'rising' ? 'text-red-700 dark:text-red-300' :
                  hotspot.trend === 'peak' ? 'text-amber-700 dark:text-amber-300' :
                  'text-zinc-600 dark:text-zinc-400'
                )}>
                  {hotspot.trend === 'rising'
                    ? `话题仍在快速上升阶段，现在入场可以吃到上升红利。建议 6 小时内发布，优先抢占 ${hotspot.category} 赛道关键词。`
                    : hotspot.trend === 'peak'
                    ? `话题已在峰值期，流量最高但竞争也最激烈。建议差异化角度切入，做深度或独家视角内容。`
                    : `话题热度已过峰值，适合做总结复盘类内容，SEO 长尾价值仍在。`
                  }
                </p>
              </div>
            </section>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

export function HotspotsClient({ hotspots: initial }: { hotspots: Hotspot[] }) {
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [selectedTrends, setSelectedTrends] = useState<Hotspot['trend'][]>([])
  const [activeId, setActiveId] = useState<string | null>(null)

  const toggleCategory = (c: string) =>
    setSelectedCategories(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c])
  const toggleTrend = (t: Hotspot['trend']) =>
    setSelectedTrends(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])

  const filtered = useMemo(() => initial.filter(h => {
    if (selectedCategories.length && !selectedCategories.includes(h.category)) return false
    if (selectedTrends.length && !selectedTrends.includes(h.trend)) return false
    return true
  }), [initial, selectedCategories, selectedTrends])

  const activeHotspot = initial.find(h => h.id === activeId)

  const risingCount = initial.filter(h => h.trend === 'rising').length
  const peakCount = initial.filter(h => h.trend === 'peak').length

  return (
    <>
      <div className="px-8 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1">热点雷达</h1>
          <p className="text-sm text-zinc-500">
            实时监控 <span className="text-zinc-800 dark:text-zinc-200 font-medium">{initial.length}</span> 个热点 ·
            <span className="text-red-500 font-medium mx-1">{risingCount}</span>上升中 ·
            <span className="text-amber-500 font-medium mx-1">{peakCount}</span>峰值期
          </p>
        </div>

        {/* Filter bar */}
        <div className="sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-950 pb-3 -mx-8 px-8">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 space-y-3 shadow-sm">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-zinc-500 flex-shrink-0">
                <Filter className="w-3.5 h-3.5" />
                领域
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map(cat => (
                  <Badge
                    key={cat}
                    variant="outline"
                    onClick={() => toggleCategory(cat)}
                    className={cn(
                      'cursor-pointer text-[11px] px-2 py-0.5 font-normal transition-colors',
                      selectedCategories.includes(cat)
                        ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-indigo-950 dark:border-indigo-700 dark:text-indigo-300'
                        : 'hover:border-zinc-400'
                    )}
                  >
                    {cat}
                  </Badge>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-zinc-500 flex-shrink-0">趋势</div>
              <div className="flex gap-1.5">
                {TRENDS.map(({ value, label, icon: Icon, color, bg }) => (
                  <Badge
                    key={value}
                    variant="outline"
                    onClick={() => toggleTrend(value)}
                    className={cn(
                      'cursor-pointer text-[11px] px-2 py-0.5 font-normal transition-colors flex items-center gap-1',
                      selectedTrends.includes(value) ? bg : 'hover:border-zinc-400'
                    )}
                  >
                    <Icon className={cn('w-3 h-3', selectedTrends.includes(value) ? color : 'text-zinc-400')} />
                    {label}
                  </Badge>
                ))}
              </div>
              <span className="ml-auto text-xs text-zinc-400">{filtered.length} 条</span>
            </div>
          </div>
        </div>

        {/* Grid */}
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <BarChart2 className="w-10 h-10 text-zinc-300 dark:text-zinc-700 mb-3" />
            <p className="text-sm font-medium text-zinc-500">暂无匹配热点</p>
            <p className="text-xs text-zinc-400 mt-1">调整筛选条件</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 pt-2">
            {filtered.map((h, i) => {
              const cfg = trendConfig[h.trend]
              const globalRank = initial.indexOf(h) + 1
              return (
                <div
                  key={h.id}
                  onClick={() => setActiveId(h.id)}
                  className={cn(
                    'bg-white dark:bg-zinc-900 border rounded-xl px-5 py-4 cursor-pointer',
                    'hover:-translate-y-px hover:shadow-sm transition-all',
                    'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700',
                    activeId === h.id && 'ring-2 ring-indigo-400 ring-offset-1'
                  )}
                >
                  <div className="flex items-start gap-4">
                    {/* 排名 */}
                    <div className="flex-shrink-0 w-7 text-center pt-0.5">
                      <span className={cn(
                        'text-sm font-bold tabular-nums',
                        globalRank <= 3 ? 'text-rose-500' : 'text-zinc-400'
                      )}>
                        {globalRank}
                      </span>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1.5">
                        <Badge variant="outline" className="text-[11px] font-normal text-zinc-400 border-zinc-200 px-1.5 py-0">
                          {h.category}
                        </Badge>
                        <div className={cn('flex items-center gap-1 text-[11px] font-medium', cfg.color)}>
                          <cfg.Icon className="w-3 h-3" />
                          {cfg.label}
                        </div>
                        <span className="ml-auto text-[11px] text-zinc-400 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatRelativeTime(h.firstSeenAt)}
                        </span>
                      </div>

                      <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 leading-snug mb-2">
                        {h.title}
                      </h3>

                      <div className="flex items-center gap-3">
                        {/* 热度条 */}
                        <div className="flex items-center gap-2 flex-1">
                          <div className="flex-1 h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className={cn('h-full rounded-full', cfg.heatColor)}
                              style={{ width: `${h.heat}%` }}
                            />
                          </div>
                          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 tabular-nums w-6">{h.heat}</span>
                        </div>
                        {/* 平台 */}
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {h.platforms.slice(0, 3).map(p => (
                            <span key={p} className="text-[10px] text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                              {p}
                            </span>
                          ))}
                          {h.platforms.length > 3 && (
                            <span className="text-[10px] text-zinc-400">+{h.platforms.length - 3}</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Sparkline */}
                    <div className="flex-shrink-0 w-[72px]">
                      <MiniSparkline
                        data={h.trendData.slice(-12)}
                        height={32}
                        color={sparklineColor[h.trend]}
                        fill
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {activeHotspot && (
        <HotspotDetail hotspot={activeHotspot} onClose={() => setActiveId(null)} />
      )}
    </>
  )
}
