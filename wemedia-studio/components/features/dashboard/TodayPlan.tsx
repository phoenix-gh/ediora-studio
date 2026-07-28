import Link from 'next/link'
import { CalendarCheck, ArrowRight } from 'lucide-react'
import type { DailyPlan, DailyPlanItem } from '@/lib/api/daily-plan'
import { AsyncState } from '@/components/layout/AsyncState'
import { StatusBadge } from '@/components/layout/StatusBadge'

const CONTENT_TYPE_LABEL: Record<DailyPlanItem['content_type'], string> = {
  long: '长文',
  short: '短文',
  story: '故事',
  share: '分享',
}

const STATUS_META: Record<DailyPlanItem['status'], { label: string; variant: 'neutral' | 'success' | 'warning' }> = {
  suggested: { label: '待入队', variant: 'warning' },
  enqueued: { label: '已入队', variant: 'success' },
  skipped: { label: '已跳过', variant: 'neutral' },
}

const STATUS_ORDER: Record<DailyPlanItem['status'], number> = { suggested: 0, enqueued: 1, skipped: 2 }

export function TodayPlan({ plan }: { plan: DailyPlan | null }) {
  const items = plan
    ? [...plan.items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    : []

  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <CalendarCheck className="text-primary" />
        <h2 className="text-sm font-semibold text-foreground">今日计划</h2>
        <Link href="/daily-plan" className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline">
          去今日计划 <ArrowRight />
        </Link>
      </div>
      {items.length === 0 ? (
        <AsyncState
          variant="empty"
          title="今日计划尚未生成"
          action={<Link href="/daily-plan" className="text-primary underline-offset-4 hover:underline">去生成</Link>}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {items.map(item => {
            const status = STATUS_META[item.status]
            return (
              <div
                key={item.id}
                className="flex h-16 items-center gap-3 rounded-xl border border-border bg-surface px-4"
              >
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm font-medium truncate ${
                      item.status === 'skipped' ? 'text-foreground-subtle line-through' : 'text-foreground'
                    }`}
                  >
                    {item.title}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-foreground-subtle">{item.account_name}</p>
                </div>
                <StatusBadge variant="neutral">{CONTENT_TYPE_LABEL[item.content_type]}</StatusBadge>
                <StatusBadge variant={status.variant}>{status.label}</StatusBadge>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
