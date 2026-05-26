'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, TrendingUp, Settings, GitFork, AtSign, FileText, BookMarked, Tag, Quote,
  PlaySquare, Rocket, MessageSquare, Globe, Flame, Gem, Bot, UserCog, Hash,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type NavItem = {
  href: string
  label: string
  icon: React.ElementType
  disabled?: boolean
}

type NavSection = { title?: string; items: NavItem[] }

const sections: NavSection[] = [
  {
    items: [
      { href: '/',          label: '今日工作台', icon: LayoutDashboard },
      { href: '/studio',    label: '工作室',     icon: Bot },
      { href: '/profiles',  label: 'Profile',   icon: UserCog },
    ],
  },
  {
    title: '创作',
    items: [
      { href: '/drafts',    label: '草稿箱',     icon: BookMarked },
      { href: '/topics',    label: '选题库',     icon: Tag },
      { href: '/quotes',    label: '金句库',     icon: Quote },
    ],
  },
  {
    title: '信息源',
    items: [
      { href: '/github',    label: 'GitHub',       icon: GitFork },
      { href: '/papers',    label: '论文',         icon: FileText },
      { href: '/youtube',   label: 'YouTube',      icon: PlaySquare },
      { href: '/wechat',    label: '公众号',       icon: MessageSquare },
      { href: '/v2ex',      label: 'V2EX',         icon: Globe },
      { href: '/kr',        label: '36 氪',        icon: Flame },
      { href: '/juejin',    label: '掘金',         icon: Gem },
      { href: '/producthunt', label: 'Product Hunt', icon: Rocket },
      { href: '/reddit',    label: 'Reddit',       icon: Hash },
      { href: '/x',         label: 'X',            icon: AtSign },
    ],
  },
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

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {sections.map((section, i) => (
          <div key={i} className={cn(i > 0 && 'pt-3 mt-3 border-t border-zinc-100 dark:border-zinc-900')}>
            {section.title && (
              <p className="px-3 pb-1.5 text-[10px] font-semibold text-zinc-400 uppercase tracking-wider">
                {section.title}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map(({ href, label, icon: Icon, disabled }) => {
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
                      disabled && 'opacity-40 cursor-not-allowed pointer-events-none',
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
            </div>
          </div>
        ))}
      </nav>

      <div className="px-2 py-3 border-t border-zinc-100 dark:border-zinc-800">
        <Link
          href="/settings"
          className={cn(
            'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors',
            pathname === '/settings'
              ? 'bg-zinc-100 text-zinc-900 font-medium dark:bg-zinc-800 dark:text-zinc-100'
              : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-900',
          )}
        >
          <Settings className="w-4 h-4" />
          设置
        </Link>
      </div>
    </aside>
  )
}
