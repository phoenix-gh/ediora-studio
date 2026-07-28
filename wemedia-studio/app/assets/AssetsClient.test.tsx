// @vitest-environment jsdom

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createCreativeAsset: vi.fn(),
  createCreativeAssetDirectory: vi.fn(),
  deleteCreativeAsset: vi.fn(),
  deleteCreativeAssetDirectory: vi.fn(),
  listCreativeAssetDirectories: vi.fn(),
  renameCreativeAssetDirectory: vi.fn(),
  updateCreativeAsset: vi.fn(),
}))

vi.mock('@/lib/api/assets', () => ({
  createCreativeAsset: mocks.createCreativeAsset,
  createCreativeAssetDirectory: mocks.createCreativeAssetDirectory,
  creativeAssetUrl: (url: string) => new URL(url, 'http://media.test').toString(),
  deleteCreativeAsset: mocks.deleteCreativeAsset,
  deleteCreativeAssetDirectory: mocks.deleteCreativeAssetDirectory,
  listCreativeAssetDirectories: mocks.listCreativeAssetDirectories,
  renameCreativeAssetDirectory: mocks.renameCreativeAssetDirectory,
  updateCreativeAsset: mocks.updateCreativeAsset,
}))

vi.mock('@/app/drafts/MarkdownEditor', () => ({
  MarkdownEditor: ({ onChange, value }: { onChange: (value: string) => void; value: string }) => <textarea aria-label="Markdown content" onChange={event => onChange(event.target.value)} value={value} />,
}))

import { AssetsClient } from './AssetsClient'

const article = (id: number, title: string, content: string) => ({
  id,
  asset_type: 'article' as const,
  media_kind: '' as const,
  title,
  content,
  url: '',
  media_type: '',
  filename: '',
  directory: '',
  tags: [],
  source: '',
  created_at: '',
  updated_at: '',
})

const directory = (id: number, name: string, parentId: number | null = null) => ({
  id,
  name,
  asset_type: 'article' as const,
  parent_id: parentId,
  is_system: false,
  created_at: '',
})

const image = {
  ...article(3, '封面图', ''),
  asset_type: 'media' as const,
  media_kind: 'image' as const,
  url: '/api/uploads/cover.png',
}

function deferred<T>() {
  let reject!: (error: Error) => void
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listCreativeAssetDirectories.mockResolvedValue([])
  mocks.updateCreativeAsset.mockImplementation(async (id, body) => ({ ...article(id, body.title ?? '', body.content ?? ''), url: body.url ?? '' }))
  mocks.createCreativeAsset.mockResolvedValue(article(4, '新文章', '保留的正文'))
})

