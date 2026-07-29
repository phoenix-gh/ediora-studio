// @vitest-environment jsdom

import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { XPost } from '@/lib/api/x'

const mocks = vi.hoisted(() => ({
  listXPosts: vi.fn(),
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
    listXPosts: mocks.listXPosts,
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
})
