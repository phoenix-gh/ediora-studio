import type { ReactNode } from 'react'

type AppShellProps = {
  sidebar: ReactNode
  children: ReactNode
}

export function AppShell({ sidebar, children }: AppShellProps) {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      {sidebar}
      <main data-slot="app-content" className="min-h-dvh pl-[var(--sidebar-width)]">
        {children}
      </main>
    </div>
  )
}
