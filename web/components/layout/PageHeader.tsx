import type { ReactNode } from 'react'

type PageHeaderProps = {
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  count?: ReactNode
  actions?: ReactNode
}

export function PageHeader({
  eyebrow,
  title,
  description,
  count,
  actions,
}: PageHeaderProps) {
  return (
    <header data-slot="page-header" className="flex h-[var(--app-header-height)] min-h-[var(--app-header-height)] items-center justify-between gap-4 overflow-hidden px-7">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {eyebrow ? <span className="shrink-0 text-xs font-medium text-muted-foreground">{eyebrow}</span> : null}
        <h1 className="shrink-0 text-[22px]/[28px] font-semibold tracking-tight">{title}</h1>
        {count ? <span className="shrink-0 text-xs/[18px] text-muted-foreground">{count}</span> : null}
        {description ? <p className="min-w-0 truncate text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div aria-label="页面操作" className="flex shrink-0 items-center gap-2" role="group">{actions}</div> : null}
    </header>
  )
}
