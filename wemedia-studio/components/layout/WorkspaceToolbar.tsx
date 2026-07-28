import type { ReactNode } from 'react'

type WorkspaceToolbarProps = {
  title?: ReactNode
  count?: ReactNode
  children?: ReactNode
  actions?: ReactNode
}

export function WorkspaceToolbar({ title, count, children, actions }: WorkspaceToolbarProps) {
  const label = title ? `${title}工作区` : '工作区工具栏'

  return (
    <div aria-label={label} className="flex min-h-14 items-center gap-3 border-b border-border px-7" role="toolbar">
      {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
      {count ? <span className="text-xs text-muted-foreground">{count}</span> : null}
      {children ? <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div> : <div className="flex-1" />}
      {actions ? <div aria-label="工作区操作" className="ml-auto flex shrink-0 items-center gap-2" role="group">{actions}</div> : null}
    </div>
  )
}
