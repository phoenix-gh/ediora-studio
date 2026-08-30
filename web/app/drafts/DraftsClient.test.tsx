// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Draft, DraftImage } from '@/lib/api/drafts'
import type { PublishAccount } from '@/lib/api/publish-accounts'
import { DRAFT_ARTIFACT_EVENT } from '@/lib/events/draft-artifacts'

const mocks = vi.hoisted(() => ({
  updateDraft: vi.fn(),
  getDrafts: vi.fn(),
  getDraftPage: vi.fn(),
  getDraftImages: vi.fn(),
  deleteDraft: vi.fn(),
  getWritingPlans: vi.fn(),
  regenerateCover: vi.fn(),
  illustrateBody: vi.fn(),
  listPublishAccounts: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
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
    getDraftPage: mocks.getDraftPage,
    getDraftImages: mocks.getDraftImages,
    deleteDraft: mocks.deleteDraft,
  }
})

vi.mock('@/lib/api/writing-plans', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/writing-plans')>()
  return {
    ...original,
    getWritingPlans: mocks.getWritingPlans,
  }
})

vi.mock('@/lib/api/studio', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/studio')>()
  return {
    ...original,
    regenerateCover: mocks.regenerateCover,
    illustrateBody: mocks.illustrateBody,
  }
})

vi.mock('@/lib/api/publish-accounts', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/api/publish-accounts')>()
  return { ...original, listPublishAccounts: mocks.listPublishAccounts }
})

