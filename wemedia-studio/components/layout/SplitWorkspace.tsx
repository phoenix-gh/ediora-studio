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
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,1fr)_minmax(0,3fr)]">
      <section aria-label={listLabel} className="min-h-0 overflow-y-auto border-r border-border bg-surface-muted">
        {list}
      </section>
      <section aria-label={editorLabel} className="min-h-0 overflow-hidden bg-surface">
        {editor}
      </section>
    </div>
  )
}
