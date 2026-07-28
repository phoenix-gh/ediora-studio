import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'

type AsyncStateProps = {
  variant: 'loading' | 'empty' | 'error'
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
}

const defaultTitles = {
  loading: '正在加载',
  empty: '暂无内容',
  error: '加载失败',
} as const

export function AsyncState({ variant, title = defaultTitles[variant], description, action }: AsyncStateProps) {
  if (variant === 'loading') {
    return (
      <div aria-label={String(title)} className="space-y-3 p-6" role="status">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-24 w-full" />
        <span className="sr-only">{title}</span>
      </div>
    )
  }

  return (
    <Empty aria-label={String(title)} className="border-border bg-surface-muted" role="status">
      <EmptyHeader>
        {variant === 'error' ? <EmptyMedia variant="icon"><AlertCircle /></EmptyMedia> : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}
