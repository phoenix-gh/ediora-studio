import Link from 'next/link'
import { CalendarCheck, ArrowRight } from 'lucide-react'
import type { DailyPlan, DailyPlanItem } from '@/lib/api/daily-plan'

const CONTENT_TYPE_LABEL: Record<DailyPlanItem['content_type'], string> = {
  long: '长文',
  short: '短文',
  story: '故事',
  share: '分享',
}

const STATUS_META: Record<DailyPlanItem['status'], { label: string; className: string }> = {
  suggested: { label: '待入队', className: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' },
  enqueued: { label: '已入队', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400' },
  skipped: { label: '已跳过', className: 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500' },
}

const STATUS_ORDER: Record<DailyPlanItem['status'], number> = { suggested: 0, enqueued: 1, skipped: 2 }

export function TodayPlan({ plan }: { plan: DailyPlan | null }) {
  const items = plan
    ? [...plan.items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    : []

  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <CalendarCheck className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">今日计划</h2>
        <Link href="/daily-plan" className="ml-auto flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600">
          去今日计划 <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      {items.length === 0 ? (
        <Link
          href="/daily-plan"
          className="block bg-zinc-50 dark:bg-zinc-900/50 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-4 text-center text-zinc-400 text-xs hover:border-indigo-300"
        >
          今日计划尚未生成 · 去生成
        </Link>
      ) : (
        <div className="space-y-2">
          {items.map(item => {
            const status = STATUS_META[item.status]
            return (
              <div
                key={item.id}
                className="flex items-center gap-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm font-medium truncate ${
                      item.status === 'skipped'
                        ? 'line-through text-zinc-400'
                        : 'text-zinc-900 dark:text-zinc-100'
                    }`}
                  >
                    {item.title}
                  </p>
                  <p className="text-xs text-zinc-400 truncate mt-0.5">{item.account_name}</p>
                </div>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400 shrink-0">
                  {CONTENT_TYPE_LABEL[item.content_type]}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${status.className}`}>
                  {status.label}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
