'use client'

import { Check, X, Clock, Send, PenLine } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { useTopicsStore } from '@/store/topics'
import { TopicStatus } from '@/lib/types'
import { toast } from 'sonner'

const actions: { status: TopicStatus; icon: React.ElementType; label: string; variant: 'ghost' | 'outline' }[] = [
  { status: 'accepted', icon: Check, label: '采纳', variant: 'ghost' },
  { status: 'rejected', icon: X, label: '否决', variant: 'ghost' },
  { status: 'snoozed', icon: Clock, label: '稍后', variant: 'ghost' },
  { status: 'transferred', icon: Send, label: '转交', variant: 'ghost' },
]

const statusMessages: Record<TopicStatus, string> = {
  accepted: '已采纳，加入创作计划',
  rejected: '已否决',
  snoozed: '已加入稍后处理',
  transferred: '已转交',
  pending: '已重置为待处理',
}

interface Props {
  topicId: string
  currentStatus: TopicStatus
  onAction?: () => void
  showStar?: boolean
  compact?: boolean
}

export function TopicActions({ topicId, currentStatus, onAction, compact = false }: Props) {
  const updateStatus = useTopicsStore(s => s.updateStatus)

  async function handle(status: TopicStatus) {
    const next = currentStatus === status ? 'pending' : status
    await updateStatus(topicId, next)
    toast(statusMessages[next])
    onAction?.()
  }

  return (
    <div className="flex items-center gap-1">
      {actions.map(({ status, icon: Icon, label }) => (
        <Button
          key={status}
          variant="ghost"
          size={compact ? 'sm' : 'sm'}
          onClick={(e) => { e.stopPropagation(); handle(status) }}
          className={`h-7 px-2 text-xs gap-1 ${
            currentStatus === status
              ? status === 'accepted' ? 'text-emerald-600 bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-400'
              : status === 'rejected' ? 'text-red-500 bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:text-red-400'
              : 'text-zinc-700 bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300'
              : 'text-zinc-500 hover:text-zinc-900'
          }`}
        >
          <Icon className="w-3.5 h-3.5" />
          {!compact && label}
        </Button>
      ))}
      {currentStatus === 'accepted' && (
        <Link href={`/write?topicId=${topicId}`} onClick={e => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs gap-1 text-indigo-600 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950 dark:text-indigo-400"
          >
            <PenLine className="w-3.5 h-3.5" />
            {!compact && '撰写'}
          </Button>
        </Link>
      )}
    </div>
  )
}
