'use client'

import { Topic } from '@/lib/types'
import { Badge } from '@/components/ui/badge'
import { Compass, Layers } from 'lucide-react'
import { UrgencyBadge } from './UrgencyBadge'
import { ScoreStars } from './ScoreStars'
import { MiniSparkline } from './MiniSparkline'
import { TopicActions } from './TopicActions'
import { useTopicsStore } from '@/store/topics'
import { cn } from '@/lib/utils'

const statusStyle: Record<string, string> = {
  accepted: 'border-emerald-200 bg-emerald-50/30 dark:border-emerald-800 dark:bg-emerald-950/20',
  rejected: 'border-zinc-200 bg-zinc-50/50 opacity-60 dark:border-zinc-800',
  snoozed: 'border-amber-200 bg-amber-50/20 dark:border-amber-900',
  transferred: 'border-blue-200 bg-blue-50/20 dark:border-blue-900',
  pending: 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900',
}

const statusLabel: Record<string, string> = {
  accepted: '已采纳',
  rejected: '已否决',
  snoozed: '稍后处理',
  transferred: '已转交',
}

export function TopicCard({ topic, isSelected }: { topic: Topic; isSelected: boolean }) {
  const selectTopic = useTopicsStore(s => s.selectTopic)

  return (
    <div
      onClick={() => selectTopic(topic.id)}
      className={cn(
        'rounded-xl border px-5 py-4 cursor-pointer transition-all hover:-translate-y-px hover:shadow-sm',
        statusStyle[topic.status],
        isSelected && 'ring-2 ring-indigo-400 ring-offset-1'
      )}
    >
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <UrgencyBadge urgency={topic.urgency} />
            <Badge variant="outline" className="text-[11px] text-zinc-400 border-zinc-200 font-normal px-1.5 py-0">
              {topic.category}
            </Badge>
            {topic.directionName && (
              <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-200 dark:bg-indigo-950/50 dark:text-indigo-400 dark:border-indigo-800 font-medium">
                <Compass className="w-2.5 h-2.5" />
                {topic.directionName}
              </span>
            )}
            {!!topic.clusterSourceCount && topic.clusterSourceCount > 1 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-800 font-medium">
                <Layers className="w-2.5 h-2.5" />
                同主题 {topic.clusterSourceCount} 信源
              </span>
            )}
            {topic.status !== 'pending' && (
              <span className="text-[11px] text-zinc-400 ml-auto">{statusLabel[topic.status]}</span>
            )}
          </div>

          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 leading-snug mb-1.5 line-clamp-1">
            {topic.title}
          </h3>
          <p className="text-xs text-zinc-400 leading-relaxed line-clamp-1 mb-2">
            {topic.summary}
          </p>

          <div className="flex items-center gap-3">
            <ScoreStars score={topic.score} />
            <div className="flex items-center gap-2 text-xs text-zinc-400">
              <span>{topic.sources.length} 信源</span>
              <span className="text-zinc-200 dark:text-zinc-700">·</span>
              <span>{topic.competitorCount} 竞品</span>
            </div>
            <div className="flex flex-wrap gap-1 ml-auto">
              {topic.tags.slice(0, 3).map(tag => (
                <span key={tag} className="text-[10px] text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-col items-end gap-3 flex-shrink-0">
          <div className="w-[72px]">
            <MiniSparkline data={topic.trendData} height={28} />
          </div>
          <div onClick={e => e.stopPropagation()}>
            <TopicActions topicId={topic.id} currentStatus={topic.status} compact />
          </div>
        </div>
      </div>
    </div>
  )
}
