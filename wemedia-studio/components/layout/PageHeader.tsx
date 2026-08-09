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
    <header data-slot="page-header" className="flex min-h-[var(--app-header-height)] flex-wrap items-center justify-between gap-4 px-7 py-4">
      <div className="min-w-0">
        {eyebrow ? <p className="text-xs/[18px] font-medium text-muted-foreground">{eyebrow}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-[28px]/[34px] font-semibold tracking-tight">{title}</h1>
          {count ? <span className="text-xs/[18px] text-muted-foreground">{count}</span> : null}
        </div>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div aria-label="页面操作" className="flex shrink-0 items-center gap-2" role="group">{actions}</div> : null}
    </header>
  )
}
