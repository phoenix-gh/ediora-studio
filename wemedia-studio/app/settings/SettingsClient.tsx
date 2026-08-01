'use client'

import { useState } from 'react'
import { AudioLines, Brain, Rss, GitFork, AtSign, ScrollText, FileText, Megaphone, Globe, Search, Download, Video, Captions, Palette, Clapperboard, Puzzle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppSettings } from '@/lib/api/settings'
import { PageHeader } from '@/components/layout/PageHeader'
import { AISection }       from './sections/AISection'
import { CollectSection }  from './sections/CollectSection'
import { GitHubSection }   from './sections/GitHubSection'
import { XSection }        from './sections/XSection'
import { ArxivSection }    from './sections/ArxivSection'
import { LogsSection }     from './sections/LogsSection'
import { PublishAccountsSection } from './sections/PublishAccountsSection'
import { BlogSection }     from './sections/BlogSection'
import { WebSearchSection } from './sections/WebSearchSection'
import { WebFetchSection } from './sections/WebFetchSection'
import { HeyGenSection } from './sections/HeyGenSection'
import { TranscriptionSection } from './sections/TranscriptionSection'
import { SpeechSection } from './sections/SpeechSection'
import { YouTubeSection } from './sections/YouTubeSection'
import { AppearanceSection } from './sections/AppearanceSection'
import { TextVideoSection } from './sections/TextVideoSection'
import { SkillsSection } from './sections/SkillsSection'

type SectionId = 'ai' | 'transcription' | 'speech' | 'youtube' | 'heygen' | 'text-video' | 'skills' | 'collect' | 'github' | 'x' | 'arxiv' | 'publish' | 'blog' | 'web-search' | 'web-fetch' | 'appearance' | 'logs'

const NAV: { id: SectionId; label: string; icon: React.ElementType; desc: string }[] = [
  { id: 'ai',       label: 'AI 大模型',   icon: Brain,     desc: '供应商 · API Key · 模型' },
  { id: 'transcription', label: '语音转写', icon: Captions, desc: 'Whisper · 字幕兜底 · 音频限制' },
  { id: 'speech', label: '语音合成', icon: AudioLines, desc: 'MiMo · 音色 · TTS 密钥' },
  { id: 'youtube',  label: 'YouTube',     icon: Video, desc: 'Cookie · 字幕下载稳定性' },
  { id: 'heygen',   label: 'HeyGen',      icon: Video,     desc: '数字人 · 声音克隆 · 视频生成' },
  { id: 'text-video', label: '文字视频', icon: Clapperboard, desc: '模板 · 品牌 · 默认视觉' },
  { id: 'skills', label: '技能管理', icon: Puzzle, desc: '启用 · 上传 · 删除自定义 Skill' },
  { id: 'collect',  label: '数据采集',    icon: Rss,       desc: 'RSSHub · 采集间隔' },
  { id: 'github',   label: 'GitHub',      icon: GitFork,   desc: 'Token · Issues · Trending' },
  { id: 'x',        label: 'X / Twitter', icon: AtSign,    desc: 'camofox · Cookie · 帖子趋势' },
  { id: 'arxiv',    label: 'arXiv 论文',  icon: FileText,  desc: '采集分类 · 更新间隔' },
  { id: 'publish',  label: '发布账号',    icon: Megaphone, desc: '账号画像 · 创作流程复用' },
  { id: 'blog',     label: 'Blog 投稿',   icon: Globe,     desc: 'MK Flow · API Token · 投稿接口' },
  { id: 'web-search', label: 'Web 搜索',  icon: Search,    desc: 'SearXNG · 搜索工具 · 降级顺序' },
  { id: 'web-fetch',  label: '网页抓取',  icon: Download,  desc: '正文提取 · 浏览器降级 · 优先级' },
  { id: 'appearance', label: '外观', icon: Palette, desc: '系统 · 浅色 · 深色' },
  { id: 'logs',     label: '系统日志',    icon: ScrollText, desc: '采集运行记录' },
]

const SECTION_TITLE: Record<SectionId, string> = {
  ai:       'AI 大模型',
  transcription: '语音转写',
  speech: '语音合成',
  youtube:  'YouTube',
  heygen:   'HeyGen',
  'text-video': '文字视频',
  skills:    '技能管理',
  collect:  '数据采集',
  github:   'GitHub 集成',
  x:        'X / Twitter 采集',
  arxiv:    'arXiv 论文采集',
  publish:  '发布账号',
  blog:     'Blog 投稿',
  'web-search': 'Web 搜索',
  'web-fetch': '网页抓取',
  appearance: '外观与主题',
  logs:     '系统日志',
}

export function SettingsClient({ initialSettings }: { initialSettings: AppSettings | null }) {
  const [active, setActive] = useState<SectionId>('ai')
  const [settings, setSettings] = useState<AppSettings | null>(initialSettings)
  const isLogs = active === 'logs'

  return (
    <div
      data-testid="settings-layout"
      className="flex h-dvh min-h-0 overflow-hidden"
    >
      <nav
        aria-label="设置导航"
        className="flex w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-surface-muted px-3 py-6"
      >
        <p className="px-3 pb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">设置</p>
        {NAV.map(({ id, label, icon: Icon, desc }) => {
          const selected = active === id
          return (
            <button
              key={id}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => setActive(id)}
              className={cn(
                'flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                selected
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-surface hover:text-foreground'
              )}
            >
              <Icon className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-none">{label}</span>
                <span className="mt-1 block truncate text-xs leading-tight text-foreground-subtle">{desc}</span>
              </span>
            </button>
          )
        })}
      </nav>

      <div data-testid="settings-scroll-region" className="min-w-0 flex-1 overflow-y-auto">
        <div className={cn(
          'flex min-h-full flex-col',
          isLogs ? 'w-full' : 'max-w-[760px]'
        )} data-testid="settings-content">
          <PageHeader
            title={SECTION_TITLE[active]}
            description={NAV.find(item => item.id === active)?.desc}
          />

          <div className={cn('px-7 pb-7', isLogs && 'flex min-h-0 flex-1 flex-col')}>
            {active === 'ai'       && <AISection      settings={settings} onSaved={setSettings} />}
            {active === 'transcription' && <TranscriptionSection settings={settings} onSaved={setSettings} />}
            {active === 'speech' && <SpeechSection settings={settings} onSaved={setSettings} />}
            {active === 'youtube'  && <YouTubeSection settings={settings} onSaved={setSettings} />}
            {active === 'heygen'   && <HeyGenSection  settings={settings} onSaved={setSettings} />}
            {active === 'text-video' && <TextVideoSection settings={settings} onSaved={setSettings} />}
            {active === 'skills' && <SkillsSection />}
            {active === 'collect'  && <CollectSection settings={settings} onSaved={setSettings} />}
            {active === 'github'   && <GitHubSection  settings={settings} onSaved={setSettings} />}
            {active === 'x'        && <XSection       settings={settings} onSaved={setSettings} />}
            {active === 'arxiv'    && <ArxivSection   settings={settings} onSaved={setSettings} />}
            {active === 'publish'  && <PublishAccountsSection />}
            {active === 'blog'     && <BlogSection     settings={settings} onSaved={setSettings} />}
            {active === 'web-search' && <WebSearchSection settings={settings} onSaved={setSettings} />}
            {active === 'web-fetch' && <WebFetchSection settings={settings} onSaved={setSettings} />}
            {active === 'appearance' && <AppearanceSection />}
            {active === 'logs'     && <LogsSection />}
          </div>
        </div>
      </div>
    </div>
  )
}