vi.mock('@/components/MarkdownEditor', () => ({
  MarkdownEditor: React.forwardRef<
    { insert: (markdown: string) => void },
    { documentKey: number; value: string; onChange: (value: string) => void }
  >(function MarkdownEditor({ documentKey, value, onChange }, ref) {
    React.useImperativeHandle(ref, () => ({ insert: () => {} }), [])
    return (
      <textarea
        aria-label="草稿正文"
        data-document-key={documentKey}
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
    success: mocks.toastSuccess,
    error: mocks.toastError,
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
const publishAccount: PublishAccount = {
  id: 'account-a',
  name: '账号 A',
  platform: 'wechat',
  positioning: 'AI 工具解读',
  audience: '开发者',
  tone: '清晰',
  topic_focus: ['AI'],
  taboo: [],
  word_range: {},
  image_style: 'editorial',
  cover_style: { palette: 'cool' },
  voice_samples: [],
  style_rules: [],
  app_id: '',
  app_secret: '',
  is_active: true,
  created_at: '2026-08-04T00:00:00Z',
}
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
  vi.stubGlobal('localStorage', localStorageStub)
  mocks.getDrafts.mockResolvedValue([draftA, draftB])
  mocks.getDraftPage.mockResolvedValue({ items: [draftA, draftB], next_cursor: null })
  mocks.getDraftImages.mockResolvedValue([])
  mocks.getWritingPlans.mockResolvedValue([])
  mocks.deleteDraft.mockResolvedValue(undefined)
  mocks.listPublishAccounts.mockResolvedValue([publishAccount])
  mocks.regenerateCover.mockResolvedValue({ task_id: 'cover-task' })
  mocks.illustrateBody.mockResolvedValue({ task_id: 'illustration-task' })
})

afterEach(() => {
  cleanup()
  localStorageStub.clear()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('DraftsClient async response identity', () => {
  it('reloads a created artifact without replacing dirty editor fields or selection', async () => {
    const created = makeDraft(3, 'Agent 新草稿', 'Agent 正文', 1)
    mocks.getDraftPage.mockResolvedValue({ items: [created, draftA, draftB], next_cursor: null })
    render(
      <DraftsClient
        initialDrafts={[draftA, draftB]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )
    fireEvent.change(screen.getByPlaceholderText('标题…'), { target: { value: 'A 本地标题' } })
    fireEvent.change(screen.getByLabelText('草稿正文'), { target: { value: 'A 本地正文' } })

    window.dispatchEvent(new CustomEvent(DRAFT_ARTIFACT_EVENT, {
      detail: { kind: 'draft', id: created.id, title: created.title, url: `/drafts?draft=${created.id}` },
    }))

    expect(await screen.findByText('Agent 新草稿')).toBeInTheDocument()
    expect((screen.getByPlaceholderText('标题…') as HTMLInputElement).value).toBe('A 本地标题')
    expect((screen.getByLabelText('草稿正文') as HTMLTextAreaElement).value).toBe('A 本地正文')
    expect(screen.getByText('有未保存修改')).toBeInTheDocument()
  })

  it('selects a created artifact received from BroadcastChannel when the editor is clean', async () => {
    const channels: BroadcastChannelStub[] = []
    class BroadcastChannelStub {
      onmessage: ((event: MessageEvent) => void) | null = null
      constructor(public name: string) { channels.push(this) }
      postMessage(data: unknown) {
        for (const channel of channels) {
          if (channel !== this && channel.name === this.name) channel.onmessage?.({ data } as MessageEvent)
        }
      }
      close() {}
    }
    vi.stubGlobal('BroadcastChannel', BroadcastChannelStub)
    const created = makeDraft(3, '跨窗口草稿', '跨窗口正文', 1)
    mocks.getDraftPage.mockResolvedValue({ items: [created, draftA, draftB], next_cursor: null })
    render(<DraftsClient initialDrafts={[draftA, draftB]} initialTopics={[]} initialDraftId={draftA.id} />)

    const sender = new BroadcastChannelStub('ediora:draft-artifacts')
    sender.postMessage({ kind: 'draft', id: created.id, title: created.title, url: `/drafts?draft=${created.id}` })

    await waitFor(() => expect((screen.getByPlaceholderText('标题…') as HTMLInputElement).value).toBe('跨窗口草稿'))
    expect((screen.getByLabelText('草稿正文') as HTMLTextAreaElement).value).toBe('跨窗口正文')
  })

  it('passes the active draft id to the shared Markdown editor', () => {
    render(
      <DraftsClient
        initialDrafts={[draftA]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    expect(screen.getByLabelText('草稿正文')).toHaveAttribute('data-document-key', '1')
  })

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
    const pendingRefresh = deferred<{ items: Draft[]; next_cursor: string | null }>()
    mocks.getDraftPage.mockReturnValue(pendingRefresh.promise)
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
      pendingRefresh.resolve({
        items: [{ ...draftA, title: '草稿 A 已刷新', content: 'A 刷新正文', version: 3 }, draftB],
        next_cursor: null,
      })
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

describe('DraftsClient independent draft selection', () => {
  it('renders the exact writing target badge on every independent draft', () => {
    const xDraft = { ...draftA, id: 21, title: 'X 短帖草稿', draft_type: 'x' }
    const xArticleDraft = { ...draftA, id: 22, title: 'X Article 草稿', draft_type: 'x_article' }
    const wechatDraft = { ...draftA, id: 23, title: '公众号文章草稿', draft_type: 'mp' }

    render(
      <DraftsClient
        initialDrafts={[xDraft, xArticleDraft, wechatDraft]}
        initialTopics={[]}
        initialDraftId={xDraft.id}
      />,
    )

    expect(screen.getAllByText('X 短帖').length).toBeGreaterThan(0)
    expect(screen.getByText('X Article')).toBeInTheDocument()
    expect(screen.getByText('公众号文章')).toBeInTheDocument()
  })

  it('renders every draft independently without adaptation controls', () => {
    const xDraft = { ...draftB, title: 'X 草稿', draft_type: 'x' }
    render(
      <DraftsClient
        initialDrafts={[draftA, xDraft]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    expect(screen.queryByText('适配平台')).not.toBeInTheDocument()
    expect(screen.queryByText(/同步主版本内容/)).not.toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.getByText('草稿 A').closest('button')).toBeVisible()
    expect(screen.getByText('X 草稿').closest('button')).toBeVisible()
  })

  it('Ctrl/Cmd clicks select a draft without changing the active editor draft', () => {
    render(
      <DraftsClient
        initialDrafts={[draftA, draftB]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    const draftBRow = screen.getByText('草稿 B').closest('button')!
    fireEvent.click(draftBRow, { ctrlKey: true })

    expect(screen.getByText('已选 1 篇')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('标题…')).toHaveValue('草稿 A')
    expect(draftBRow).toHaveClass('bg-sky-50')

    fireEvent.click(draftBRow, { metaKey: true })
    expect(screen.getByText('已选 0 篇')).toBeInTheDocument()
  })

  it('opens a Ctrl-selected draft without changing bulk selection on a normal click', () => {
    render(
      <DraftsClient
        initialDrafts={[draftA, draftB]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    const draftBRow = screen.getByText('草稿 B').closest('button')!
    fireEvent.click(draftBRow, { ctrlKey: true })
    fireEvent.click(draftBRow)

    expect(screen.getByPlaceholderText('标题…')).toHaveValue('草稿 B')
    expect(screen.getByText('已选 1 篇')).toBeInTheDocument()
  })

  it('clears the batch selection and reloads the server result when the status filter changes', async () => {
    const readyDraftB = { ...draftB, status: 'ready' }
    mocks.getDraftPage.mockResolvedValue({ items: [readyDraftB], next_cursor: null })
    render(
      <DraftsClient
        initialDrafts={[draftA, readyDraftB]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    fireEvent.click(screen.getByText('草稿 A').closest('button')!, { ctrlKey: true })
    fireEvent.click(screen.getByText('草稿 B').closest('button')!, { ctrlKey: true })
    expect(screen.getByText('已选 2 篇')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('按状态筛选'), { target: { value: 'ready' } })

    await waitFor(() => expect(screen.getByText('草稿 B')).toBeInTheDocument())
    expect(screen.queryByText('已选 1 篇')).not.toBeInTheDocument()
    expect(screen.queryByText('草稿 A')).not.toBeInTheDocument()
  })
})

describe('DraftsClient themed controls', () => {
  it('uses semantic theme colors for the header writing-template select', () => {
    render(
      <DraftsClient
        initialDrafts={[draftA]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    const select = screen.getByTitle('关联写作模板')

    expect(select).toHaveClass(
      'bg-control',
      'text-foreground',
      '[color-scheme:light]',
      'dark:[color-scheme:dark]',
    )
    expect(select.querySelector('option')).toHaveClass('bg-surface', 'text-foreground')
  })
})

describe('DraftsClient bulk image dispatch', () => {
  it('submits one shared cover request for every selected draft', async () => {
    const user = userEvent.setup()
    const xDraft = {
      ...makeDraft(2, 'X 版本', 'X 正文', 1),
      draft_type: 'x',
    }
    render(
      <DraftsClient
        initialDrafts={[draftA, xDraft]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    fireEvent.click(screen.getByText('草稿 A').closest('button')!, { ctrlKey: true })
    fireEvent.click(screen.getByText('X 版本').closest('button')!, { ctrlKey: true })
    await user.click(screen.getByRole('button', { name: '批量封面' }))

    await user.click(await screen.findByLabelText('发布账号'))
    await user.click(await screen.findByRole('option', { name: /账号 A/ }))
    await user.type(screen.getByLabelText('额外指令'), '冷色调')
    await user.click(screen.getByRole('button', { name: '开始批量封面' }))

    await waitFor(() => expect(mocks.regenerateCover).toHaveBeenCalledTimes(2))
    expect(mocks.regenerateCover).toHaveBeenNthCalledWith(1, {
      draft_id: 1,
      account_id: 'account-a',
      note: '冷色调',
      cover_style: { palette: 'cool' },
    })
    expect(mocks.regenerateCover).toHaveBeenNthCalledWith(2, {
      draft_id: 2,
      account_id: 'account-a',
      note: '冷色调',
      cover_style: { palette: 'cool' },
    })
    await waitFor(() => expect(screen.getByText('已选 0 篇')).toBeInTheDocument())
    expect(mocks.toastSuccess).toHaveBeenCalledWith('批量任务已提交：成功 2，失败 0')
  })

  it('submits illustration requests directly for article and X drafts', async () => {
    const user = userEvent.setup()
    const xDraft = {
      ...makeDraft(3, '孤立 X 稿', 'X 正文', 1),
      draft_type: 'x',
    }
    render(
      <DraftsClient
        initialDrafts={[draftA, xDraft]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    await user.click(screen.getByRole('button', { name: '全选当前结果' }))
    await user.click(screen.getByRole('button', { name: '批量插图' }))
    await user.click(await screen.findByLabelText('发布账号'))
    await user.click(await screen.findByRole('option', { name: /账号 A/ }))
    fireEvent.change(screen.getByLabelText('每篇最多插图'), { target: { value: '3' } })
    await user.type(screen.getByLabelText('额外指令'), '解释结构')
    await user.click(screen.getByRole('button', { name: '开始批量插图' }))

    await waitFor(() => expect(mocks.illustrateBody).toHaveBeenCalledTimes(2))
    expect(mocks.illustrateBody).toHaveBeenNthCalledWith(1, {
      draft_id: 1,
      account_id: 'account-a',
      note: '解释结构',
      max_images: 3,
    })
    expect(mocks.illustrateBody).toHaveBeenNthCalledWith(2, {
      draft_id: 3,
      account_id: 'account-a',
      note: '解释结构',
      max_images: 3,
    })
    await waitFor(() => expect(screen.getByText('已选 0 篇')).toBeInTheDocument())
    expect(mocks.toastSuccess).toHaveBeenCalledWith('批量任务已提交：成功 2，失败 0')
  })
})

describe('DraftsClient bulk status change', () => {
  it('changes every selected draft to an existing status and clears successful selections', async () => {
    const user = userEvent.setup()
    mocks.updateDraft.mockImplementation(async (id: number, body: { status: string }) => ({
      ...(id === draftA.id ? draftA : draftB),
      status: body.status,
    }))
    render(
      <DraftsClient
        initialDrafts={[draftA, draftB]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    fireEvent.click(screen.getByText('草稿 A').closest('button')!, { ctrlKey: true })
    fireEvent.click(screen.getByText('草稿 B').closest('button')!, { ctrlKey: true })
    await user.click(screen.getByRole('button', { name: '变更状态' }))
    await user.selectOptions(screen.getByLabelText('目标状态'), 'ready')
    await user.click(screen.getByRole('button', { name: '确认变更状态' }))

    await waitFor(() => expect(mocks.updateDraft).toHaveBeenCalledTimes(2))
    expect(mocks.updateDraft).toHaveBeenNthCalledWith(1, draftA.id, { status: 'ready' })
    expect(mocks.updateDraft).toHaveBeenNthCalledWith(2, draftB.id, { status: 'ready' })
    expect(screen.getByText('已选 0 篇')).toBeInTheDocument()
    expect(mocks.toastSuccess).toHaveBeenCalledWith('批量状态变更完成：成功 2，失败 0')
  })

  it('keeps failed status changes selected and reports a partial failure', async () => {
    const user = userEvent.setup()
    mocks.updateDraft.mockImplementation(async (id: number, body: { status: string }) => {
      if (id === draftB.id) throw new Error('状态更新被拒绝')
      return { ...draftA, status: body.status }
    })
    render(<DraftsClient initialDrafts={[draftA, draftB]} initialTopics={[]} initialDraftId={draftA.id} />)

    await user.click(screen.getByRole('button', { name: '全选当前结果' }))
    await user.click(screen.getByRole('button', { name: '变更状态' }))
    await user.selectOptions(screen.getByLabelText('目标状态'), 'archived')
    await user.click(screen.getByRole('button', { name: '确认变更状态' }))

    await waitFor(() => expect(mocks.updateDraft).toHaveBeenCalledTimes(2))
    expect(screen.getByText('已选 1 篇')).toBeInTheDocument()
    expect(screen.getByText('草稿 B').closest('button')).toHaveClass('bg-sky-50')
    expect(mocks.toastError).toHaveBeenCalledWith('批量状态变更完成：成功 1，失败 1')
  })
})

describe('DraftsClient bulk draft deletion', () => {
  it('deletes every selected draft once and refreshes once after all settle', async () => {
    const user = userEvent.setup()
    const xDraft = {
      ...makeDraft(2, 'X 版本', 'X 正文', 1),
      draft_type: 'x',
    }
    const mpDraft = {
      ...makeDraft(3, '公众号版本', '公众号正文', 1),
      draft_type: 'mp',
    }
    const articleB = makeDraft(4, '文章 B', 'B 正文', 1)
    mocks.getDraftPage.mockResolvedValue({ items: [], next_cursor: null })
    render(
      <DraftsClient
        initialDrafts={[draftA, xDraft, mpDraft, articleB]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    await user.click(screen.getByRole('button', { name: '全选当前结果' }))
    await user.click(screen.getByRole('button', { name: '批量删除' }))
    expect(screen.getByText(/已选 4 篇草稿/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '确认删除' }))

    await waitFor(() => expect(mocks.deleteDraft).toHaveBeenCalledTimes(4))
    const calls = mocks.deleteDraft.mock.calls.map(([id]) => id)
    expect(calls.sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    expect(mocks.getDraftPage).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByText('选择一篇草稿开始编辑')).toBeInTheDocument())
    expect(mocks.toastSuccess).toHaveBeenCalledWith('批量删除完成：成功 4，失败 0')
  })

  it('reconciles the editor to server truth and retains a surviving failed draft', async () => {
    const user = userEvent.setup()
    mocks.deleteDraft.mockImplementation(async (id: number) => {
      if (id === draftB.id) throw new Error('删除被拒绝')
    })
    mocks.getDraftPage.mockResolvedValue({ items: [draftB], next_cursor: null })
    render(
      <DraftsClient
        initialDrafts={[draftA, draftB]}
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    await user.click(screen.getByRole('button', { name: '全选当前结果' }))
    await user.click(screen.getByRole('button', { name: '批量删除' }))
    await user.click(screen.getByRole('button', { name: '确认删除' }))

    await waitFor(() => expect(mocks.getDraftPage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByPlaceholderText('标题…')).toHaveValue('草稿 B'))
    expect(screen.queryByText('草稿 A')).not.toBeInTheDocument()
    expect(screen.getByText('已选 1 篇')).toBeInTheDocument()
    expect(screen.getByText('草稿 B').closest('button')).toHaveClass('bg-sky-50')
    expect(mocks.toastError).toHaveBeenCalledWith('批量删除完成：成功 1，失败 1')
  })
})

describe('DraftsClient incremental loading', () => {
  it('loads and renders the next page when the list sentinel becomes visible', async () => {
    let onIntersect: IntersectionObserverCallback | undefined
    class TestIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        onIntersect = callback
      }
      observe() {}
      disconnect() {}
      unobserve() {}
      takeRecords() { return [] }
      root = null
      rootMargin = ''
      thresholds = []
    }
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver)
    mocks.getDraftPage.mockResolvedValue({ items: [draftB], next_cursor: null })

    render(
      <DraftsClient
        initialDrafts={[draftA]}
        initialNextCursor="next-page"
        initialTopics={[]}
        initialDraftId={draftA.id}
      />,
    )

    await act(async () => {
      onIntersect?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
    })

    await waitFor(() => expect(screen.getByText('草稿 B')).toBeInTheDocument())
  })
})
