'use client'

import type { ClipboardEvent as ReactClipboardEvent } from 'react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { EditorView } from '@milkdown/kit/prose/view'
import { toast } from 'sonner'
import '@milkdown/crepe/theme/common/style.css'

import {
  creativeAssetUrl,
  importCreativeAssetImages,
  uploadInlineAssetImage,
} from '@/lib/api/assets'
import {
  createAssetImageImportPlugin,
  dispatchAssetImageImportAction,
} from '@/app/assets/asset-image-import-plugin'
import {
  convertClipboardHtml,
  imageUrlFromPlainText,
  stripImageImportMarkers,
} from '@/app/assets/asset-paste'
import type { ClipboardRemoteImage } from '@/app/assets/asset-paste'

type CrepeInstance = InstanceType<typeof import('@milkdown/crepe').Crepe>
type InsertAction = typeof import('@milkdown/kit/utils').insert

export interface MarkdownEditorHandle {
  insert(markdown: string): void
}

type MarkdownEditorProps = {
  value: string
  onChange: (markdown: string) => void
  documentKey: string | number
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor({
  value,
  onChange,
  documentKey,
}, ref) {
  const rootRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<CrepeInstance | null>(null)
  const insertRef = useRef<InsertAction | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  const initialValueRef = useRef(value)
  const sessionRef = useRef(0)
  const documentChangeCountRef = useRef(0)
  const initializedDocumentChangeCountRef = useRef<number | null>(null)
  const suppressInitialChangeRef = useRef(false)
  const pendingInsertionsRef = useRef<string[]>([])
  const remoteImagesRef = useRef(new Map<string, ClipboardRemoteImage>())
  const retryRef = useRef<(id: string) => void>(() => undefined)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    initialValueRef.current = value
  }, [documentKey, value])

  const insertMarkdown = useCallback((markdown: string) => {
    const crepe = crepeRef.current
    const insert = insertRef.current
    if (!crepe || !insert) {
      pendingInsertionsRef.current.push(markdown)
      return
    }
    crepe.editor.action(insert(markdown))
  }, [])

  useImperativeHandle(ref, () => ({ insert: insertMarkdown }), [insertMarkdown])

  const runRemoteImport = useCallback(async (
    images: ClipboardRemoteImage[],
    session: number,
  ) => {
    if (!images.length) return
    let results
    try {
      results = await importCreativeAssetImages(images.map(image => image.sourceUrl))
    } catch {
      results = images.map(image => ({
        source_url: image.sourceUrl,
        url: '',
        error_code: 'unreachable',
        error: '图片地址不可访问',
      }))
    }
    if (sessionRef.current !== session) return
    const view = viewRef.current
    if (!view) return
    let failed = false
    images.forEach((image, index) => {
      const result = results[index]
      if (result?.url) {
        dispatchAssetImageImportAction(view, {
          type: 'success',
          id: image.id,
          localUrl: result.url,
        })
        remoteImagesRef.current.delete(image.id)
        return
      }
      failed = true
      dispatchAssetImageImportAction(view, {
        type: 'failure',
        id: image.id,
        error: result?.error || '图片地址不可访问',
      })
    })
    if (failed) toast.warning('部分图片未保存到系统，可在图片旁重试')
  }, [])

  useEffect(() => {
    const session = sessionRef.current + 1
    sessionRef.current = session
    documentChangeCountRef.current = 0
    initializedDocumentChangeCountRef.current = null
    suppressInitialChangeRef.current = false
    let active = true
    let ownedCrepe: CrepeInstance | null = null
    const remoteImages = remoteImagesRef.current
    remoteImages.clear()

    retryRef.current = id => {
      const image = remoteImagesRef.current.get(id)
      const view = viewRef.current
      if (!image || !view || sessionRef.current !== session) return
      dispatchAssetImageImportAction(view, {
        type: 'register',
        id,
        sourceUrl: image.sourceUrl,
      })
      void runRemoteImport([image], session)
    }

    async function createEditor() {
      try {
        const [{ Crepe }, { editorViewCtx }, { $prose, insert }] = await Promise.all([
          import('@milkdown/crepe'),
          import('@milkdown/kit/core'),
          import('@milkdown/kit/utils'),
        ])
        if (!active || !rootRef.current) return
        const crepe = new Crepe({
          root: rootRef.current,
          defaultValue: initialValueRef.current,
          features: {
            [Crepe.Feature.Latex]: false,
            [Crepe.Feature.TopBar]: true,
          },
          featureConfigs: {
            [Crepe.Feature.ImageBlock]: {
              onUpload: uploadInlineAssetImage,
              proxyDomURL: creativeAssetUrl,
              inlineUploadButton: '上传图片',
              blockUploadButton: '上传图片',
              inlineUploadPlaceholderText: '粘贴图片链接',
              blockUploadPlaceholderText: '粘贴图片链接',
            },
          },
        })
        ownedCrepe = crepe
        crepe.editor.use($prose(() => createAssetImageImportPlugin({
          onRetry: id => retryRef.current(id),
          onDocumentChange: () => {
            documentChangeCountRef.current += 1
          },
        })))
        crepe.on(listener => {
          listener.markdownUpdated((_ctx, markdown) => {
            if (!active || sessionRef.current !== session) return
            const initializedDocumentChangeCount = initializedDocumentChangeCountRef.current
            if (initializedDocumentChangeCount === null) return
            if (suppressInitialChangeRef.current) {
              if (documentChangeCountRef.current <= initializedDocumentChangeCount) return
              suppressInitialChangeRef.current = false
            }
            onChangeRef.current(stripImageImportMarkers(markdown))
          })
        })
        await crepe.create()
        if (!active || sessionRef.current !== session) {
          await crepe.destroy()
          return
        }
        initializedDocumentChangeCountRef.current = documentChangeCountRef.current
        suppressInitialChangeRef.current = documentChangeCountRef.current > 0
        crepeRef.current = crepe
        insertRef.current = insert
        viewRef.current = crepe.editor.action(ctx => ctx.get(editorViewCtx))
        for (const markdown of pendingInsertionsRef.current.splice(0)) {
          crepe.editor.action(insert(markdown))
        }
        setStatus('ready')
      } catch {
        if (active && sessionRef.current === session) setStatus('error')
      }
    }

    void createEditor()
    return () => {
      active = false
      sessionRef.current += 1
      retryRef.current = () => undefined
      pendingInsertionsRef.current = []
      remoteImages.clear()
      viewRef.current = null
      insertRef.current = null
      crepeRef.current = null
      if (ownedCrepe) void ownedCrepe.destroy()
    }
  }, [documentKey, loadAttempt, runRemoteImport])

  const registerAndImport = useCallback((images: ClipboardRemoteImage[]) => {
    const view = viewRef.current
    if (!view) return
    for (const image of images) {
      remoteImagesRef.current.set(image.id, image)
      dispatchAssetImageImportAction(view, {
        type: 'register',
        id: image.id,
        sourceUrl: image.sourceUrl,
      })
    }
    void runRemoteImport(images, sessionRef.current)
  }, [runRemoteImport])

  const handlePaste = useCallback(async (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (status !== 'ready') return
    const items = Array.from(event.clipboardData?.items ?? [])
    const imageFiles = items
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (imageFiles.length) {
      event.preventDefault()
      const session = sessionRef.current
      for (const file of imageFiles) {
        try {
          const url = await uploadInlineAssetImage(file)
          if (sessionRef.current === session) {
            insertMarkdown(`![${file.name || '图片'}](${url})`)
          }
        } catch {
          toast.warning('图片上传失败，请重试')
        }
      }
      return
    }

    const html = event.clipboardData.getData('text/html')
    if (html) {
      const converted = convertClipboardHtml(html)
      if (!converted.markdown) return
      event.preventDefault()
      insertMarkdown(converted.markdown)
      registerAndImport(converted.images)
      return
    }

    const imageUrl = imageUrlFromPlainText(event.clipboardData.getData('text/plain'))
    if (!imageUrl) return
    const converted = convertClipboardHtml(`<img src="${imageUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`)
    event.preventDefault()
    insertMarkdown(converted.markdown)
    registerAndImport(converted.images)
  }, [insertMarkdown, registerAndImport, status])

  return (
    <div className="asset-visual-markdown-editor relative h-full min-h-[420px]">
      <div
        aria-busy={status === 'loading'}
        aria-label="可视化 Markdown 编辑器"
        className="h-full min-h-[420px] overflow-auto"
        onPasteCapture={handlePaste}
        ref={rootRef}
        role="textbox"
        tabIndex={0}
      />
      {status === 'loading' ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/70 text-sm text-muted-foreground">
          加载编辑器…
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="absolute inset-0 grid place-items-center bg-background/90">
          <button
            className="rounded-md border border-border px-3 py-2 text-sm"
            onClick={() => {
              setStatus('loading')
              setLoadAttempt(attempt => attempt + 1)
            }}
            type="button"
          >
            重试加载编辑器
          </button>
        </div>
      ) : null}
    </div>
  )
})
