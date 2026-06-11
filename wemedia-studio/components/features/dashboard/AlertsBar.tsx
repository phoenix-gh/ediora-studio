import Link from 'next/link'
import { AlertTriangle, Info, XCircle, ArrowRight } from 'lucide-react'
import type { DashboardAlert } from '@/lib/api/dashboard'

const STYLES = {
  error: { box: 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40', icon: XCircle, iconCls: 'text-red-500' },
  warn:  { box: 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40', icon: AlertTriangle, iconCls: 'text-amber-500' },
  info:  { box: 'border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40', icon: Info, iconCls: 'text-blue-500' },
} as const

export function AlertsBar({ alerts }: { alerts: DashboardAlert[] }) {
  if (alerts.length === 0) return null
  return (
    <div className="mb-6 space-y-2">
      {alerts.map((a, i) => {
        const s = STYLES[a.severity] ?? STYLES.info
        const Icon = s.icon
        return (
          <div key={i} className={`flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm ${s.box}`}>
            <Icon className={`w-4 h-4 shrink-0 ${s.iconCls}`} />
            <span className="flex-1 text-zinc-700 dark:text-zinc-200">{a.text}</span>
            {a.href && (
              <Link href={a.href} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 shrink-0">
                {a.action_label || '查看'} <ArrowRight className="w-3 h-3" />
              </Link>
            )}
          </div>
        )
      })}
    </div>
  )
}
