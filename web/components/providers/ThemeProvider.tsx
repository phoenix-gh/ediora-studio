'use client'

import { ThemeProvider as NextThemesProvider } from 'next-themes'

// next-themes injects an inline script so the theme class is applied before
// paint. React 19 errors when a client component renders an executable script,
// because that script never runs on the client. The SSR markup still needs a
// real script; on the client, mark it as a data block so the error is skipped.
// https://github.com/pacocoursey/next-themes/issues/387
const clientScriptProps = { type: 'application/json' } as const

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      scriptProps={typeof window === 'undefined' ? undefined : clientScriptProps}
    >
      {children}
    </NextThemesProvider>
  )
}
