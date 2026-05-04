'use client'

import { useState } from 'react'
import { EconomicItem } from '@/lib/types'
import { triggerGenerateEconomic } from '@/lib/api/economic'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TrendingUp, TrendingDown, Minus, Sparkles, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const CATEGORIES = ['全部', '宏观经济', '股市行情', '汇率外汇', '大宗商品', '科技产业', '政策法规']

const impactConfig = {
  positive: { label: '利好', color: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-400', icon: TrendingUp },
  negative: { label: '利空', color: 'text-red-500 bg-red-50 dark:bg-red-950 dark:text-red-400', icon: TrendingDown },
  neutral:  { label: '中性', color: 'text-zinc-500 bg-zinc-100 dark:bg-zinc-800 dark:text-zinc-400', icon: Minus },
}

const levelDot: Record<string, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-400',
  low: 'bg-zinc-300',
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function EconomicCard({ item }: { item: EconomicItem }) {
  const cfg = impactConfig[item.impact]
  const ImpactIcon = cfg.icon
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">{item.category}</Badge>
            <span className={cn('flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium', cfg.color)}>
              <ImpactIcon className="w-2.5 h-2.5" />
              {cfg.label}
            </span>
            <span className="flex items-center gap-1 text-[10px] text-zinc-400">
              <span className={cn('w-1.5 h-1.5 rounded-full inline-block', levelDot[item.impact_level])} />
              {item.impact_level === 'high' ? '重要' : item.impact_level === 'medium' ? '一般' : '次要'}
            </span>
            <span className="ml-auto text-[10px] text-zinc-400">{formatTime(item.published_at)}</span>
          </div>
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mb-1">{item.title}</h3>
          <p className="text-xs text-zinc-500 leading-relaxed">{item.summary}</p>
        </div>
      </div>
    </div>
  )
}

export function EconomicClient({ initialItems }: { initialItems: EconomicItem[] }) {
  const [items, setItems] = useState(initialItems)
  const [category, setCategory] = useState('全部')
  const [generating, setGenerating] = useState(false)

  const filtered = category === '全部' ? items : items.filter(i => i.category === category)

  async function handleGenerate() {
    setGenerating(true)
    try {
      const res = await triggerGenerateEconomic()
      toast.success(`AI 分析完成：新增 ${res.new_economic} 条经济动态`)
      // Refresh page data
      const { getEconomicItems } = await import('@/lib/api/economic')
      setItems(await getEconomicItems())
    } catch {
      toast.error('生成失败，请检查 ANTHROPIC_API_KEY 配置')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">经济动态</h1>
          <p className="text-sm text-zinc-500 mt-1">AI 从订阅内容中提炼关键经济事件，聚焦科技产业影响</p>
        </div>
        <Button
          onClick={handleGenerate}
          disabled={generating}
          size="sm"
          className="gap-1.5"
        >
          {generating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {generating ? 'AI 分析中…' : 'AI 重新分析'}
        </Button>
      </div>

      {/* Category filter */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {CATEGORIES.map(c => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={cn(
              'px-3 py-1 rounded-full text-xs font-medium transition-colors',
              category === c
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {generating && (
        <div className="space-y-3 mb-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
        </div>
      )}

      {!generating && filtered.length === 0 && (
        <div className="text-center py-20 text-zinc-400">
          <p className="text-sm mb-2">暂无经济动态</p>
          <p className="text-xs">点击「AI 重新分析」从订阅内容中生成经济事件</p>
        </div>
      )}

      <div className="space-y-3">
        {filtered.map(item => (
          <EconomicCard key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}
