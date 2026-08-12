// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  attachPromptGeneration: vi.fn(),
  createCreativeAsset: vi.fn(),
  createCreativeAssetDirectory: vi.fn(),
  createPromptGeneration: vi.fn(),
  deletePromptGeneration: vi.fn(),
  deleteCreativeAsset: vi.fn(),
  deleteCreativeAssetDirectory: vi.fn(),
  listPromptGenerations: vi.fn(),
  listCreativeAssetDirectories: vi.fn(),
  renameCreativeAssetDirectory: vi.fn(),
  updateCreativeAssetDirectoryIngestionRule: vi.fn(),
  updateCreativeAsset: vi.fn(),
  uploadCreativeAsset: vi.fn(),
  mediaUploadProps: undefined as undefined | {
    directory: string
    onAssetUploaded: (asset: CreativeAsset) => void
    onClose: () => void
    open: boolean
  },
}))

vi.mock('@/lib/api/assets', () => ({
  attachPromptGeneration: mocks.attachPromptGeneration,
  createCreativeAsset: mocks.createCreativeAsset,
  createCreativeAssetDirectory: mocks.createCreativeAssetDirectory,
  createPromptGeneration: mocks.createPromptGeneration,
  deletePromptGeneration: mocks.deletePromptGeneration,
  creativeAssetUrl: (url: string) => new URL(url, 'http://media.test').toString(),
  deleteCreativeAsset: mocks.deleteCreativeAsset,
  deleteCreativeAssetDirectory: mocks.deleteCreativeAssetDirectory,
  listPromptGenerations: mocks.listPromptGenerations,
  listCreativeAssetDirectories: mocks.listCreativeAssetDirectories,
  renameCreativeAssetDirectory: mocks.renameCreativeAssetDirectory,
  updateCreativeAssetDirectoryIngestionRule: mocks.updateCreativeAssetDirectoryIngestionRule,
  updateCreativeAsset: mocks.updateCreativeAsset,
  uploadCreativeAsset: mocks.uploadCreativeAsset,
}))

vi.mock('@/components/MarkdownEditor', () => ({
  MarkdownEditor: ({ documentKey, onChange, value }: { documentKey: number; onChange: (value: string) => void; value: string }) => <textarea aria-label="可视化 Markdown 编辑器" data-document-key={documentKey} onChange={event => onChange(event.target.value)} value={value} />,
}))

vi.mock('./MediaUploadDialog', () => ({
  MediaUploadDialog: (props: {
    directory: string
    onAssetUploaded: (asset: CreativeAsset) => void
    onClose: () => void
    open: boolean
  }) => {
    mocks.mediaUploadProps = props
    return props.open ? <div role="dialog" aria-label="模拟多媒体上传">
      <span>目标目录：{props.directory || '未分类'}</span>
      <button onClick={() => props.onAssetUploaded({ ...image, id: 99, title: '新上传图片', directory: props.directory })} type="button">模拟上传完成</button>
      <button onClick={props.onClose} type="button">模拟关闭上传</button>
    </div> : null
  },
}))

import { AssetsClient } from './AssetsClient'
import type { CreativeAsset } from '@/lib/api/assets'

const article = (id: number, title: string, content: string): CreativeAsset => ({
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

const directory = (
  id: number,
  name: string,
  parentId: number | null = null,
  ingestion: Partial<{
    ai_ingestion_enabled: boolean
    ai_ingestion_keywords: string[]
    ai_ingestion_prompt: string
  }> = {},
) => ({
  id,
  name,
  asset_type: 'article' as const,
  parent_id: parentId,
  is_system: false,
  ai_ingestion_enabled: false,
  ai_ingestion_keywords: [],
  ai_ingestion_prompt: '',
  ...ingestion,
  created_at: '',
})

const image = {
  ...article(3, '封面图', ''),
  asset_type: 'media' as const,
  media_kind: 'image' as const,
  url: '/api/uploads/cover.png',
}

const prompt = (id = 20): CreativeAsset => ({
  ...article(id, '城市海报提示词', '未来城市，霓虹灯，电影感。'),
  asset_type: 'prompt',
  prompt_kind: 'image',
})

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
  mocks.mediaUploadProps = undefined
  mocks.listCreativeAssetDirectories.mockResolvedValue([])
  mocks.listPromptGenerations.mockResolvedValue([])
  mocks.updateCreativeAssetDirectoryIngestionRule.mockResolvedValue({
    directory_id: 0,
    enabled: false,
    keywords: [],
    prompt: '',
  })
  mocks.updateCreativeAsset.mockImplementation(async (id, body) => ({ ...article(id, body.title ?? '', body.content ?? ''), url: body.url ?? '' }))
  mocks.createCreativeAsset.mockResolvedValue(article(4, '新文章', '保留的正文'))
})