describe('creative assets workspace', () => {
  it('renders named list and editor regions for articles', () => {
    render(<AssetsClient initialAssets={[article(1, '第一篇', '正文')]} />)

    expect(screen.getByRole('region', { name: '素材列表' })).toBeVisible()
    expect(screen.getByRole('region', { name: '素材编辑器' })).toBeVisible()
  })

  it('updates the right-hand editor when another article is selected', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[article(1, '第一篇', '正文一'), article(2, '第二篇', '正文二')]} />)

    await user.click(screen.getByRole('button', { name: /第二篇/ }))

    expect(screen.getByDisplayValue('第二篇')).toBeVisible()
    expect(screen.getByRole('region', { name: '素材编辑器' })).toBeVisible()
  })

  it('saves title, content, and source URL edits for the selected article id', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[article(7, '原题', '原正文')]} />)

    const title = screen.getByPlaceholderText('文章标题')
    await user.clear(title)
    await user.type(title, '新标题')
    const content = screen.getByLabelText('Markdown content')
    await user.clear(content)
    await user.type(content, '新正文')
    const sourceUrl = screen.getByLabelText('来源 URL')
    await user.type(sourceUrl, 'https://example.com/source')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(mocks.updateCreativeAsset).toHaveBeenCalledWith(7, {
      title: '新标题',
      content: '新正文',
      url: 'https://example.com/source',
    })
  })

  it('keeps entered new-article content visible after missing-title validation', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[]} />)

    await user.click(screen.getByRole('button', { name: '新增素材' }))
    const content = screen.getByPlaceholderText('粘贴原始文章内容')
    await user.type(content, '不能因为标题为空而丢失的正文')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))

    expect(await screen.findByText('请填写标题和原始内容。')).toBeVisible()
    expect(screen.getByDisplayValue('不能因为标题为空而丢失的正文')).toBeVisible()
  })

  it('requires application confirmation before deleting an article', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[article(9, '待删除', '正文')]} />)

    await user.click(screen.getByRole('button', { name: '删除' }))

    expect(await screen.findByRole('alertdialog')).toBeVisible()
    expect(mocks.deleteCreativeAsset).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '确认' }))
    expect(mocks.deleteCreativeAsset).toHaveBeenCalledWith(9)
  })

  it('shows media in a compact 3/6/8 grid and opens its preview on double click or Enter', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[image]} />)

    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    const card = await screen.findByRole('button', { name: /封面图/ })
    const grid = card.closest('[data-slot="media-asset-grid"]')
    expect(grid).toHaveClass('grid-cols-3', 'md:grid-cols-6', 'xl:grid-cols-8')
    expect(screen.getByRole('img', { name: '封面图' })).toHaveAttribute('src', 'http://media.test/api/uploads/cover.png')
    await user.dblClick(card)

    expect(await screen.findByRole('dialog')).toHaveAttribute('data-size', 'lg')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    card.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog')).toHaveAttribute('data-size', 'lg')
  })

  it('marks the active media filter and only shows matching media', async () => {
    const user = userEvent.setup()
    const audio = { ...image, id: 4, media_kind: 'audio' as const, title: '采访录音' }
    render(<AssetsClient initialAssets={[image, audio]} />)

    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    const filters = screen.getByRole('group', { name: '媒体筛选' })
    const audioFilter = within(filters).getByRole('button', { name: '音频' })
    expect(within(filters).getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(audioFilter)

    expect(audioFilter).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /采访录音/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: /封面图/ })).toBeNull()
  })

  it('renames active directory assets locally after server rename succeeds', async () => {
    const user = userEvent.setup()
    mocks.listCreativeAssetDirectories.mockResolvedValue([directory(10, '旧目录')])
    mocks.renameCreativeAssetDirectory.mockResolvedValue(directory(10, '新目录'))
    render(<AssetsClient initialAssets={[{ ...article(10, '目录文章', '正文'), directory: '旧目录' }]} />)

    await user.click(await screen.findByRole('button', { name: /旧目录1/ }))
    await user.click(screen.getByRole('button', { name: '重命名旧目录' }))
    const name = screen.getByLabelText('目录名称')
    await user.clear(name)
    await user.type(name, '新目录')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(screen.getByRole('toolbar', { name: '新目录工作区' })).toBeVisible())
    expect(screen.getByRole('button', { name: /目录文章/ })).toBeVisible()
  })

  it('moves a deleted parent subtree assets to uncategorized when a child is active', async () => {
    const user = userEvent.setup()
    mocks.listCreativeAssetDirectories.mockResolvedValue([directory(10, '父目录'), directory(11, '子目录', 10)])
    mocks.deleteCreativeAssetDirectory.mockResolvedValue(undefined)
    render(<AssetsClient initialAssets={[{ ...article(11, '子目录文章', '正文'), directory: '子目录' }]} />)

    await user.click(await screen.findByRole('button', { name: /子目录1/ }))
    await user.click(screen.getByRole('button', { name: '删除父目录' }))
    await user.click(await screen.findByRole('button', { name: '确认' }))

    await waitFor(() => expect(screen.getByRole('toolbar', { name: '全部资产工作区' })).toBeVisible())
    expect(screen.getByRole('button', { name: /子目录文章/ })).toBeVisible()
  })

  it('keeps article form fields and announces an API create failure', async () => {
    const user = userEvent.setup()
    mocks.createCreativeAsset.mockRejectedValue(new Error('network'))
    render(<AssetsClient initialAssets={[]} />)

    await user.click(screen.getByRole('button', { name: '新增素材' }))
    await user.type(screen.getByLabelText('文章标题'), '失败文章')
    await user.type(screen.getByLabelText('原始内容'), '失败正文')
    await user.type(screen.getByLabelText(/来源 URL/), 'https://example.com/failure')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('保存文章素材失败，请重试。')
    expect(screen.getByDisplayValue('失败文章')).toBeVisible()
    expect(screen.getByDisplayValue('失败正文')).toBeVisible()
    expect(screen.getByDisplayValue('https://example.com/failure')).toBeVisible()
    await user.type(screen.getByLabelText(/来源 URL/), '/retry')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps a directory rename dialog open when the server rejects it', async () => {
    const user = userEvent.setup()
    mocks.listCreativeAssetDirectories.mockResolvedValue([directory(10, '待重命名')])
    mocks.renameCreativeAssetDirectory.mockRejectedValue(new Error('network'))
    render(<AssetsClient initialAssets={[]} />)

    await user.click(await screen.findByRole('button', { name: '重命名待重命名' }))
    const name = screen.getByLabelText('目录名称')
    await user.clear(name)
    await user.type(name, '仍在编辑')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('保存目录失败，请重试。')
    expect(screen.getByDisplayValue('仍在编辑')).toBeVisible()
  })

  it('keeps a new directory form open when the server rejects creation', async () => {
    const user = userEvent.setup()
    mocks.createCreativeAssetDirectory.mockRejectedValue(new Error('network'))
    render(<AssetsClient initialAssets={[]} />)

    await user.click(screen.getByRole('button', { name: '新增目录' }))
    await user.type(screen.getByLabelText('目录名称'), '不能丢失的目录')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('保存目录失败，请重试。')
    expect(screen.getByDisplayValue('不能丢失的目录')).toBeVisible()
  })

  it('keeps deletion confirmation open and retains assets when deletion fails', async () => {
    const user = userEvent.setup()
    mocks.deleteCreativeAsset.mockRejectedValue(new Error('network'))
    render(<AssetsClient initialAssets={[article(20, '不能删除', '正文')]} />)

    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(await screen.findByRole('button', { name: '确认' }))

    expect(await screen.findByRole('alertdialog')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('删除失败，请重试。')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('button', { name: /不能删除/ })).toBeVisible()
  })

  it('announces update failures without discarding editor values', async () => {
    const user = userEvent.setup()
    mocks.updateCreativeAsset.mockRejectedValue(new Error('network'))
    render(<AssetsClient initialAssets={[article(21, '待保存', '正文')]} />)

    const title = screen.getByLabelText('文章标题')
    await user.clear(title)
    await user.type(title, '仍待保存')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('更新文章素材失败，请重试。')
    expect(screen.getByDisplayValue('仍待保存')).toBeVisible()
  })

  it('ignores stale directory responses after changing asset type and announces current fetch failures', async () => {
    const user = userEvent.setup()
    let resolveArticle: (value: ReturnType<typeof directory>[]) => void
    const articleRequest = new Promise<ReturnType<typeof directory>[]>(resolve => { resolveArticle = resolve })
    mocks.listCreativeAssetDirectories
      .mockReturnValueOnce(articleRequest)
      .mockRejectedValueOnce(new Error('network'))
    render(<AssetsClient initialAssets={[]} />)

    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    resolveArticle!([directory(10, '过期文章目录')])

    expect(await screen.findByRole('alert')).toHaveTextContent('加载目录失败，请重试。')
    expect(screen.queryByRole('button', { name: /过期文章目录/ })).toBeNull()
  })

  it('immediately clears resolved article directories while media loading fails', async () => {
    const user = userEvent.setup()
    const mediaRequest = deferred<ReturnType<typeof directory>[]>()
    mocks.listCreativeAssetDirectories
      .mockResolvedValueOnce([directory(10, '文章目录')])
      .mockReturnValueOnce(mediaRequest.promise)
    render(<AssetsClient initialAssets={[]} />)

    expect(await screen.findByText('文章目录')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    expect(screen.queryByText('文章目录')).toBeNull()
    mediaRequest.reject(new Error('network'))

    expect(await screen.findByRole('alert')).toHaveTextContent('加载目录失败，请重试。')
    expect(screen.queryByText('文章目录')).toBeNull()
  })

  it('locks a pending article create form against close and duplicate submit', async () => {
    const user = userEvent.setup()
    const request = deferred<ReturnType<typeof article>>()
    mocks.createCreativeAsset.mockReturnValue(request.promise)
    render(<AssetsClient initialAssets={[]} />)

    await user.click(screen.getByRole('button', { name: '新增素材' }))
    await user.type(screen.getByLabelText('文章标题'), '待创建文章')
    await user.type(screen.getByLabelText('原始内容'), '待创建正文')
    const dialog = screen.getByRole('dialog')
    const save = within(dialog).getByRole('button', { name: '保存' })
    await user.click(save)
    await user.click(save)

    expect(mocks.createCreativeAsset).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('文章标题')).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled()
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull()
    await user.keyboard('{Escape}')
    expect(screen.getByRole('dialog')).toBeVisible()
    request.resolve(article(50, '待创建文章', '待创建正文'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('locks a pending directory rename to the same dialog lifecycle', async () => {
    const user = userEvent.setup()
    const request = deferred<ReturnType<typeof directory>>()
    mocks.listCreativeAssetDirectories.mockResolvedValue([directory(10, '旧目录')])
    mocks.renameCreativeAssetDirectory.mockReturnValue(request.promise)
    render(<AssetsClient initialAssets={[]} />)

    await user.click(await screen.findByRole('button', { name: '重命名旧目录' }))
    const name = screen.getByLabelText('目录名称')
    await user.clear(name)
    await user.type(name, '新目录')
    const dialog = screen.getByRole('dialog')
    const save = within(dialog).getByRole('button', { name: '保存' })
    await user.click(save)
    await user.click(save)

    expect(mocks.renameCreativeAssetDirectory).toHaveBeenCalledTimes(1)
    expect(name).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled()
    request.resolve(directory(10, '新目录'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('preserves edits made after a selected article save starts when its response resolves', async () => {
    const user = userEvent.setup()
    const request = deferred<ReturnType<typeof article>>()
    mocks.updateCreativeAsset.mockReturnValue(request.promise)
    render(<AssetsClient initialAssets={[article(60, '初始标题', '正文')]} />)

    const title = screen.getByLabelText('文章标题')
    await user.clear(title)
    await user.type(title, '已保存标题')
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(screen.getByRole('button', { name: '保存中…' })).toBeDisabled()
    await user.clear(title)
    await user.type(title, '更新中的新标题')
    request.resolve({ ...article(60, '服务端旧标题', '服务端正文') })

    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled())
    expect(screen.getByDisplayValue('更新中的新标题')).toBeVisible()
  })

  it('does not show a rejected selected-article save on another selected asset', async () => {
    const user = userEvent.setup()
    const request = deferred<ReturnType<typeof article>>()
    mocks.updateCreativeAsset.mockReturnValue(request.promise)
    render(<AssetsClient initialAssets={[article(61, '第一篇', '正文一'), article(62, '第二篇', '正文二')]} />)

    await user.click(screen.getByRole('button', { name: '保存' }))
    await user.click(screen.getByRole('button', { name: /第二篇/ }))
    request.reject(new Error('network'))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByDisplayValue('第二篇')).toBeVisible()
  })
})
