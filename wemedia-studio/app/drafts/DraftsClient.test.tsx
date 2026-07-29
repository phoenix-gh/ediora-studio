// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Draft, DraftImage } from '@/lib/api/drafts'

const mocks = vi.hoisted(() => ({
  updateDraft: vi.fn(),
  getDrafts: vi.fn(),
  getDraftImages: vi.fn(),
  getWritingPlans: vi.fn(),
}))

const storedValues = new Map<string, string>()
const localStorageStub = {
  getItem: (key: string) => storedValues.get(key) ?? null,
  setItem: (key: string, value: string) => { storedValues.set(key, value) },
  removeItem: (key: string) => { storedValues.delete(key) },
  clear: () => { storedValues.clear() },
  key: (index: number) => [...storedValues.keys()][index] ?? null,
  get length() { return storedValues.size },
}
vi.stubGlobal('localStorage', localStorageStub)

vi.mock('@/lib/api/drafts', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/drafts')>()
  return {
    ...original,
    updateDraft: mocks.updateDraft,
    getDrafts: mocks.getDrafts,
    getDraftImages: mocks.getDraftImages,
  }
})

vi.mock('@/lib/api/writing-plans', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/writing-plans')>()
  return {
    ...original,
    getWritingPlans: mocks.getWritingPlans,
  }
})

vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: React.forwardRef<
    unknown,
    { value: string; onChange: (value: string) => void }
  >(function MarkdownEditor({ value, onChange }, ref) {
    void ref
    return (
      <textarea
        aria-label="草稿正文"
        value={value}
        onChange={event => onChange(event.target.value)}
      />
    )
  }),
}))

vi.mock('./PublishDialog', () => ({
  PublishDialog: () => null,
}))

