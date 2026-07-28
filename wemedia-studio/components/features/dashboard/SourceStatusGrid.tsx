import Link from 'next/link'
import { fmtRelTime } from '@/lib/format'
import type { SourceStatus } from '@/lib/api/dashboard'
import { StatusBadge } from '@/components/layout/StatusBadge'

const STATUS_META: Record<NonNullable<SourceStatus['last_status']>, { label: string; variant: 'success' | 'warning' | 'danger' }> = {
  ok: { label: '正常', variant: 'success' },
  warn: { label: '警告', variant: 'warning' },
  error: { label: '失败', variant: 'danger' },
}

export function SourceStatusGrid({ sources }: { sources: SourceStatus[] }) {
  if (sources.length === 0) return null
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold text-foreground">数据采集</h2>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {sources.map(s => (
          <Link
            key={s.key}
            href={s.href}
            title={s.last_message}
            className="rounded-xl border border-border bg-surface px-3.5 py-3 transition-shadow hover:shadow-sm"
          >
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-xs font-medium text-foreground">{s.name}</span>
              </div>
              {s.last_status ? <StatusBadge variant={STATUS_META[s.last_status].variant}>{STATUS_META[s.last_status].label}</StatusBadge> : <StatusBadge variant="neutral">未运行</StatusBadge>}
            </div>
            <div className="flex items-baseline justify-between">
              <span className={`text-sm font-semibold ${s.today_new > 0 ? 'text-foreground' : 'text-foreground-subtle'}`}>
                +{s.today_new}
              </span>
              <span className="text-[10px] text-foreground-subtle">
                {s.last_run_at ? `${s.schedule} · ${fmtRelTime(s.last_run_at)}` : s.schedule}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
