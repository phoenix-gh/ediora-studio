'use client'

import { useState, useTransition } from 'react'
import { TrendingUp, TrendingDown, Minus, Plus, RefreshCw, Sparkles, Trash2, Tag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Keyword } from '@/lib/api/keywords'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api'

const trendIcon = {
  rising: <TrendingUp className="w-3.5 h-3.5 text-red-500" />,
  stable: <Minus className="w-3.5 h-3.5 text-zinc-400" />,
  declining: <TrendingDown className="w-3.5 h-3.5 text-zinc-400" />,
}
const trendLabel = { rising: '上升', stable: '稳定', declining: '下降' }
const trendColor = { rising: 'text-red-500', stable: 'text-zinc-400', declining: 'text-zinc-400' }

function HeatBar({ heat, trend }: { heat: number; trend: string }) {
  const color = trend === 'rising' ? 'bg-red-500' : trend === 'declining' ? 'bg-zinc-300' : 'bg-indigo-400'
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full transition-all', color)} style={{ width: `${heat}%` }} />
      </div>
      <span className="text-xs font-medium text-zinc-500 tabular-nums w-6 text-right">{heat}</span>
    </div>
  )
}

interface Props {
  initialKeywords: Keyword[]
}

export function HotspotsClient({ initialKeywords }: Props) {
  const [keywords, setKeywords] = useState<Keyword[]>(initialKeywords)
  const [newTerm, setNewTerm] = useState('')
  const [newCat, setNewCat] = useState('')
  const [isPending, startTransition] = useTransition()
  const [message, setMessage] = useState('')

  async function handleAdd() {
    const term = newTerm.trim()
    if (!term) return
    try {
      const res = await fetch(`${API}/keywords`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term, category: newCat.trim() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setMessage(err.detail || '添加失败')
        return
      }
      const kw: Keyword = await res.json()
      setKeywords(prev => [kw, ...prev])
      setNewTerm('')
      setNewCat('')
      setMessage(`已添加「${term}」`)
    } catch {
      setMessage('添加失败，请检查服务')
    }
  }

  async function handleDelete(id: number, term: string) {
    try {
      await fetch(`${API}/keywords/${id}`, { method: 'DELETE' })
      setKeywords(prev => prev.filter(k => k.id !== id))
      setMessage(`已删除「${term}」`)
    } catch {
      setMessage('删除失败')
    }
  }

  function handleRefresh() {
    startTransition(async () => {
      setMessage('正在刷新热度...')
      try {
        const res = await fetch(`${API}/keywords/refresh`, { method: 'POST' })
        const data = await res.json()
        setMessage(data.message || '刷新完成')
        // Reload keyword list
        const listRes = await fetch(`${API}/keywords?active_only=true`)
        const list: Keyword[] = await listRes.json()
        setKeywords(list.sort((a, b) => b.heat - a.heat))
      } catch {
        setMessage('刷新失败')
      }
    })
  }

  function handleExtract() {
    startTransition(async () => {
      setMessage('AI 正在从热门帖子中提炼关键词...')
      try {
        const res = await fetch(`${API}/keywords/extract`, { method: 'POST' })
        const newKws: Keyword[] = await res.json()
        setKeywords(prev => {
          const existingIds = new Set(prev.map(k => k.id))
          const added = newKws.filter(k => !existingIds.has(k.id))
          return [...added, ...prev]
        })
        setMessage(`AI 提炼了 ${newKws.length} 个关键词`)
      } catch {
        setMessage('提炼失败')
      }
    })
  }

  const sorted = [...keywords].sort((a, b) => b.heat - a.heat)

  return (
    <div className="px-8 py-8 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1">关键词热度</h1>
        <p className="text-sm text-zinc-500">
          追踪 <span className="text-zinc-800 dark:text-zinc-200 font-medium">{keywords.length}</span> 个关键词 ·
          热度基于过去 24h 采集内容自动计算
        </p>
      </div>

      {/* Actions */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 mb-5 space-y-3">
        <div className="flex items-center gap-2">
          <Input
            value={newTerm}
            onChange={e => setNewTerm(e.target.value)}
            placeholder="输入关键词..."
            className="flex-1 h-8 text-sm"
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
          />
          <Input
            value={newCat}
            onChange={e => setNewCat(e.target.value)}
            placeholder="分类（可选）"
            className="w-32 h-8 text-sm"
          />
          <Button size="sm" className="h-8 gap-1.5" onClick={handleAdd} disabled={!newTerm.trim()}>
            <Plus className="w-3.5 h-3.5" />
            添加
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={handleRefresh} disabled={isPending}>
            <RefreshCw className={cn('w-3.5 h-3.5', isPending && 'animate-spin')} />
            刷新热度
          </Button>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={handleExtract} disabled={isPending}>
            <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
            AI 提炼
          </Button>
          {message && <span className="text-xs text-zinc-500">{message}</span>}
        </div>
      </div>

      {/* Keyword list */}
      {sorted.length === 0 ? (
        <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-10 text-center">
          <Tag className="w-8 h-8 text-zinc-300 dark:text-zinc-700 mx-auto mb-3" />
          <p className="text-sm text-zinc-500">暂无关键词</p>
          <p className="text-xs text-zinc-400 mt-1">手动添加或点击「AI 提炼」从热门帖子中自动生成</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl divide-y divide-zinc-100 dark:divide-zinc-800">
          {sorted.map((kw, i) => (
            <div key={kw.id} className="flex items-center gap-4 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors group">
              <span className={cn('text-xs font-bold tabular-nums w-5 text-center flex-shrink-0',
                i < 3 ? 'text-rose-500' : 'text-zinc-400')}>
                {i + 1}
              </span>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{kw.term}</span>
                  {kw.category && (
                    <Badge variant="outline" className="text-[10px] font-normal px-1.5 py-0 text-zinc-400">
                      {kw.category}
                    </Badge>
                  )}
                  <Badge variant="outline" className={cn(
                    'text-[10px] font-normal px-1.5 py-0',
                    kw.source === 'llm' ? 'text-indigo-400 border-indigo-200' : 'text-zinc-400'
                  )}>
                    {kw.source === 'llm' ? 'AI' : '手动'}
                  </Badge>
                </div>
                <HeatBar heat={kw.heat} trend={kw.trend} />
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <div className={cn('flex items-center gap-1 text-[11px]', trendColor[kw.trend])}>
                  {trendIcon[kw.trend]}
                  {trendLabel[kw.trend]}
                </div>
                <span className="text-xs text-zinc-400 w-14 text-right tabular-nums">
                  {kw.mention_count_24h} 提及
                </span>
              </div>

              <button
                onClick={() => handleDelete(kw.id, kw.term)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-300 hover:text-red-500"
                title="删除"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
