'use client'

import { useState } from 'react'
import { Brain, Rss, GitFork, AtSign, ScrollText, FileText, Megaphone, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppSettings } from '@/lib/api/settings'
import { AISection }       from './sections/AISection'
import { CollectSection }  from './sections/CollectSection'
import { GitHubSection }   from './sections/GitHubSection'
import { XSection }        from './sections/XSection'
import { ArxivSection }    from './sections/ArxivSection'
import { LogsSection }     from './sections/LogsSection'
import { PublishAccountsSection } from './sections/PublishAccountsSection'
import { BlogSection }     from './sections/BlogSection'

type SectionId = 'ai' | 'collect' | 'github' | 'x' | 'arxiv' | 'publish' | 'blog' | 'logs'

const NAV: { id: SectionId; label: string; icon: React.ElementType; desc: string }[] = [
  { id: 'ai',       label: 'AI 大模型',   icon: Brain,     desc: '供应商 · API Key · 模型' },
  { id: 'collect',  label: '数据采集',    icon: Rss,       desc: 'RSSHub · 采集间隔' },
  { id: 'github',   label: 'GitHub',      icon: GitFork,   desc: 'Token · Issues · Trending' },
  { id: 'x',        label: 'X / Twitter', icon: AtSign,    desc: 'camofox · Cookie · 帖子趋势' },
  { id: 'arxiv',    label: 'arXiv 论文',  icon: FileText,  desc: '采集分类 · 更新间隔' },
  { id: 'publish',  label: '发布账号',    icon: Megaphone, desc: '账号画像 · 创作流程复用' },
  { id: 'blog',     label: 'Blog 投稿',   icon: Globe,     desc: 'MK Flow · API Token · 投稿接口' },
  { id: 'logs',     label: '系统日志',    icon: ScrollText, desc: '采集运行记录' },
]

const SECTION_TITLE: Record<SectionId, string> = {
  ai:       'AI 大模型',
  collect:  '数据采集',
  github:   'GitHub 集成',
  x:        'X / Twitter 采集',
  arxiv:    'arXiv 论文采集',
  publish:  '发布账号',
  blog:     'Blog 投稿',
  logs:     '系统日志',
}

export function SettingsClient({ initialSettings }: { initialSettings: AppSettings | null }) {
  const [active, setActive] = useState<SectionId>('ai')
  const [settings, setSettings] = useState<AppSettings | null>(initialSettings)
  const isLogs = active === 'logs'

  return (
    <div className="flex h-full min-h-screen">
      {/* ── Sidebar nav ─────────────────────────────────────────────── */}
      <nav className="w-56 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 pt-8 px-3 space-y-0.5">
        <p className="px-3 pb-4 text-xs font-semibold text-zinc-400 uppercase tracking-widest">设置</p>
        {NAV.map(({ id, label, icon: Icon, desc }) => (
          <button
            key={id}
            onClick={() => setActive(id)}
            className={cn(
              'w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left transition-colors',
              active === id
                ? 'bg-white dark:bg-zinc-900 shadow-sm text-zinc-900 dark:text-zinc-100'
                : 'text-zinc-500 hover:text-zinc-900 hover:bg-white/60 dark:hover:text-zinc-100 dark:hover:bg-zinc-900/60'
            )}
          >
            <Icon className={cn('w-4 h-4 mt-0.5 flex-shrink-0',
              active === id ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-400')} />
            <div className="min-w-0">
              <div className="text-sm font-medium leading-none mb-0.5">{label}</div>
              <div className="text-[10px] text-zinc-400 leading-tight truncate">{desc}</div>
            </div>
          </button>
        ))}
      </nav>

      {/* ── Content area ────────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">
        <div className={cn(
          'px-10 py-8',
          isLogs ? 'h-full flex flex-col' : 'max-w-2xl'
        )}>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
            {SECTION_TITLE[active]}
          </h1>
          <p className={cn('text-xs text-zinc-400', isLogs ? 'mb-4' : 'mb-7')}>{NAV.find(n => n.id === active)?.desc}</p>

          {active === 'ai'       && <AISection      settings={settings} onSaved={setSettings} />}
          {active === 'collect'  && <CollectSection settings={settings} onSaved={setSettings} />}
          {active === 'github'   && <GitHubSection  settings={settings} onSaved={setSettings} />}
          {active === 'x'        && <XSection       settings={settings} onSaved={setSettings} />}
          {active === 'arxiv'    && <ArxivSection   settings={settings} onSaved={setSettings} />}
          {active === 'publish'  && <PublishAccountsSection />}
          {active === 'blog'     && <BlogSection     settings={settings} onSaved={setSettings} />}
          {active === 'logs'     && <LogsSection />}
        </div>
      </main>
    </div>
  )
}
