// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react'
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
  creativeAssetUrl: (url: string) => url,
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

const image = {
  ...article(3, '封面图', ''),
  asset_type: 'media' as const,
  media_kind: 'image' as const,
  url: '/api/uploads/cover.png',
}

beforeEach(() => {
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

  it('saves title and content edits for the selected article id', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[article(7, '原题', '原正文')]} />)

    const title = screen.getByPlaceholderText('文章标题')
    await user.clear(title)
    await user.type(title, '新标题')
    const content = screen.getByLabelText('Markdown content')
    await user.clear(content)
    await user.type(content, '新正文')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(mocks.updateCreativeAsset).toHaveBeenCalledWith(7, expect.objectContaining({ title: '新标题', content: '新正文' }))
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

  it('shows media in a compact grid and opens its preview on double click', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[image]} />)

    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    const card = await screen.findByRole('button', { name: /封面图/ })
    expect(card.closest('[data-slot="media-asset-grid"]')).toBeVisible()
    await user.dblClick(card)

    expect(await screen.findByRole('dialog')).toHaveAttribute('data-size', 'lg')
  })
})
