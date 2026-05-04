import { Badge } from '@/components/ui/badge'
import { UrgencyLevel } from '@/lib/types'
import { cn } from '@/lib/utils'

const config: Record<UrgencyLevel, { label: string; className: string }> = {
  urgent: { label: '紧急', className: 'bg-red-50 text-red-600 border-red-200 dark:bg-red-950 dark:text-red-400' },
  this_week: { label: '本周内', className: 'bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-950 dark:text-amber-400' },
  long_tail: { label: '长尾', className: 'bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400' },
}

export function UrgencyBadge({ urgency }: { urgency: UrgencyLevel }) {
  const { label, className } = config[urgency]
  return (
    <Badge variant="outline" className={cn('text-[11px] font-medium px-1.5 py-0', className)}>
      {label}
    </Badge>
  )
}
