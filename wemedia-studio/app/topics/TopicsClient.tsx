'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { UrgencyLevel } from '@/lib/types'
import { getTopics } from '@/lib/api/topics'
import { useTopicsStore } from '@/store/topics'
import { TopicCard } from '@/components/features/TopicCard'
import { TopicDrawer } from '@/components/features/TopicDrawer'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Filter, Inbox } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const CATEGORIES = ['人工智能', '大模型', '芯片', '开源', '编程工具', '操作系统', '安全', '区块链', '量子计算']
const URGENCY_OPTIONS: { value: UrgencyLevel; label: string }[] = [
  { value: 'urgent', label: '紧急' },
  { value: 'this_week', label: '本周内' },
  { value: 'long_tail', label: '长尾' },
]

export function TopicsClient({ initialId }: { initialId?: string }) {
  const { topics, setTopics, selectedTopicId, selectTopic, updateStatus, isDrawerOpen } = useTopicsStore()

  const [loading, setLoading] = useState(true)
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [selectedUrgency, setSelectedUrgency] = useState<UrgencyLevel[]>([])
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [sortBy, setSortBy] = useState<'score' | 'createdAt' | 'urgency'>('score')
  const [focusedIdx, setFocusedIdx] = useState(0)
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])

  useEffect(() => {
    async function load() {
      const data = await getTopics()
      setTopics(data)
      setLoading(false)
      if (initialId) selectTopic(initialId)
    }
    load()
  }, [setTopics, selectTopic, initialId])

  const filtered = topics.filter(t => {
    if (selectedCategories.length && !selectedCategories.includes(t.category)) return false
    if (selectedUrgency.length && !selectedUrgency.includes(t.urgency)) return false
    if (unreadOnly && t.status !== 'pending') return false
    return true
  }).sort((a, b) => {
    if (sortBy === 'score') return b.score - a.score
    if (sortBy === 'createdAt') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    const order = { urgent: 0, this_week: 1, long_tail: 2 }
    return order[a.urgency] - order[b.urgency]
  })

  // 焦点变化时滚动到视口
  useEffect(() => {
    cardRefs.current[focusedIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusedIdx])

  const toggleCategory = (cat: string) =>
    setSelectedCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat])

  const toggleUrgency = (u: UrgencyLevel) =>
    setSelectedUrgency(prev => prev.includes(u) ? prev.filter(x => x !== u) : [...prev, u])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (isDrawerOpen || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

    const topic = filtered[focusedIdx]
    if (!topic) return

    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault()
        setFocusedIdx(i => Math.min(i + 1, filtered.length - 1))
        break
      case 'k':
      case 'ArrowUp':
        e.preventDefault()
        setFocusedIdx(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        selectTopic(topic.id)
        break
      case 'y':
        updateStatus(topic.id, topic.status === 'accepted' ? 'pending' : 'accepted')
        toast(topic.status === 'accepted' ? '已重置为待处理' : '已采纳，加入创作计划')
        break
      case 'n':
        updateStatus(topic.id, topic.status === 'rejected' ? 'pending' : 'rejected')
        toast(topic.status === 'rejected' ? '已重置为待处理' : '已否决')
        break
      case ' ':
        e.preventDefault()
        updateStatus(topic.id, topic.status === 'snoozed' ? 'pending' : 'snoozed')
        toast(topic.status === 'snoozed' ? '已重置为待处理' : '已加入稍后处理')
        break
    }
  }, [filtered, focusedIdx, isDrawerOpen, selectTopic, updateStatus])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  useEffect(() => {
    if (!isDrawerOpen) return
    const idx = filtered.findIndex(t => t.id === selectedTopicId)
    if (idx >= 0) setFocusedIdx(idx)
  }, [selectedTopicId, isDrawerOpen, filtered])

  const pendingCount = topics.filter(t => t.status === 'pending').length

  return (
    <>
      <div className="px-8 py-8">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1">选题决策流</h1>
          <p className="text-sm text-zinc-500">
            {pendingCount} 条待处理 · 共 {topics.length} 条
            <span className="ml-2 text-zinc-400 text-xs">J/K 导航 · Y 采纳 · N 否决 · Space 稍后</span>
          </p>
        </div>

        {/* Filter bar — 吸顶 */}
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

            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-zinc-500">紧迫度</div>
              <div className="flex gap-1.5">
                {URGENCY_OPTIONS.map(({ value, label }) => (
                  <Badge
                    key={value}
                    variant="outline"
                    onClick={() => toggleUrgency(value)}
                    className={cn(
                      'cursor-pointer text-[11px] px-2 py-0.5 font-normal transition-colors',
                      selectedUrgency.includes(value)
                        ? value === 'urgent' ? 'bg-red-50 border-red-300 text-red-600 dark:bg-red-950'
                          : value === 'this_week' ? 'bg-amber-50 border-amber-300 text-amber-600 dark:bg-amber-950'
                          : 'bg-zinc-100 border-zinc-400 text-zinc-600'
                        : 'hover:border-zinc-400'
                    )}
                  >
                    {label}
                  </Badge>
                ))}
              </div>

              <div className="ml-auto flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-zinc-500 cursor-pointer">
                  <Switch checked={unreadOnly} onCheckedChange={setUnreadOnly} className="scale-75" />
                  仅未读
                </label>
                <Select value={sortBy} onValueChange={v => v && setSortBy(v as typeof sortBy)}>
                  <SelectTrigger className="h-7 text-xs w-[100px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="score" className="text-xs">按评分</SelectItem>
                    <SelectItem value="urgency" className="text-xs">按紧迫度</SelectItem>
                    <SelectItem value="createdAt" className="text-xs">按时间</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </div>

        {/* List */}
        <div className="space-y-2 pt-2">
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-[100px] rounded-xl" />
            ))
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Inbox className="w-10 h-10 text-zinc-300 dark:text-zinc-700 mb-3" />
              <p className="text-sm font-medium text-zinc-500">暂无匹配选题</p>
              <p className="text-xs text-zinc-400 mt-1">调整筛选条件或等待新选题推送</p>
            </div>
          ) : (
            filtered.map((topic, idx) => (
              <div
                key={topic.id}
                ref={el => { cardRefs.current[idx] = el }}
                className="scroll-mt-36"
              >
                <TopicCard
                  topic={topic}
                  isSelected={idx === focusedIdx}
                />
              </div>
            ))
          )}
        </div>
      </div>

      <TopicDrawer />
    </>
  )
}
