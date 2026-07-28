'use client'

import React, { forwardRef, useImperativeHandle } from 'react'
import { commands as markdownCommands } from '@uiw/react-md-editor'
import dynamic from 'next/dynamic'
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'

const MDEditor = dynamic(() => import('@uiw/react-md-editor'), {
  ssr: false,
  loading: () => <div className="h-full flex items-center justify-center text-zinc-400 text-sm">加载编辑器…</div>,
})

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api'

const subscribeToHydration = () => () => {}
const getClientHydrationSnapshot = () => true
const getServerHydrationSnapshot = () => false

async function uploadImageFile(file: File): Promise<string | null> {
  const form = new FormData()
  form.append('file', file)
  try {
    const res = await fetch(`${API}/upload/image`, { method: 'POST', body: form })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast.error(`图片上传失败: ${err.detail ?? res.status}`)
      return null
    }
    const data = await res.json()
    return `http://localhost:8000${data.url}`
  } catch (e) {
    toast.error(`图片上传失败: ${e}`)
    return null
  }
}

function insertAtCursor(textarea: HTMLTextAreaElement, text: string) {
  const start = textarea.selectionStart ?? textarea.value.length
  const end = textarea.selectionEnd ?? start
  const before = textarea.value.slice(0, start)
  const after = textarea.value.slice(end)
  return before + text + after
}

export interface MarkdownEditorHandle {
  insert: (text: string) => void
}

interface Props {
  value: string
  onChange: (v: string) => void
  minHeight?: number
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(
function MarkdownEditor({ value, onChange, minHeight = 500 }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { resolvedTheme } = useTheme()
  const isHydrated = useSyncExternalStore(
    subscribeToHydration,
    getClientHydrationSnapshot,
    getServerHydrationSnapshot,
  )
  const colorMode = isHydrated && resolvedTheme === 'dark' ? 'dark' : 'light'

  useImperativeHandle(ref, () => ({
    insert(text: string) {
      const ta = containerRef.current?.querySelector('textarea')
      if (ta) {
        onChange(insertAtCursor(ta, text))
        // Restore focus and move cursor after inserted text
        requestAnimationFrame(() => {
          const pos = (ta.selectionStart ?? 0) + text.length
          ta.focus()
          ta.setSelectionRange(pos, pos)
        })
      } else {
        onChange(value + text)
      }
    },
  }))

  // Handle paste events (images)
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? [])
    const imageItem = items.find(i => i.type.startsWith('image/'))
    if (!imageItem) return
    e.preventDefault()
    const file = imageItem.getAsFile()
    if (!file) return
    const url = await uploadImageFile(file)
    if (!url) return
    const ta = containerRef.current?.querySelector('textarea')
    if (ta) {
      const newVal = insertAtCursor(ta, `\n![图片](${url})\n`)
      onChange(newVal)
    } else {
      onChange(value + `\n![图片](${url})\n`)
    }
  }, [value, onChange])

  // Handle drag-drop images
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    const urls: string[] = []
    for (const file of files) {
      const url = await uploadImageFile(file)
      if (url) urls.push(url)
    }
    if (!urls.length) return
    const inserts = urls.map(u => `\n![图片](${u})\n`).join('')
    onChange(value + inserts)
  }, [value, onChange])

  return (
    <div
      ref={containerRef}
      data-color-mode={colorMode}
      className="h-full flex flex-col [&_.w-md-editor]:flex-1 [&_.w-md-editor]:border-0 [&_.w-md-editor]:rounded-none [&_.w-md-editor-toolbar]:border-b [&_.w-md-editor-toolbar]:border-zinc-200 [&_.w-md-editor-content]:flex-1 [&_.w-md-editor-input]:font-mono [&_.w-md-editor-input]:text-sm"
      onPaste={handlePaste}
      onDrop={handleDrop}
      onDragOver={e => e.preventDefault()}
    >
      <MDEditor
        value={value}
        onChange={v => onChange(v ?? '')}
        height="100%"
        visibleDragbar={false}
        preview="live"
        previewOptions={{
          components: {
            img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) =>
              src ? <img src={src} alt={alt} {...props} /> : null,
          },
        }}
        extraCommands={[]}
        commands={[
          ...markdownCommands.getCommands(),
          {
            name: 'upload-image',
            keyCommand: 'upload-image',
            buttonProps: { 'aria-label': '上传图片', title: '上传图片（或直接粘贴/拖拽图片）' },
            icon: (
              <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                <path d="M6.002 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/>
                <path d="M2.002 1a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3a2 2 0 0 0-2-2h-12zm12 1a1 1 0 0 1 1 1v6.5l-3.777-1.947a.5.5 0 0 0-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 0 0-.63.062L1.002 12V3a1 1 0 0 1 1-1h12z"/>
              </svg>
            ),
            execute: async (_state, api) => {
              const input = document.createElement('input')
              input.type = 'file'
              input.accept = 'image/*'
              input.multiple = true
              input.onchange = async () => {
                const files = Array.from(input.files ?? [])
                for (const file of files) {
                  const url = await uploadImageFile(file)
                  if (url) api.replaceSelection(`\n![图片](${url})\n`)
                }
              }
              input.click()
            },
          },
        ]}
      />
    </div>
  )
})
