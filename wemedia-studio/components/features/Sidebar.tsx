'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, Lightbulb, Rss, TrendingUp, Star, Settings, BarChart2, PenLine, GitFork, AtSign, Compass, FileText, BookMarked } from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { href: '/', label: '今日工作台', icon: LayoutDashboard },
  { href: '/directions', label: '内容方向', icon: Compass },
  { href: '/topics', label: '选题决策流', icon: Lightbulb },
  { href: '/write', label: '撰写文章', icon: PenLine },
  { href: '/drafts', label: '草稿箱', icon: BookMarked },
  { href: '/following', label: '关注动态', icon: Rss },
  { href: '/hotspots', label: '热点雷达', icon: TrendingUp },
  { href: '/economic', label: '经济动态', icon: BarChart2 },
  { href: '/github', label: 'GitHub 雷达', icon: GitFork },
  { href: '/papers', label: '论文追踪', icon: FileText },
  { href: '/x', label: 'X 博主候选', icon: AtSign },
  { href: '/starred', label: '已收藏', icon: Star, disabled: true },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="fixed left-0 top-0 h-screen w-56 border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950 flex flex-col">
      <div className="px-4 py-5 border-b border-zinc-100 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-indigo-600 flex items-center justify-center">
            <TrendingUp className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">WeMedia Studio</span>
        </div>
      </div>

      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon, disabled }) => {
          const active = pathname === href
          return (
            <Link
              key={href}
              href={disabled ? '#' : href}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors',
                active
                  ? 'bg-zinc-100 text-zinc-900 font-medium dark:bg-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-900',
                disabled && 'opacity-40 cursor-not-allowed pointer-events-none'
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
              {disabled && (
                <span className="ml-auto text-[10px] text-zinc-400">即将上线</span>
              )}
            </Link>
          )
        })}
      </nav>

      <div className="px-2 py-3 border-t border-zinc-100 dark:border-zinc-800">
        <Link
          href="/settings"
          className={cn(
            'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors',
            pathname === '/settings'
              ? 'bg-zinc-100 text-zinc-900 font-medium dark:bg-zinc-800 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-900'
          )}
        >
          <Settings className="w-4 h-4" />
          设置
        </Link>
      </div>
    </aside>
  )
}
