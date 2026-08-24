// @vitest-environment jsdom

import { act, createRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  actions: [] as Array<Record<string, unknown>>,
  create: vi.fn(),
  destroy: vi.fn(),
  getMarkdown: vi.fn(() => ''),
  importCreativeAssetImages: vi.fn(),
  insertions: [] as string[],
  replacements: [] as string[],
  documentChangeListener: undefined as undefined | (() => void),
  markdownListener: undefined as undefined | ((ctx: unknown, markdown: string) => void),
  toastWarning: vi.fn(),
  uploadInlineAssetImage: vi.fn(),
}))

vi.mock('@milkdown/crepe', () => ({
  Crepe: class MockCrepe {
    static Feature = {
      ImageBlock: 'image-block',
      Latex: 'latex',
      TopBar: 'top-bar',
    }

    editor = {
      use: vi.fn().mockReturnThis(),
      action: vi.fn((action: (ctx: { get: () => unknown }) => unknown) => action({
        get: () => ({ state: {}, dispatch: vi.fn() }),
      })),
    }

    constructor(readonly config: Record<string, unknown>) {
      ;(globalThis as typeof globalThis & { __lastCrepeConfig?: Record<string, unknown> }).__lastCrepeConfig = config
    }

    create = mocks.create
    destroy = mocks.destroy
    getMarkdown = mocks.getMarkdown

    on(callback: (listener: { markdownUpdated: (handler: typeof mocks.markdownListener) => void }) => void) {
      callback({
        markdownUpdated(handler) {
          mocks.markdownListener = handler
        },
      })
      return this
    }
  },
}))

vi.mock('@milkdown/kit/utils', () => ({
  $prose: vi.fn((factory: () => unknown) => factory()),
  insert: vi.fn((markdown: string) => () => {
    mocks.insertions.push(markdown)
  }),
  replaceAll: vi.fn((markdown: string) => () => {
    mocks.replacements.push(markdown)
  }),
}))

vi.mock('@milkdown/kit/core', () => ({
  editorViewCtx: Symbol('editorViewCtx'),
}))

vi.mock('@/app/assets/asset-image-import-plugin', () => ({
  createAssetImageImportPlugin: vi.fn(({ onDocumentChange }: { onDocumentChange?: () => void } = {}) => {
    mocks.documentChangeListener = onDocumentChange
    return { key: 'image-import-plugin' }
  }),
  dispatchAssetImageImportAction: vi.fn((_view: unknown, action: Record<string, unknown>) => {
    mocks.actions.push(action)
  }),
}))

vi.mock('@/lib/api/assets', () => ({
  creativeAssetUrl: (url: string) => new URL(url, 'http://media.test').toString(),
  importCreativeAssetImages: mocks.importCreativeAssetImages,
  uploadInlineAssetImage: mocks.uploadInlineAssetImage,
}))

vi.mock('sonner', () => ({
  toast: { warning: mocks.toastWarning },
}))

import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor'


function pasteClipboard(
  target: HTMLElement,
  {
    file,
    html = '',
    text = '',
  }: { file?: File; html?: string; text?: string },
) {
  const clipboardData = {
    items: file
      ? [{ kind: 'file', type: file.type, getAsFile: () => file }]
      : [],
    getData: (type: string) => type === 'text/html' ? html : type === 'text/plain' ? text : '',
  }
  fireEvent.paste(target, { clipboardData })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.actions.length = 0
  mocks.insertions.length = 0
  mocks.replacements.length = 0
  mocks.documentChangeListener = undefined
  mocks.markdownListener = undefined
  mocks.create.mockResolvedValue(undefined)
  mocks.destroy.mockResolvedValue(undefined)
  mocks.getMarkdown.mockReturnValue('')
})

