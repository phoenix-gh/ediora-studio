import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'

type StatusBadgeVariant = 'neutral' | 'data' | 'ai' | 'success' | 'warning' | 'danger' | 'info'

type StatusBadgeProps = {
  variant: StatusBadgeVariant
  children: ReactNode
}

const badgeVariants: Record<StatusBadgeVariant, React.ComponentProps<typeof Badge>['variant']> = {
  neutral: 'secondary',
  data: 'data',
  ai: 'ai',
  success: 'success',
  warning: 'warning',
  danger: 'destructive',
  info: 'info',
}

export function StatusBadge({ variant, children }: StatusBadgeProps) {
  return <Badge data-status={variant} variant={badgeVariants[variant]}>{children}</Badge>
}
