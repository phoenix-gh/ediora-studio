// @vitest-environment jsdom

import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { XPost } from '@/lib/api/x'

const mocks = vi.hoisted(() => ({
  listXSubscriptions: vi.fn(),
  listXPosts: vi.fn(),
  patchXSubscription: vi.fn(),
  listCreativeAssetDirectories: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@/lib/api/x', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/x')>()
  return {
    ...original,
    listXSubscriptions: mocks.listXSubscriptions,
    listXPosts: mocks.listXPosts,
    patchXSubscription: mocks.patchXSubscription,
  }
})

vi.mock('@/lib/api/assets', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/assets')>()
  return {
    ...original,
    listCreativeAssetDirectories: mocks.listCreativeAssetDirectories,
  }
})

import { XClient } from './XClient'

const post = {
  tweet_id: 'post-1',
  subscription_id: 1,
  username: 'openai',
  display_name: 'OpenAI',
  content: 'Recovered post',
  url: 'https://x.com/openai/status/post-1',
  published_at: '2026-07-30T00:00:00Z',
  collected_at: '2026-07-30T00:01:00Z',
  replies: 0,
  reposts: 0,
  likes: 0,
  views: 0,
  author_avatar: '',
  cover_image: '',
  is_reply: false,
} satisfies XPost

const newerPost = {
  ...post,
  tweet_id: 'post-2',
  content: 'Newer 24 hour feed',
  url: 'https://x.com/openai/status/post-2',
} satisfies XPost

const imagePost = {
  ...post,
  tweet_id: 'post-with-image',
  cover_image: 'https://pbs.twimg.com/media/example.jpg',
} satisfies XPost