describe('MarkdownEditor', () => {
  it('places the visual/source switch below the editor surface', async () => {
    render(<MarkdownEditor documentKey={7} onChange={vi.fn()} value="# 初始标题" />)

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))

    const editor = screen.getByRole('textbox', { name: '可视化 Markdown 编辑器' })
    const modeTabs = screen.getByRole('tablist', { name: 'Markdown 编辑模式' })
    expect(editor.compareDocumentPosition(modeTabs) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('switches between visual and source modes without losing Markdown', async () => {
    const onChange = vi.fn()
    mocks.getMarkdown.mockReturnValue('# 当前标题\n\n保留 **Markdown**')
    render(<MarkdownEditor documentKey={7} onChange={onChange} value="# 初始标题" />)

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('tab', { name: '源码' }))

    const sourceEditor = screen.getByRole('textbox', { name: 'Markdown 源码编辑器' }) as HTMLTextAreaElement
    expect(sourceEditor.value).toBe('# 当前标题\n\n保留 **Markdown**')

    fireEvent.change(sourceEditor, { target: { value: '# 修改后的源码\n\n- 保留列表' } })
    expect(onChange).toHaveBeenLastCalledWith('# 修改后的源码\n\n- 保留列表')

    fireEvent.click(screen.getByRole('tab', { name: '可视' }))
    expect(mocks.replacements).toContain('# 修改后的源码\n\n- 保留列表')
  })

  it('inserts Markdown through its imperative handle', async () => {
    const ref = createRef<MarkdownEditorHandle>()
    render(<MarkdownEditor ref={ref} documentKey={7} onChange={vi.fn()} value="正文" />)

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    act(() => { ref.current?.insert('![图片](/api/uploads/library.png)') })

    expect(mocks.insertions).toContain('![图片](/api/uploads/library.png)')
  })

  it('queues an imperative insertion while the editor is still loading', async () => {
    const request = deferred<void>()
    mocks.create.mockReturnValueOnce(request.promise)
    const ref = createRef<MarkdownEditorHandle>()
    render(<MarkdownEditor ref={ref} documentKey={7} onChange={vi.fn()} value="正文" />)

    act(() => { ref.current?.insert('![图片](/api/uploads/loading.png)') })
    expect(mocks.insertions).not.toContain('![图片](/api/uploads/loading.png)')

    request.resolve()
    await waitFor(() => expect(mocks.insertions).toContain('![图片](/api/uploads/loading.png)'))
  })

  it('initializes with Markdown and emits content without internal image markers', async () => {
    const onChange = vi.fn()
    render(
      <MarkdownEditor
        documentKey={7}
        onChange={onChange}
        value="# 原文"
      />,
    )

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    const config = (globalThis as typeof globalThis & { __lastCrepeConfig: Record<string, unknown> }).__lastCrepeConfig
    expect(config.defaultValue).toBe('# 原文')

    mocks.markdownListener?.(
      {},
      '正文\n\n![图](https://img.example/a.png "wms-import:pending")',
    )

    expect(onChange).toHaveBeenCalledWith('正文\n\n![图](https://img.example/a.png)')
  })

  it('does not emit the initialization transaction as a content change', async () => {
    const onChange = vi.fn()
    mocks.create.mockImplementationOnce(async () => { mocks.documentChangeListener?.() })

    render(<MarkdownEditor documentKey={7} onChange={onChange} value="# 原文" />)

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    mocks.markdownListener?.({}, '# 原文')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('emits a document change after initialization has settled', async () => {
    const onChange = vi.fn()
    mocks.create.mockImplementationOnce(async () => { mocks.documentChangeListener?.() })

    render(<MarkdownEditor documentKey={7} onChange={onChange} value="# 原文" />)

    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    mocks.documentChangeListener?.()
    mocks.markdownListener?.({}, '# 修改')

    expect(onChange).toHaveBeenCalledWith('# 修改')
  })

  it('pastes webpage structure and applies ordered per-image results', async () => {
    mocks.importCreativeAssetImages.mockResolvedValue([
      {
        source_url: 'https://img.example/a.png',
        url: '/api/uploads/a.png',
        error_code: '',
        error: '',
      },
      {
        source_url: 'https://img.example/b.png',
        url: '',
        error_code: 'timeout',
        error: '图片下载超时',
      },
    ])
    render(
      <MarkdownEditor documentKey={8} onChange={vi.fn()} value="" />,
    )
    const editor = await screen.findByRole('textbox', { name: '可视化 Markdown 编辑器' })

    pasteClipboard(editor, {
      html: '<h2>标题</h2><img src="https://img.example/a.png"><img src="https://img.example/b.png">',
    })

    await waitFor(() => expect(mocks.importCreativeAssetImages).toHaveBeenCalledWith([
      'https://img.example/a.png',
      'https://img.example/b.png',
    ]))
    expect(mocks.insertions[0]).toContain('## 标题')
    expect(mocks.actions.filter(action => action.type === 'register')).toHaveLength(2)
    await waitFor(() => expect(mocks.actions.some(action => (
      action.type === 'success' && action.localUrl === '/api/uploads/a.png'
    ))).toBe(true))
    expect(mocks.actions.some(action => (
      action.type === 'failure' && action.error === '图片下载超时'
    ))).toBe(true)
    expect(mocks.toastWarning).toHaveBeenCalledWith('部分图片未保存到系统，可在图片旁重试')
  })

  it('uploads a pasted image file and inserts its relative local URL', async () => {
    mocks.uploadInlineAssetImage.mockResolvedValue('/api/uploads/pasted.png')
    render(
      <MarkdownEditor documentKey={9} onChange={vi.fn()} value="" />,
    )
    const editor = await screen.findByRole('textbox', { name: '可视化 Markdown 编辑器' })
    const file = new File(['image'], '截图.png', { type: 'image/png' })

    pasteClipboard(editor, { file })

    await waitFor(() => expect(mocks.uploadInlineAssetImage).toHaveBeenCalledWith(file))
    await waitFor(() => expect(mocks.insertions).toContain('![截图.png](/api/uploads/pasted.png)'))
  })

  it('shows an explicit retry when editor initialization fails', async () => {
    mocks.create.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined)
    render(
      <MarkdownEditor documentKey={10} onChange={vi.fn()} value="# 保留原文" />,
    )

    const retry = await screen.findByRole('button', { name: '重试加载编辑器' })
    fireEvent.click(retry)

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('textbox', { name: '可视化 Markdown 编辑器' })).toBeVisible()
  })

  it('ignores a remote-image completion after the document changes', async () => {
    const request = deferred<Array<{
      source_url: string
      url: string
      error_code: string
      error: string
    }>>()
    mocks.importCreativeAssetImages.mockReturnValue(request.promise)
    const { rerender } = render(
      <MarkdownEditor documentKey={11} onChange={vi.fn()} value="" />,
    )
    const editor = await screen.findByRole('textbox', { name: '可视化 Markdown 编辑器' })
    pasteClipboard(editor, {
      text: 'https://img.example/late.png',
    })
    await waitFor(() => expect(mocks.importCreativeAssetImages).toHaveBeenCalled())

    rerender(
      <MarkdownEditor documentKey={12} onChange={vi.fn()} value="# 下一篇" />,
    )
    request.resolve([{
      source_url: 'https://img.example/late.png',
      url: '/api/uploads/late.png',
      error_code: '',
      error: '',
    }])

    await Promise.resolve()
    expect(mocks.actions.some(action => action.type === 'success')).toBe(false)
  })
})
