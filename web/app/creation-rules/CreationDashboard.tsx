'use client'

import type { CreationDashboardSummary } from '@/lib/api/creation-rules'

function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return <article className="rounded-xl border bg-card p-4">
    <p className="text-xs text-muted-foreground">{label}</p>
    <p className="mt-2 text-2xl font-semibold tracking-tight">{value}</p>
    {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
  </article>
}

export function CreationDashboard({ summary, date }: { summary: CreationDashboardSummary; date: string }) {
  return <section aria-label="今日概览" className="space-y-3">
    <div className="flex items-end justify-between gap-3">
      <div>
        <h2 className="font-semibold">今日概览</h2>
        <p className="text-xs text-muted-foreground">{date} · 每分钟自动刷新一次</p>
      </div>
      {summary.next_run_at && <p className="text-xs text-muted-foreground">下一次：{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(summary.next_run_at))}</p>}
    </div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Metric label="已启用规则" value={summary.enabled_rules} />
      <Metric label="今日运行" value={summary.scheduled_runs} />
      <Metric label="执行中 / 排队中" value={`${summary.running} / ${summary.queued}`} />
      <Metric label="成功 / 失败" value={`${summary.succeeded} / ${summary.failed}`} />
      <Metric label="部分完成 / 已取消" value={`${summary.partial} / ${summary.cancelled}`} />
    </div>
  </section>
}