const subscription = {
  id: 1,
  url: 'https://x.com/openai',
  label: 'OpenAI 官方账号',
  kind: 'timeline',
  enabled: true,
  raw_query: '',
  min_faves: 0,
  min_retweets: 0,
  lang: '',
  days: 7,
  extra_terms: '',
  sort: 'Latest',
  max_results: 50,
  collect_interval_minutes: 15,
  intelligence_enabled: true,
  intelligence_enabled_at: '2026-07-30T00:00:00Z',
  llm_adapter_id: null,
  ingestion_directory_ids: [5] as number[],
  last_collected_at: '2026-07-30T00:01:00Z',
  last_error: '',
  added_at: '2026-07-30T00:00:00Z',
  post_count: 1,
} as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('XClient initial feed recovery', () => {
  it('uses an add button and opens an independent editor from the sidebar', async () => {
    render(<XClient initialSubs={[subscription]} initialPosts={[post]} />)

    expect(screen.getByRole('button', { name: '新增订阅' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '订阅管理' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '编辑订阅：OpenAI 官方账号' }))

    expect(await screen.findByRole('dialog', { name: '编辑 X 订阅 · OpenAI 官方账号' })).toBeVisible()
    expect(screen.getByText('X 订阅')).toBeVisible()
  })

  it('does not select a feed when the sidebar edit button is clicked', async () => {
    render(<XClient initialSubs={[subscription]} initialPosts={[post]} />)

    fireEvent.click(screen.getByRole('button', { name: '编辑订阅：OpenAI 官方账号' }))
    await screen.findByRole('dialog', { name: '编辑 X 订阅 · OpenAI 官方账号' })

    expect(screen.getByText('X 订阅 · 全部')).toBeVisible()
  })

  it('does not expose writing-plan extraction from subscription posts', () => {
    render(<XClient initialSubs={[]} initialPosts={[post]} />)

    expect(screen.queryByRole('button', { name: '提炼方案' })).toBeNull()
    expect(screen.queryByTitle('提炼写作方案')).toBeNull()
  })

  it('does not refetch a non-empty server feed after hydration', async () => {
    render(<XClient initialSubs={[]} initialPosts={[post]} />)

    await Promise.resolve()
    expect(mocks.listXPosts).not.toHaveBeenCalled()
  })

  it('refetches an empty server feed once after hydration', async () => {
    mocks.listXPosts.mockResolvedValue([post])

    render(
      <StrictMode>
        <XClient initialSubs={[]} initialPosts={[]} />
      </StrictMode>,
    )

    await waitFor(() => {
      expect(mocks.listXPosts).toHaveBeenCalledTimes(1)
    })
    expect(mocks.listXPosts).toHaveBeenCalledWith({ hours: 168 })
  })

  it('does not let the recovery response overwrite a newer feed request', async () => {
    const recovery = deferred<XPost[]>()
    const newerFeed = deferred<XPost[]>()
    mocks.listXPosts
      .mockReturnValueOnce(recovery.promise)
      .mockReturnValueOnce(newerFeed.promise)

    render(<XClient initialSubs={[]} initialPosts={[]} />)
    fireEvent.click(screen.getByRole('button', { name: '24h' }))

    expect(mocks.listXPosts).toHaveBeenNthCalledWith(1, { hours: 168 })
    expect(mocks.listXPosts).toHaveBeenNthCalledWith(2, { hours: 24 })

    await act(async () => {
      newerFeed.resolve([newerPost])
      await newerFeed.promise
    })
    expect(screen.getByText(newerPost.content)).toBeTruthy()

    await act(async () => {
      recovery.resolve([post])
      await recovery.promise
    })
    expect(screen.getByText(newerPost.content)).toBeTruthy()
    expect(screen.queryByText(post.content)).toBeNull()
  })

  it('loads and saves multiple AI ingestion folders in the subscription editor', async () => {
    mocks.listCreativeAssetDirectories.mockResolvedValue([{
      id: 5,
      name: 'AI 工具',
      asset_type: 'article',
      parent_id: null,
      is_system: false,
      ai_ingestion_enabled: true,
      ai_ingestion_keywords: ['AI'],
      ai_ingestion_prompt: '只接受有具体案例的内容。',
      created_at: '2026-07-30T00:00:00Z',
    }, {
      id: 6,
      name: 'Agent 实践',
      asset_type: 'article',
      parent_id: null,
      is_system: false,
      ai_ingestion_enabled: true,
      ai_ingestion_keywords: ['Agent'],
      ai_ingestion_prompt: '只接受有可执行方法的内容。',
      created_at: '2026-07-30T00:00:00Z',
    }])
    const updatedSubscription = { ...subscription, ingestion_directory_ids: [5, 6] }
    mocks.patchXSubscription.mockResolvedValue(updatedSubscription)
    mocks.listXSubscriptions.mockResolvedValue([updatedSubscription])

    render(<XClient initialSubs={[subscription]} initialPosts={[post]} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑订阅：OpenAI 官方账号' }))

    expect(await screen.findByRole('checkbox', { name: /AI 工具/ })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: /Agent 实践/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存订阅' }))

    await waitFor(() => {
      expect(mocks.patchXSubscription).toHaveBeenCalledWith(1, expect.objectContaining({
        ingestion_directory_ids: [5, 6],
      }))
    })
  })

  it('loads and saves a per-subscription collection frequency from the editor', async () => {
    const updatedSubscription = { ...subscription, collect_interval_minutes: 60 }
    mocks.patchXSubscription.mockResolvedValue(updatedSubscription)
    mocks.listXSubscriptions.mockResolvedValue([updatedSubscription])

    render(<XClient initialSubs={[subscription]} initialPosts={[post]} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑订阅：OpenAI 官方账号' }))

    const select = await screen.findByLabelText('采集频率')
    expect(select).toHaveValue('15')
    fireEvent.change(select, { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: '保存订阅' }))

    await waitFor(() => {
      expect(mocks.patchXSubscription).toHaveBeenCalledWith(1, expect.objectContaining({
        collect_interval_minutes: 60,
      }))
    })
  })

  it('keeps subscription editor dropdowns readable in the active theme', async () => {
    mocks.listCreativeAssetDirectories.mockResolvedValue([{
      id: 5,
      name: 'AI 工具',
      asset_type: 'article',
      parent_id: null,
      is_system: false,
      ai_ingestion_enabled: true,
      ai_ingestion_keywords: ['AI'],
      ai_ingestion_prompt: '只接受有具体案例的内容。',
      created_at: '2026-07-30T00:00:00Z',
    }])

    render(<XClient initialSubs={[subscription]} initialPosts={[post]} />)
    fireEvent.click(screen.getByRole('button', { name: '编辑订阅：OpenAI 官方账号' }))

    expect(await screen.findByRole('checkbox', { name: /AI 工具/ })).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑订阅：OpenAI 官方账号' }))

    const frequencySelect = await screen.findByLabelText('采集频率')
    expect(frequencySelect).toHaveClass('text-foreground', 'bg-control')
    expect(frequencySelect.querySelector('option')).toHaveClass('bg-surface', 'text-foreground')
  })
})

describe('XClient post images', () => {
  it('keeps cover images fully visible instead of cropping them', () => {
    render(<XClient initialSubs={[]} initialPosts={[imagePost]} />)

    const image = document.querySelector(`img[src="${imagePost.cover_image}"]`)
    const frame = image?.parentElement

    expect(image).not.toBeNull()
    expect(frame).not.toBeNull()
    expect(image).toHaveClass('h-auto', 'max-h-[420px]', 'max-w-full', 'object-contain', 'w-auto')
    expect(image).not.toHaveClass('object-cover', 'w-full')
    expect(frame).toHaveClass('inline-block', 'max-w-full')
    expect(frame).not.toHaveClass('block', 'w-full')
  })
})