vi.mock('@/components/features/DraftAssetsDialog', () => ({
  DraftAssetsDialog: () => null,
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

import { DraftsClient } from './DraftsClient'

function makeDraft(id: number, title: string, content: string, version: number): Draft {
  return {
    id,
    topic_id: `topic-${id}`,
    writing_plan_id: null,
    title,
    content,
    status: 'drafting',
    draft_type: 'article',
    linked_draft_id: null,
    series_id: null,
    series_order: 0,
    version,
    sources: [],
    created_at: '2026-07-30T00:00:00Z',
    updated_at: '2026-07-30T00:00:00Z',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

const draftA = makeDraft(1, '草稿 A', 'A 正文', 1)
const draftB = makeDraft(2, '草稿 B', 'B 正文', 2)
const refreshedImage = {
  id: 10,
  filename: 'cover.png',
  original_name: '封面.png',
  url: '/api/uploads/cover.png',
  hosted_url: '',
  size_bytes: 1024,
  mime_type: 'image/png',
  created_at: '2026-07-30T00:00:00Z',
} satisfies DraftImage

beforeEach(() => {
  mocks.getDrafts.mockResolvedValue([draftA, draftB])
  mocks.getDraftImages.mockResolvedValue([])
  mocks.getWritingPlans.mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  localStorageStub.clear()
  vi.clearAllMocks()
})

describe('DraftsClient async response identity', () => {
  it('does not let a stale A save response reclaim selection after switching to B', async () => {
    const pendingSave = deferred<Draft>()
    mocks.updateDraft.mockReturnValue(pendingSave.promise)
    render(
      <DraftsClient
        initialDrafts={[draftA, draftB]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    fireEvent.change(screen.getByLabelText('草稿正文'), {
      target: { value: 'A 本地修改' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    fireEvent.click(screen.getByText('草稿 B').closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: '放弃修改' }))

    expect((screen.getByPlaceholderText('标题…') as HTMLInputElement).value).toBe('草稿 B')
    expect((screen.getByLabelText('草稿正文') as HTMLTextAreaElement).value).toBe('B 正文')
    expect(screen.getByText(/v2 ·/)).toBeTruthy()

    await act(async () => {
      pendingSave.resolve({ ...draftA, title: '草稿 A 已保存', content: 'A 服务端正文' })
      await pendingSave.promise
    })

    expect((screen.getByPlaceholderText('标题…') as HTMLInputElement).value).toBe('草稿 B')
    expect((screen.getByLabelText('草稿正文') as HTMLTextAreaElement).value).toBe('B 正文')
    expect(screen.getByText(/v2 ·/)).toBeTruthy()
  })

  it('does not let a stale A refresh response reclaim selection after switching to B', async () => {
    const pendingRefresh = deferred<Draft[]>()
    mocks.getDrafts.mockReturnValue(pendingRefresh.promise)
    const { container } = render(
      <DraftsClient
        initialDrafts={[draftA, draftB]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    const refreshButton = container.querySelectorAll('aside button')[1]
    fireEvent.click(refreshButton)
    fireEvent.click(screen.getByText('草稿 B').closest('button')!)

    await act(async () => {
      pendingRefresh.resolve([
        { ...draftA, title: '草稿 A 已刷新', content: 'A 刷新正文', version: 3 },
        draftB,
      ])
      await pendingRefresh.promise
    })

    expect((screen.getByPlaceholderText('标题…') as HTMLInputElement).value).toBe('草稿 B')
    expect((screen.getByLabelText('草稿正文') as HTMLTextAreaElement).value).toBe('B 正文')
    expect(screen.getByText(/v2 ·/)).toBeTruthy()
  })

  it('fully applies a save response when its draft is still the active selection', async () => {
    const pendingSave = deferred<Draft>()
    mocks.updateDraft.mockReturnValue(pendingSave.promise)
    mocks.getDraftImages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([refreshedImage])
    localStorageStub.setItem(
      `wms-chat-${draftA.id}`,
      JSON.stringify({
        history: [{ role: 'assistant', content: '保留的会话' }],
        sessionName: '测试会话',
        pending: null,
      }),
    )
    render(
      <DraftsClient
        initialDrafts={[draftA]}
        initialTopics={[]}
        initialDraftId={draftA.id}
        initialChatOpen
      />,
    )

    expect(screen.getByText('保留的会话')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('草稿正文'), {
      target: { value: 'A 本地修改' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await act(async () => {
      pendingSave.resolve({ ...draftA, title: '草稿 A 已保存', content: 'A 服务端正文' })
      await pendingSave.promise
    })

    expect((screen.getByPlaceholderText('标题…') as HTMLInputElement).value).toBe('草稿 A 已保存')
    expect((screen.getByLabelText('草稿正文') as HTMLTextAreaElement).value).toBe('A 服务端正文')
    expect(screen.getByText('保留的会话')).toBeTruthy()
    expect(mocks.getDraftImages).toHaveBeenCalledTimes(2)
    expect(mocks.getDraftImages).toHaveBeenNthCalledWith(2, draftA.id)
    expect(await screen.findByRole('button', { name: /素材\s*1/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /文章\s*主版本/ }))
    expect((screen.getByPlaceholderText('标题…') as HTMLInputElement).value).toBe('草稿 A 已保存')
    expect((screen.getByLabelText('草稿正文') as HTMLTextAreaElement).value).toBe('A 服务端正文')
  })

  it('does not restore stale chat state when the active save response arrives', async () => {
    const pendingSave = deferred<Draft>()
    mocks.updateDraft.mockReturnValue(pendingSave.promise)
    localStorageStub.setItem(
      `wms-chat-${draftA.id}`,
      JSON.stringify({
        history: [{ role: 'assistant', content: '旧会话消息' }],
        sessionName: '旧会话',
        pending: null,
      }),
    )
    render(
      <DraftsClient
        initialDrafts={[draftA]}
        initialTopics={[]}
        initialDraftId={draftA.id}
        initialChatOpen
      />,
    )

    fireEvent.change(screen.getByLabelText('草稿正文'), {
      target: { value: 'A 本地修改' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    fireEvent.click(screen.getByRole('button', { name: '新对话' }))
    expect(screen.queryByText('旧会话消息')).toBeNull()

    await act(async () => {
      pendingSave.resolve({ ...draftA, title: '草稿 A 已保存', content: 'A 服务端正文' })
      await pendingSave.promise
    })

    expect(screen.queryByText('旧会话消息')).toBeNull()
    expect(screen.getByText('可以说：')).toBeTruthy()
  })
})
