import Link from 'next/link'
import { AlertTriangle, Info, XCircle, ArrowRight } from 'lucide-react'
import type { DashboardAlert } from '@/lib/api/dashboard'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'

const STYLES = {
  error: { variant: 'danger', icon: XCircle },
  warn: { variant: 'warning', icon: AlertTriangle },
  info: { variant: 'info', icon: Info },
} as const

export function AlertsBar({ alerts }: { alerts: DashboardAlert[] }) {
  if (alerts.length === 0) return null
  return (
    <div className="mb-6 space-y-2">
      {alerts.map((a, i) => {
        const s = STYLES[a.severity] ?? STYLES.info
        const Icon = s.icon
        return (
          <Alert key={i} variant={s.variant}>
            <Icon />
            <AlertDescription>{a.text}</AlertDescription>
            {a.href && (
              <AlertAction>
                <Link href={a.href} className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  {a.action_label || '查看'} <ArrowRight />
                </Link>
              </AlertAction>
            )}
          </Alert>
        )
      })}
    </div>
  )
}
