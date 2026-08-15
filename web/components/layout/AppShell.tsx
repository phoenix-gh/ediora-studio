import type { ReactNode } from 'react'

type AppShellProps = {
  sidebar: ReactNode
  children: ReactNode
}

export function AppShell({ sidebar, children }: AppShellProps) {
  return (
    <div className="h-dvh overflow-hidden bg-background text-foreground">
      {sidebar}
      <main data-slot="app-content" className="h-dvh overflow-y-auto pl-[var(--sidebar-width)]">
        {children}
      </main>
    </div>
  )
}
