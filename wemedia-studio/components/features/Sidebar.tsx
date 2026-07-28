'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Settings, GitFork, AtSign, FileText, BookMarked, Tag, Bot,
  PlaySquare, Rocket, MessageSquare, Globe, Flame, Gem, ListChecks, Hash, CalendarCheck,
  MessageSquareReply, PersonStanding,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PRODUCT_NAME } from '@/lib/branding'

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
      { href: '/daily-plan', label: '今日计划',  icon: CalendarCheck },
      { href: '/jobs',      label: '创作任务',   icon: ListChecks },
      { href: '/chat',      label: 'AI 助手',     icon: Bot },
    ],
  },
  {
    title: '创作',
    items: [
      { href: '/drafts',       label: '草稿箱',   icon: BookMarked },
      { href: '/writing-plans', label: '写作模板', icon: Tag },
      { href: '/assets',       label: '创作资产', icon: FileText },
      { href: '/digital-humans', label: '数字人口播', icon: PersonStanding },
      { href: '/responses',    label: '待响应',   icon: MessageSquareReply },
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
    <aside className="fixed left-0 top-0 flex h-dvh w-[var(--sidebar-width)] flex-col border-r border-border bg-surface">
      <div className="sidebar-compact-header border-b border-border px-4 py-5">
        <div className="flex items-center gap-2">
          <img src="/brand/ediora-mark.svg" alt="" aria-hidden="true" className="w-6 h-6 flex-shrink-0" />
          <span className="sidebar-compact-label text-sm font-semibold">{PRODUCT_NAME}</span>
        </div>
      </div>

      <nav aria-label="主导航" className="flex-1 overflow-y-auto px-2 py-3">
        {sections.map((section, i) => (
          <div key={i} className={cn(i > 0 && 'mt-3 border-t border-border pt-3')}>
            {section.title && (
              <p className="sidebar-compact-label px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
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
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'sidebar-compact-link relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                      active
                        ? 'bg-accent font-medium text-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r before:bg-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      disabled && 'opacity-40 cursor-not-allowed pointer-events-none',
                    )}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    <span className="sidebar-compact-label">{label}</span>
                    {disabled && (
                      <span className="sidebar-compact-label ml-auto text-[10px] text-foreground-subtle">即将上线</span>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-2 py-3">
        <Link
          href="/settings"
          aria-current={pathname === '/settings' ? 'page' : undefined}
          className={cn(
            'sidebar-compact-link relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
            pathname === '/settings'
              ? 'bg-accent font-medium text-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r before:bg-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <Settings className="w-4 h-4" />
          <span className="sidebar-compact-label">设置</span>
        </Link>
      </div>
    </aside>
  )
}
