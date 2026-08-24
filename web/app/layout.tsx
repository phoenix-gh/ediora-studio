import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { Sidebar } from '@/components/features/Sidebar'
import { AppShell } from '@/components/layout/AppShell'
import { ChatWorkspaceProvider } from '@/components/features/chat/ChatWorkspaceProvider'
import { GlobalChatWidget } from '@/components/features/chat/GlobalChatWidget'
import { DeveloperModeProvider } from '@/components/providers/DeveloperModeProvider'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { Toaster } from '@/components/ui/sonner'
import { BROWSER_TITLE } from '@/lib/branding'

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
})

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: BROWSER_TITLE,
  description: '自媒体信息监控与选题决策工作台',
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-background text-foreground">
        <DeveloperModeProvider>
          <ThemeProvider>
            <ChatWorkspaceProvider>
              <AppShell sidebar={<Sidebar />}>{children}</AppShell>
              <GlobalChatWidget />
              <Toaster position="bottom-right" />
            </ChatWorkspaceProvider>
          </ThemeProvider>
        </DeveloperModeProvider>
      </body>
    </html>
  )
}