afterEach(() => cleanup())

describe('creative assets workspace', () => {
  it('fills its definite parent and delegates overflow to workspace regions', () => {
    const { container } = render(<AssetsClient initialAssets={[]} />)

    expect(container.firstElementChild).toHaveClass('h-full', 'min-h-0', 'overflow-hidden')
  })

  it('renders named list and editor regions for articles', () => {
    render(<AssetsClient initialAssets={[article(1, '第一篇', '正文')]} />)

    expect(screen.getByRole('region', { name: '素材列表' })).toBeVisible()
    expect(screen.getByRole('region', { name: '素材编辑器' })).toBeVisible()
  })

  it('opens the visual Markdown editor for the selected article', () => {
    render(<AssetsClient initialAssets={[article(1, '第一篇', '正文')]} />)

    expect(screen.getByLabelText('可视化 Markdown 编辑器')).toHaveAttribute(
      'data-document-key',
      '1',
    )
  })

  it('shows each article update time in local date-time format', () => {
    render(<AssetsClient initialAssets={[{ ...article(1, '第一篇', '正文'), updated_at: '2026-08-04T19:01:25' }]} />)

    expect(screen.getByText('更新于 2026-08-04 19:01')).toBeVisible()
  })

  it('omits the update label when an article timestamp is invalid', () => {
    render(<AssetsClient initialAssets={[{ ...article(1, '第一篇', '正文'), updated_at: 'not-a-date' }]} />)

    expect(screen.queryByText(/更新于/)).toBeNull()
  })

  it('renders a compact selected row without body preview or a redundant type label', () => {
    render(<AssetsClient initialAssets={[{ ...article(1, '紧凑标题', '列表不可见正文'), updated_at: '2026-08-04T19:01:25' }]} />)

    const list = screen.getByRole('region', { name: '素材列表' })
    const row = within(list).getByRole('button', { name: /紧凑标题/ })
    expect(within(list).queryByText('列表不可见正文')).toBeNull()
    expect(within(list).queryByText('文章')).toBeNull()
    expect(row).toHaveClass('px-4', 'py-3', 'bg-primary/10')
    expect(row).not.toHaveClass('px-5', 'py-4')
  })

  it('prefers the saved title over the first body line', () => {
    render(<AssetsClient initialAssets={[article(1, '保存标题', '# 正文首行')]} />)

    const list = screen.getByRole('region', { name: '素材列表' })
    expect(within(list).getByRole('button', { name: '保存标题' })).not.toHaveTextContent('正文首行')
  })

  it('uses the first non-empty body line without its Markdown heading marker', () => {
    render(<AssetsClient initialAssets={[article(1, '', '\n\n### 正文首行标题\n后续正文不可见')]} />)

    const list = screen.getByRole('region', { name: '素材列表' })
    const row = within(list).getByRole('button', { name: '正文首行标题' })
    expect(row).not.toHaveTextContent('#')
    expect(row).not.toHaveTextContent('后续正文不可见')
  })

  it('uses a neutral title when both the saved title and body are blank', () => {
    render(<AssetsClient initialAssets={[article(1, '   ', '\n  \n')]} />)

    const list = screen.getByRole('region', { name: '素材列表' })
    expect(within(list).getByRole('button', { name: '未命名文章' })).toBeVisible()
  })

  it('updates the right-hand editor when another article is selected', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[article(1, '第一篇', '正文一'), article(2, '第二篇', '正文二')]} />)

    await user.click(screen.getByRole('button', { name: /第二篇/ }))

    expect(screen.getByDisplayValue('第二篇')).toBeVisible()
    expect(screen.getByRole('region', { name: '素材编辑器' })).toBeVisible()
  })

  it('shows the shared focus ring when keyboard navigation reaches the article title', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[article(1, '键盘标题', '正文')]} />)

    const title = screen.getByRole('textbox', { name: '文章标题' })
    for (let step = 0; step < 20 && document.activeElement !== title; step += 1) {
      await user.tab()
    }

    expect(title).toHaveFocus()
    expect(title).toHaveClass('focus-visible:ring-3', 'focus-visible:ring-ring/50', 'dark:bg-transparent')
    expect(title).not.toHaveClass('focus-visible:ring-0')
  })

  it('saves title, content, and source URL edits for the selected article id', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[article(7, '原题', '原正文')]} />)

    const title = screen.getByPlaceholderText('文章标题')
    await user.clear(title)
    await user.type(title, '新标题')
    const content = screen.getByLabelText('可视化 Markdown 编辑器')
    await user.clear(content)
    await user.type(content, '新正文')
    const sourceUrl = screen.getByLabelText('来源 URL')
    await user.type(sourceUrl, 'https://example.com/source')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(mocks.updateCreativeAsset).toHaveBeenCalledWith(7, {
      title: '新标题',
      content: '新正文',
      directory: '',
      url: 'https://example.com/source',
    })
  })

  it.each([
    ['Ctrl+S', { ctrlKey: true }],
    ['Cmd+S', { metaKey: true }],
  ])('saves the selected article with %s and prevents browser page saving', async (_label, modifier) => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[article(7, '原题', '原正文')]} />)
    await user.clear(screen.getByLabelText('文章标题'))
    await user.type(screen.getByLabelText('文章标题'), '快捷键标题')
    const event = new KeyboardEvent('keydown', { ...modifier, cancelable: true, key: 's' })

    act(() => { window.dispatchEvent(event) })

    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => expect(mocks.updateCreativeAsset).toHaveBeenCalledWith(7, {
      title: '快捷键标题',
      content: '原正文',
      directory: '',
      url: '',
    }))
  })

  it('leaves the article save shortcut inactive while the new-article dialog is open', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[article(7, '原题', '原正文')]} />)
    await user.click(screen.getByRole('button', { name: '新增素材' }))
    const event = new KeyboardEvent('keydown', { cancelable: true, ctrlKey: true, key: 's' })

    act(() => { window.dispatchEvent(event) })

    expect(event.defaultPrevented).toBe(false)
    expect(mocks.updateCreativeAsset).not.toHaveBeenCalled()
    expect(mocks.createCreativeAsset).not.toHaveBeenCalled()
  })

  it('does not issue a duplicate shortcut save while the selected article is saving', async () => {
    const request = deferred<ReturnType<typeof article>>()
    mocks.updateCreativeAsset.mockReturnValue(request.promise)
    render(<AssetsClient initialAssets={[article(7, '原题', '原正文')]} />)
    const first = new KeyboardEvent('keydown', { cancelable: true, ctrlKey: true, key: 's' })

    act(() => { window.dispatchEvent(first) })
    await waitFor(() => expect(mocks.updateCreativeAsset).toHaveBeenCalledTimes(1))
    const second = new KeyboardEvent('keydown', { cancelable: true, ctrlKey: true, key: 's' })
    act(() => { window.dispatchEvent(second) })

    expect(mocks.updateCreativeAsset).toHaveBeenCalledTimes(1)
    request.resolve(article(7, '原题', '原正文'))
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled())
  })

  it('moves an article to the directory selected in its editor', async () => {
    const user = userEvent.setup()
    mocks.listCreativeAssetDirectories.mockResolvedValue([directory(10, '搞钱副业')])
    render(<AssetsClient initialAssets={[article(8, '待归档文章', '正文')]} />)

    await user.click(await screen.findByRole('combobox', { name: '所属目录' }))
    await user.click(await screen.findByRole('option', { name: '搞钱副业' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(mocks.updateCreativeAsset).toHaveBeenCalledWith(8, {
      title: '待归档文章',
      content: '正文',
      directory: '搞钱副业',
      url: '',
    })
  })

  it('keeps the active directory when an article editor changes that article directory', async () => {
    const user = userEvent.setup()
    mocks.listCreativeAssetDirectories.mockResolvedValue([
      directory(10, '实用工具'),
      directory(11, '搞钱副业'),
    ])
    render(<AssetsClient initialAssets={[{ ...article(12, '待迁移文章', '正文'), directory: '实用工具' }]} />)

    await user.click(await screen.findByRole('button', { name: /实用工具1/ }))
    await user.click(screen.getByRole('combobox', { name: '所属目录' }))
    await user.click(await screen.findByRole('option', { name: '搞钱副业' }))

    expect(screen.getByRole('toolbar', { name: '实用工具工作区' })).toBeVisible()
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
    expect(card).toHaveClass('hover:bg-muted/50', 'hover:border-border-strong', 'hover:shadow-sm')
    expect(card).not.toHaveClass('hover:border-primary/50')
    expect(card).toHaveClass('border-primary', 'ring-1', 'ring-primary')
    expect(screen.getByRole('img', { name: '封面图' })).toHaveAttribute('src', 'http://media.test/api/uploads/cover.png')
    await user.dblClick(card)

    expect(await screen.findByRole('dialog')).toHaveAttribute('data-size', 'lg')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    card.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('dialog')).toHaveAttribute('data-size', 'lg')
  })

  it('keeps media rows reachable while owning the remaining workspace scroll', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[image]} />)

    await user.click(screen.getByRole('tab', { name: '多媒体' }))

    const grid = screen.getByRole('button', { name: /封面图/ }).closest('[data-slot="media-asset-grid"]')
    expect(grid).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'auto-rows-max')
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

  it('renames the selected media asset with a trimmed title', async () => {
    const user = userEvent.setup()
    mocks.updateCreativeAsset.mockResolvedValue({ ...image, title: '新封面' })
    render(<AssetsClient initialAssets={[image]} />)

    expect(screen.queryByRole('button', { name: '重命名' })).toBeNull()
    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    await user.click(screen.getByRole('button', { name: '重命名' }))
    const dialog = screen.getByRole('dialog', { name: '重命名多媒体' })
    const input = within(dialog).getByLabelText('名称')
    expect(input).toHaveValue('封面图')

    await user.clear(input)
    await user.type(input, ' 新封面 ')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    expect(mocks.updateCreativeAsset).toHaveBeenCalledWith(3, { title: '新封面' })
    expect(await screen.findByRole('button', { name: /新封面/ })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: '重命名多媒体' })).toBeNull()
  })

  it('rejects an empty media name without calling the server', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[image]} />)

    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    await user.click(screen.getByRole('button', { name: '重命名' }))
    const dialog = screen.getByRole('dialog', { name: '重命名多媒体' })
    await user.clear(within(dialog).getByLabelText('名称'))
    await user.type(within(dialog).getByLabelText('名称'), '   ')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    expect(within(dialog).getByRole('alert')).toHaveTextContent('请输入名称。')
    expect(mocks.updateCreativeAsset).not.toHaveBeenCalled()
  })

  it('keeps the media rename dialog and value when the server rejects it', async () => {
    const user = userEvent.setup()
    mocks.updateCreativeAsset.mockRejectedValue(new Error('network'))
    render(<AssetsClient initialAssets={[image]} />)

    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    await user.click(screen.getByRole('button', { name: '重命名' }))
    const dialog = screen.getByRole('dialog', { name: '重命名多媒体' })
    const input = within(dialog).getByLabelText('名称')
    await user.clear(input)
    await user.type(input, '仍待重命名')
    await user.click(within(dialog).getByRole('button', { name: '保存' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('重命名失败，请重试。')
    expect(input).toHaveValue('仍待重命名')
    expect(screen.getByRole('dialog', { name: '重命名多媒体' })).toBeVisible()
  })

  it('deletes the selected media asset only after confirmation', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[image]} />)

    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    await user.click(screen.getByRole('button', { name: '删除' }))

    expect(screen.getByRole('alertdialog')).toHaveTextContent('删除这个多媒体资产？此操作无法撤销。')
    expect(mocks.deleteCreativeAsset).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '确认' }))

    expect(mocks.deleteCreativeAsset).toHaveBeenCalledWith(3)
    await waitFor(() => expect(screen.queryByRole('button', { name: /封面图/ })).toBeNull())
  })

  it('keeps media deletion confirmation open when deletion fails', async () => {
    const user = userEvent.setup()
    mocks.deleteCreativeAsset.mockRejectedValue(new Error('network'))
    render(<AssetsClient initialAssets={[image]} />)

    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '确认' }))

    expect(await screen.findByRole('alertdialog')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('删除失败，请重试。')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('button', { name: /封面图/ })).toBeVisible()
  })

  it('hides media rename and delete actions when no media asset is visible', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[]} />)

    await user.click(screen.getByRole('tab', { name: '多媒体' }))

    expect(screen.queryByRole('button', { name: '重命名' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
  })

  it('opens media-only uploads with a directory snapshot and registers successful assets', async () => {
    const user = userEvent.setup()
    const mediaDirectory = { ...directory(12, '人物参考'), asset_type: 'media' as const }
    mocks.listCreativeAssetDirectories.mockResolvedValue([mediaDirectory])
    render(<AssetsClient initialAssets={[]} />)

    expect(screen.queryByRole('button', { name: '上传' })).toBeNull()
    await user.click(screen.getByRole('tab', { name: '多媒体' }))
    await user.click(await screen.findByRole('button', { name: /人物参考0/ }))
    await user.click(screen.getByRole('button', { name: '上传' }))

    expect(screen.getByRole('dialog', { name: '模拟多媒体上传' })).toHaveTextContent('目标目录：人物参考')
    await user.click(screen.getByRole('button', { name: /全部资产0/ }))
    expect(mocks.mediaUploadProps?.directory).toBe('人物参考')

    await user.click(screen.getByRole('button', { name: '模拟上传完成' }))
    await user.click(screen.getByRole('button', { name: /人物参考1/ }))
    expect(screen.getByRole('button', { name: /新上传图片/ })).toBeVisible()

    await user.click(screen.getByRole('tab', { name: '文章' }))
    expect(screen.queryByRole('button', { name: '上传' })).toBeNull()
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

  it('saves a folder AI ingestion rule together with the folder edit', async () => {
    const user = userEvent.setup()
    mocks.listCreativeAssetDirectories.mockResolvedValue([directory(10, 'AI 工具')])
    mocks.renameCreativeAssetDirectory.mockResolvedValue(directory(10, 'AI 工具'))
    mocks.updateCreativeAssetDirectoryIngestionRule.mockResolvedValue({
      directory_id: 10,
      enabled: true,
      keywords: ['AI', '工具'],
      prompt: '只接受有实际用法的内容。',
    })
    render(<AssetsClient initialAssets={[]} />)

    await user.click(await screen.findByRole('button', { name: '重命名AI 工具' }))
    expect(screen.getByText('AI 素材入库')).toBeVisible()
    await user.click(screen.getByRole('switch', { name: '启用 AI 素材入库' }))
    await user.type(screen.getByLabelText('AI 入库关键词'), 'AI，工具')
    await user.type(screen.getByLabelText('AI 入库规则'), '只接受有实际用法的内容。')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))

    expect(mocks.updateCreativeAssetDirectoryIngestionRule).toHaveBeenCalledWith(10, {
      enabled: true,
      keywords: ['AI', '工具'],
      prompt: '只接受有实际用法的内容。',
    })
  })

  it('allows prompt folders to configure the same AI ingestion rule', async () => {
    const user = userEvent.setup()
    const promptDirectory = { ...directory(12, '图片提示词'), asset_type: 'prompt' as const }
    mocks.listCreativeAssetDirectories.mockResolvedValue([promptDirectory])
    mocks.renameCreativeAssetDirectory.mockResolvedValue(promptDirectory)
    mocks.updateCreativeAssetDirectoryIngestionRule.mockResolvedValue({
      directory_id: 12,
      enabled: true,
      keywords: [],
      prompt: '只接受帖子中完整可复用的图片提示词。',
    })
    render(<AssetsClient initialAssets={[]} />)

    await user.click(screen.getByRole('tab', { name: '提示词' }))
    await user.click(await screen.findByRole('button', { name: '重命名图片提示词' }))
    await user.click(screen.getByRole('switch', { name: '启用 AI 素材入库' }))
    await user.type(screen.getByLabelText('AI 入库规则'), '只接受帖子中完整可复用的图片提示词。')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))

    expect(mocks.updateCreativeAssetDirectoryIngestionRule).toHaveBeenCalledWith(12, {
      enabled: true,
      keywords: [],
      prompt: '只接受帖子中完整可复用的图片提示词。',
    })
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

  it('retries the current directory load locally and renders the successful result', async () => {
    const user = userEvent.setup()
    mocks.listCreativeAssetDirectories
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce([directory(10, '重试成功目录')])
    render(<AssetsClient initialAssets={[]} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('加载目录失败')
    await user.click(screen.getByRole('button', { name: '重试加载目录' }))

    expect(await screen.findByText('重试成功目录')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mocks.listCreativeAssetDirectories).toHaveBeenCalledTimes(2)
    expect(mocks.listCreativeAssetDirectories).toHaveBeenLastCalledWith('article')
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

  it('keeps a rejected save with its asset until that asset is edited', async () => {
    const user = userEvent.setup()
    const request = deferred<ReturnType<typeof article>>()
    mocks.updateCreativeAsset.mockReturnValue(request.promise)
    render(<AssetsClient initialAssets={[article(61, '第一篇', '正文一'), article(62, '第二篇', '正文二')]} />)

    await user.click(screen.getByRole('button', { name: '保存' }))
    await user.click(screen.getByRole('button', { name: /第二篇/ }))
    request.reject(new Error('network'))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByDisplayValue('第二篇')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /第一篇/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('更新文章素材失败，请重试。')
    await user.type(screen.getByLabelText('文章标题'), '已修改')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not restore a stale directory from a delayed article update after directory rename', async () => {
    const user = userEvent.setup()
    const updateRequest = deferred<ReturnType<typeof article>>()
    mocks.listCreativeAssetDirectories.mockResolvedValue([directory(10, '旧目录')])
    mocks.renameCreativeAssetDirectory.mockResolvedValue(directory(10, '新目录'))
    mocks.updateCreativeAsset.mockReturnValue(updateRequest.promise)
    render(<AssetsClient initialAssets={[{ ...article(70, '并发文章', '正文'), directory: '旧目录', tags: ['local-tag'] }]} />)

    await user.click(await screen.findByRole('button', { name: /旧目录1/ }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    await user.click(screen.getByRole('button', { name: '重命名旧目录' }))
    const name = screen.getByLabelText('目录名称')
    await user.clear(name)
    await user.type(name, '新目录')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(screen.getByRole('toolbar', { name: '新目录工作区' })).toBeVisible())

    updateRequest.resolve({ ...article(70, '服务端标题', '服务端正文'), directory: '旧目录', tags: ['stale-tag'] })
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled())
    await waitFor(() => expect(screen.getByRole('button', { name: /服务端标题/ })).toBeVisible())
  })

  it('opens the prompt asset workspace and saves prompt metadata', async () => {
    const user = userEvent.setup()
    render(<AssetsClient initialAssets={[prompt()]} />)

    await user.click(screen.getByRole('tab', { name: '提示词' }))
    expect(screen.getByRole('region', { name: '提示词列表' })).toBeVisible()
    expect(screen.getByRole('region', { name: '提示词编辑器' })).toBeVisible()
    await waitFor(() => expect(mocks.listPromptGenerations).toHaveBeenCalledWith(20))

    const title = screen.getByLabelText('提示词标题')
    await user.clear(title)
    await user.type(title, '更新后的提示词')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.updateCreativeAsset).toHaveBeenCalledWith(20, {
      content: '未来城市，霓虹灯，电影感。',
      directory: '',
      prompt_kind: 'image',
      title: '更新后的提示词',
      url: '',
    }))
  })

  it('creates a prompt asset from the prompt dialog', async () => {
    const user = userEvent.setup()
    mocks.createCreativeAsset.mockResolvedValue(prompt(50))
    render(<AssetsClient initialAssets={[]} />)

    await user.click(screen.getByRole('tab', { name: '提示词' }))
    await user.click(screen.getByRole('button', { name: '新增提示词' }))
    await user.type(screen.getByLabelText('提示词标题'), '新提示词')
    await user.type(screen.getByLabelText('提示词正文'), '一张产品海报')
    await user.selectOptions(screen.getByLabelText('新提示词类型'), 'video')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.createCreativeAsset).toHaveBeenCalledWith({
      asset_type: 'prompt',
      content: '一张产品海报',
      directory: '',
      filename: '',
      media_kind: null,
      media_type: '',
      prompt_kind: 'video',
      tags: [],
      title: '新提示词',
      url: '',
    }))
  })
})
