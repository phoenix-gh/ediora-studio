import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { Sidebar } from '@/components/features/Sidebar'
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
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="h-full bg-zinc-50 dark:bg-zinc-950">
        <Sidebar />
        <main className="ml-56 h-screen overflow-auto">{children}</main>
        <Toaster position="bottom-right" />
      </body>
    </html>
  )
}
