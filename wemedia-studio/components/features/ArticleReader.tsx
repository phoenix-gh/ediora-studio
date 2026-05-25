'use client'

import { useEffect, useRef } from 'react'
import { X, ExternalLink, BookOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ReaderMeta {
  title: string
  author?: string
  source?: string         // e.g. "学麟AI", "程序员", "36 氪"
  published_at?: string
  url: string             // origin URL to "open original"
  content: string         // HTML body
}

type Accent = 'blue' | 'orange' | 'green' | 'yellow' | 'indigo'

const ACCENT_CLASSES: Record<Accent, string> = {
  blue:    'prose-a:text-blue-600  hover:prose-a:text-blue-700',
  orange:  'prose-a:text-orange-600 hover:prose-a:text-orange-700',
  green:   'prose-a:text-green-600 hover:prose-a:text-green-700',
  yellow:  'prose-a:text-yellow-600 hover:prose-a:text-yellow-700',
  indigo:  'prose-a:text-indigo-600 hover:prose-a:text-indigo-700',
}

function fmtDate(iso?: string) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── Inner: header + scrolling body — shared by Modal and Panel ────────────────

function ReaderBody({
  meta, loading, accent, onClose, centered = false, headerActions,
}: {
  meta: ReaderMeta | null
  loading?: boolean
  accent: Accent
  onClose: () => void
  /** When true, center the inner content (used by panel mode where width is unbounded). */
  centered?: boolean
  /** Extra action buttons rendered in header before 原文/关闭. */
  headerActions?: React.ReactNode
}) {
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [meta?.url])

  return (
    <>
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/50">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-zinc-400 truncate">
            {meta?.source && <span>{meta.source}</span>}
            {meta?.author && <> · {meta.author}</>}
            {meta?.published_at && <> · {fmtDate(meta.published_at)}</>}
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {headerActions}
          {meta?.url && (
            <a
              href={meta.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs px-2 py-1 rounded text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              原文
            </a>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-zinc-700 transition-colors"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto">
        <div className={cn('px-6 py-5', centered && 'max-w-3xl mx-auto')}>
        {!meta ? (
          <div className="text-center text-sm text-zinc-400 py-12">加载中…</div>
        ) : (
          <>
            <h1 className="text-xl font-semibold leading-snug text-zinc-900 dark:text-zinc-100 mb-4">
              {meta.title}
            </h1>

            {loading ? (
              <div className="text-center text-sm text-zinc-400 py-12">正在抓取正文…</div>
            ) : meta.content ? (
              <article
                className={cn(
                  'prose prose-sm max-w-none dark:prose-invert',
                  'prose-p:my-3 prose-p:leading-7',
                  'prose-img:rounded-lg prose-img:mx-auto',
                  'prose-pre:bg-zinc-900 prose-pre:text-zinc-100',
                  'prose-code:bg-zinc-100 dark:prose-code:bg-zinc-800 prose-code:px-1 prose-code:rounded',
                  'prose-headings:text-zinc-900 dark:prose-headings:text-zinc-100',
                  ACCENT_CLASSES[accent],
                )}
                dangerouslySetInnerHTML={{ __html: meta.content }}
              />
            ) : (
              <div className="text-center text-sm text-zinc-400 py-8">
                暂无正文内容
                {meta.url && (
                  <>
                    ，
                    <a
                      href={meta.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      打开原文
                    </a>
                  </>
                )}
              </div>
            )}
          </>
        )}
        </div>
      </div>
    </>
  )
}


// ── Modal ──────────────────────────────────────────────────────────────────────

interface ModalProps {
  open: boolean
  onClose: () => void
  meta: ReaderMeta | null
  loading?: boolean
  accent?: Accent
  headerActions?: React.ReactNode
}

export function ArticleReaderModal({ open, onClose, meta, loading, accent = 'indigo', headerActions }: ModalProps) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-10 pb-8 px-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-3xl max-h-full bg-white dark:bg-zinc-950 rounded-xl shadow-2xl border border-zinc-200 dark:border-zinc-800 flex flex-col overflow-hidden">
        <ReaderBody meta={meta} loading={loading} accent={accent} onClose={onClose} headerActions={headerActions} />
      </div>
    </div>
  )
}


// ── Panel (inline, side-by-side with the list) ────────────────────────────────

interface PanelProps {
  open: boolean             // true → show article body; false → show empty state
  onClose: () => void
  meta: ReaderMeta | null
  loading?: boolean
  accent?: Accent
  headerActions?: React.ReactNode
}

export function ArticleReaderPanel({ open, onClose, meta, loading, accent = 'indigo', headerActions }: PanelProps) {
  return (
    <aside className="flex-1 min-w-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col h-full">
      {open && meta ? (
        <ReaderBody meta={meta} loading={loading} accent={accent} onClose={onClose} centered headerActions={headerActions} />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 gap-3">
          <BookOpen className="w-10 h-10 opacity-20" />
          <p className="text-sm">从左侧选择一篇文章查看</p>
        </div>
      )}
    </aside>
  )
}


// ── Convenience: responsive reader picks modal/panel based on hook ─────────────

interface ResponsiveProps {
  /** When true, render a side panel; otherwise an overlay modal. */
  asPanel: boolean
  open: boolean
  onClose: () => void
  meta: ReaderMeta | null
  loading?: boolean
  accent?: Accent
  headerActions?: React.ReactNode
}

export function ResponsiveArticleReader(props: ResponsiveProps) {
  const { asPanel, ...rest } = props
  return asPanel ? <ArticleReaderPanel {...rest} /> : <ArticleReaderModal {...rest} />
}

// Re-export the original name for backward compatibility
export { ArticleReaderModal as ArticleReader }
