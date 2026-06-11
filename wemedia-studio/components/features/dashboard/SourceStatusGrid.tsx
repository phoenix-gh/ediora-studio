import Link from 'next/link'
import { fmtRelTime } from '@/lib/format'
import type { SourceStatus } from '@/lib/api/dashboard'

const DOT: Record<string, string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
}

export function SourceStatusGrid({ sources }: { sources: SourceStatus[] }) {
  if (sources.length === 0) return null
  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">数据采集</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-2.5">
        {sources.map(s => (
          <Link
            key={s.key}
            href={s.href}
            title={s.last_message}
            className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-3.5 py-3 hover:border-indigo-300 hover:shadow-sm transition-all"
          >
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[s.last_status ?? ''] ?? 'bg-zinc-300 dark:bg-zinc-600'}`} />
                <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">{s.name}</span>
              </div>
              <span className="text-[10px] text-zinc-400 shrink-0">{s.schedule}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className={`text-sm font-semibold ${s.today_new > 0 ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-300 dark:text-zinc-600'}`}>
                +{s.today_new}
              </span>
              <span className="text-[10px] text-zinc-400">
                {s.last_run_at ? fmtRelTime(s.last_run_at) : '未运行'}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}
