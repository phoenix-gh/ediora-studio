// @vitest-environment jsdom

import { act, createRef } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  actions: [] as Array<Record<string, unknown>>,
  create: vi.fn(),
  destroy: vi.fn(),
  importCreativeAssetImages: vi.fn(),
  insertions: [] as string[],
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
    getMarkdown = vi.fn(() => '')

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
  $prose: vi.fn((factory: () => unknown) => factory),
  insert: vi.fn((markdown: string) => () => {
    mocks.insertions.push(markdown)
  }),
}))

vi.mock('@milkdown/kit/core', () => ({
  editorViewCtx: Symbol('editorViewCtx'),
}))

vi.mock('@/app/assets/asset-image-import-plugin', () => ({
  createAssetImageImportPlugin: vi.fn(() => ({ key: 'image-import-plugin' })),
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
  mocks.markdownListener = undefined
  mocks.create.mockResolvedValue(undefined)
  mocks.destroy.mockResolvedValue(undefined)
})

describe('MarkdownEditor', () => {
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
