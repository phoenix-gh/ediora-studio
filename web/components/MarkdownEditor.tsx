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
type ReplaceAllAction = typeof import('@milkdown/kit/utils').replaceAll

export interface MarkdownEditorHandle {
  insert(markdown: string): void
}

type MarkdownEditorProps = {
  value: string
  onChange: (markdown: string) => void
  documentKey: string | number
}

type EditorMode = 'visual' | 'source'

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor({
  value,
  onChange,
  documentKey,
}, ref) {
  const rootRef = useRef<HTMLDivElement>(null)
  const crepeRef = useRef<CrepeInstance | null>(null)
  const insertRef = useRef<InsertAction | null>(null)
  const replaceAllRef = useRef<ReplaceAllAction | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const sourceRef = useRef<HTMLTextAreaElement>(null)
  const onChangeRef = useRef(onChange)
  const initialValueRef = useRef(value)
  const latestMarkdownRef = useRef(value)
  const sourceValueRef = useRef(value)
  const previousDocumentKeyRef = useRef(documentKey)
  const modeRef = useRef<EditorMode>('visual')
  const sessionRef = useRef(0)
  const documentChangeCountRef = useRef(0)
  const initializedDocumentChangeCountRef = useRef<number | null>(null)
  const suppressInitialChangeRef = useRef(false)
  const pendingInsertionsRef = useRef<string[]>([])
  const remoteImagesRef = useRef(new Map<string, ClipboardRemoteImage>())
  const retryRef = useRef<(id: string) => void>(() => undefined)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [mode, setMode] = useState<EditorMode>('visual')
  const [sourceValue, setSourceValue] = useState(value)

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    initialValueRef.current = value
    latestMarkdownRef.current = value
  }, [documentKey, value])

  useEffect(() => {
    if (previousDocumentKeyRef.current === documentKey) return
    previousDocumentKeyRef.current = documentKey
    modeRef.current = 'visual'
    sourceValueRef.current = value
    latestMarkdownRef.current = value
    setMode('visual')
    setSourceValue(value)
  }, [documentKey, value])

  const publishMarkdown = useCallback((markdown: string) => {
    const cleaned = stripImageImportMarkers(markdown)
    latestMarkdownRef.current = cleaned
    onChangeRef.current(cleaned)
  }, [])

  const insertIntoSource = useCallback((markdown: string) => {
    const textarea = sourceRef.current
    const current = sourceValueRef.current
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? start
    const next = current.slice(0, start) + markdown + current.slice(end)
    sourceValueRef.current = next
    setSourceValue(next)
    publishMarkdown(next)
    if (textarea) {
      requestAnimationFrame(() => {
        textarea.focus()
        const cursor = start + markdown.length
        textarea.setSelectionRange(cursor, cursor)
      })
    }
  }, [publishMarkdown])

  const insertMarkdown = useCallback((markdown: string) => {
    if (modeRef.current === 'source') {
      insertIntoSource(markdown)
      return
    }
    const crepe = crepeRef.current
    const insert = insertRef.current
    if (!crepe || !insert) {
      pendingInsertionsRef.current.push(markdown)
      return
    }
    crepe.editor.action(insert(markdown))
  }, [insertIntoSource])

  useImperativeHandle(ref, () => ({ insert: insertMarkdown }), [insertMarkdown])

  const changeMode = useCallback((nextMode: EditorMode) => {
    if (nextMode === modeRef.current) return
    if (nextMode === 'source') {
      let current = latestMarkdownRef.current
      if (crepeRef.current) {
        try {
          current = stripImageImportMarkers(crepeRef.current.getMarkdown())
        } catch {
          // Keep the last persisted Markdown if the editor is mid-transition.
        }
      }
      modeRef.current = 'source'
      sourceValueRef.current = current
      setSourceValue(current)
      setMode('source')
      return
    }

    const current = sourceValueRef.current
    modeRef.current = 'visual'
    latestMarkdownRef.current = current
    const crepe = crepeRef.current
    const replaceAll = replaceAllRef.current
    if (crepe && replaceAll) {
      crepe.editor.action(replaceAll(current))
      setMode('visual')
      return
    }
    initialValueRef.current = current
    setStatus('loading')
    setLoadAttempt(attempt => attempt + 1)
    setMode('visual')
  }, [])

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
        const [{ Crepe }, { editorViewCtx }, { $prose, insert, replaceAll }] = await Promise.all([
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
            if (modeRef.current === 'source') return
            publishMarkdown(markdown)
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
        replaceAllRef.current = replaceAll
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
      replaceAllRef.current = null
      crepeRef.current = null
      if (ownedCrepe) void ownedCrepe.destroy()
    }
  }, [documentKey, loadAttempt, publishMarkdown, runRemoteImport])

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
    <div className="asset-visual-markdown-editor relative flex h-full min-h-[420px] flex-col">
      <div className="relative min-h-0 flex-1 pt-2">
        <div
          aria-busy={status === 'loading'}
          aria-label="可视化 Markdown 编辑器"
          className="h-full min-h-[420px] overflow-auto"
          hidden={mode === 'source'}
          onPasteCapture={handlePaste}
          ref={rootRef}
          role="textbox"
          tabIndex={mode === 'visual' ? 0 : -1}
        />
        {mode === 'source' ? (
          <textarea
            aria-label="Markdown 源码编辑器"
            className="h-full min-h-[420px] w-full resize-none overflow-auto rounded-md border border-border bg-background px-4 py-3 font-mono text-sm leading-6 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            onChange={event => {
              const next = event.currentTarget.value
              sourceValueRef.current = next
              publishMarkdown(next)
              setSourceValue(next)
            }}
            ref={sourceRef}
            spellCheck={false}
            value={sourceValue}
          />
        ) : null}
        {mode === 'visual' && status === 'loading' ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/70 text-sm text-muted-foreground">
            加载编辑器…
          </div>
        ) : null}
        {mode === 'visual' && status === 'error' ? (
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
      <div className="mt-2 flex shrink-0 items-center justify-end border-t border-border/60 pt-2">
        <div
          aria-label="Markdown 编辑模式"
          className="inline-flex items-center rounded-md border border-border bg-muted/30 p-0.5"
          role="tablist"
        >
          {(['visual', 'source'] as const).map(option => {
            const selected = mode === option
            return (
              <button
                aria-selected={selected}
                className={`rounded px-2.5 py-1 text-xs transition-colors ${selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                key={option}
                onClick={() => changeMode(option)}
                role="tab"
                type="button"
              >
                {option === 'visual' ? '可视' : '源码'}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
})
