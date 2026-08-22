import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PAGE_HEADER_FILES = [
  'app/assets/AssetsClient.tsx',
  'app/chat/ChatClient.tsx',
  'app/creation-rules/CreationRulesClient.tsx',
  'app/digital-humans/DigitalHumansClient.tsx',
  'app/drafts/DraftsClient.tsx',
  'app/github/GithubClient.tsx',
  'app/juejin/JuejinClient.tsx',
  'app/kr/KrClient.tsx',
  'app/papers/PapersClient.tsx',
  'app/producthunt/ProductHuntClient.tsx',
  'app/reddit/RedditClient.tsx',
  'app/responses/ResponsesClient.tsx',
  'app/text-video/TextVideoWorkbench.tsx',
  'app/v2ex/V2exClient.tsx',
  'app/wechat/WechatClient.tsx',
  'app/writing-plans/WritingPlansClient.tsx',
  'app/x/XClient.tsx',
  'app/youtube/YoutubeClient.tsx',
] as const

function readPageSource(path: (typeof PAGE_HEADER_FILES)[number]) {
  return path === 'app/chat/ChatClient.tsx'
    ? readFileSync('components/features/chat/ChatWorkspace.tsx', 'utf8')
    : readFileSync(path, 'utf8')
}

describe('page theme migration', () => {
  it('gives every primary client page an explicit page-header contract', () => {
    const missing = PAGE_HEADER_FILES.filter(path => {
      const source = readPageSource(path)
      const marker = path === 'app/assets/AssetsClient.tsx'
        ? '<WorkspaceToolbar'
        : 'data-slot="page-header"'
      return !source.includes(marker)
    })

    expect(missing).toEqual([])
  })

  it('keeps primary page headers on the shared app height token', () => {
    const missingHeight = PAGE_HEADER_FILES.filter(path => {
      if (path === 'app/assets/AssetsClient.tsx') return false
      return !readPageSource(path).includes('h-[var(--app-header-height)]')
    })

    expect(missingHeight).toEqual([])
  })

  it('removes legacy white top-level surfaces from migrated client pages', () => {
    const violations = PAGE_HEADER_FILES.filter(path => {
      const source = readPageSource(path)
      return source.includes('bg-white dark:bg-zinc-950') || source.includes('bg-white dark:bg-zinc-900')
    })

    expect(violations).toEqual([])
  })
})
