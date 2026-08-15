import type { ReactNode } from 'react'

type SplitWorkspaceProps = {
  list: ReactNode
  editor: ReactNode
  listLabel: string
  editorLabel: string
}

export function SplitWorkspace({
  list,
  editor,
  listLabel,
  editorLabel,
}: SplitWorkspaceProps) {
  return (
    <div className="flex min-h-0 flex-1">
      <section aria-label={listLabel} className="min-h-0 w-1/4 min-w-[280px] max-w-[360px] shrink-0 overflow-y-auto border-r border-border bg-surface-muted">
        {list}
      </section>
      <section aria-label={editorLabel} className="min-h-0 min-w-0 flex-1 overflow-hidden bg-surface">
        {editor}
      </section>
    </div>
  )
}
