import { useId, type ReactNode } from 'react'

type FormSectionProps = {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  actions?: ReactNode
}

export function FormSection({ title, description, children, actions }: FormSectionProps) {
  const headingId = useId()
  const actionsLabel = typeof title === 'string' ? `${title}操作` : '分区操作'

  return (
    <section aria-labelledby={headingId} className="rounded-[12px] border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-sm font-semibold">{title}</h2>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div aria-label={actionsLabel} className="flex shrink-0 items-center gap-2" role="group">{actions}</div> : null}
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  )
}
