'use client'

import { useMemo, useState } from 'react'
import { Copy, ClipboardType, Sun, Moon, AlertTriangle, Info } from 'lucide-react'
import { marked } from 'marked'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { DraftImage } from '@/lib/api/drafts'
import { mdToPlainText, scanUnsupported, stripLeadingTitleHeading } from '@/lib/x-article'
import { pickDefaultCoverImage, resolveCopyImageUrl } from './publish-helpers'

// 近似 X Chirp 的系统字体栈
const X_FONT_STACK =
  '"Chirp", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

/** markdown → HTML，图片 src 绝对化（预览与剪贴板都要绝对地址）。 */
function renderXArticleHtml(md: string): string {
  if (!md.trim() || typeof window === 'undefined') return ''
  try {
    const raw = marked.parse(md, { async: false, gfm: true }) as string
    const doc = new DOMParser().parseFromString(raw, 'text/html')
    doc.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src')?.trim() ?? ''
      if (src) img.setAttribute('src', resolveCopyImageUrl(src))
    })
    return doc.body.innerHTML
  } catch {
    return ''
  }
}

export function XArticlePanel({
  title, content, images,
}: {
  title: string
  content: string
  images: DraftImage[]
}) {
  const [dark, setDark] = useState(false)

  // 首行 H1 与标题字段一致时剥掉（X 文章标题单独填，不剥会重复）
  const body = useMemo(() => stripLeadingTitleHeading(content, title), [content, title])
  const html = useMemo(() => renderXArticleHtml(body), [body])
  const plainText = useMemo(() => mdToPlainText(body), [body])
  const warnings = useMemo(() => scanUnsupported(body), [body])
  const cover = useMemo(() => pickDefaultCoverImage(images), [images])

  async function handleCopyRich() {
    if (!html) return
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        }),
      ])
      toast.success('已复制富文本，到 x.com 文章编辑器粘贴')
    } catch {
      try {
        await navigator.clipboard.writeText(plainText)
        toast.success('浏览器不支持富文本复制，已复制纯文本')
      } catch {
        toast.error('复制失败')
      }
    }
  }

  async function handleCopyPlain() {
    if (!plainText) return
    try {
      await navigator.clipboard.writeText(plainText)
      toast.success('已复制纯文本')
    } catch {
      toast.error('复制失败')
    }
  }

  return (
    <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
      {/* ── 仿 X 文章阅读页预览 ── */}
      <div
        className={cn(
          'flex-1 min-w-0 rounded-lg border overflow-y-auto transition-colors',
          dark ? 'bg-black border-zinc-700' : 'bg-white border-zinc-200 dark:border-zinc-800',
        )}
      >
        {!content.trim() ? (
          <div className="h-full flex items-center justify-center text-sm text-foreground-subtle">
            草稿内容为空
          </div>
        ) : (
          <article className="mx-auto max-w-[600px] px-6 py-10" style={{ fontFamily: X_FONT_STACK }}>
            <h1
              className={cn(
                'text-[28px] font-extrabold leading-snug tracking-tight',
                dark ? 'text-zinc-50' : 'text-zinc-900',
              )}
            >
              {title || '（无标题）'}
            </h1>
            {cover && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={cover.hosted_url}
                alt={cover.original_name || '封面'}
                className="w-full rounded-2xl mt-5"
              />
            )}
            <div
              className={cn(
                'prose mt-6 max-w-none prose-img:rounded-2xl prose-a:text-sky-500',
                dark && 'prose-invert',
              )}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </article>
        )}
      </div>

      {/* ── 操作面板 ── */}
      <div className="w-72 flex-shrink-0 overflow-y-auto space-y-4 pr-1">
        <div className="rounded-md border border-border px-2.5 py-2 space-y-1 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1 font-medium text-foreground">
            <Info className="w-3 h-3" /> 手动发布流程
          </div>
          <p>X 没有长文发布接口：复制内容后，到 x.com 文章编辑器（Premium「Articles」）粘贴。</p>
          <p>标题和封面图需在 X 编辑器里单独设置；图片一般不随粘贴带入，需手动上传。</p>
        </div>

        {warnings.length > 0 && (
          <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-2.5 py-2 space-y-1">
            <div className="flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3" /> 兼容性提示
            </div>
            <p className="text-[11px] text-amber-700/90 dark:text-amber-400/90">
              X 文章不支持以下语法，粘贴后会丢失格式：
            </p>
            <ul className="text-[11px] text-amber-700/90 dark:text-amber-400/90 list-disc pl-4">
              {warnings.map(w => (
                <li key={w.kind}>{w.label} × {w.count}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-1">
          <Label className="text-xs">预览主题</Label>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => setDark(false)}
              className={cn(
                'flex items-center justify-center gap-1 py-1.5 rounded-md border text-xs transition-colors',
                !dark
                  ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 font-medium'
                  : 'border-input text-muted-foreground hover:border-border-strong',
              )}
            >
              <Sun className="w-3 h-3" /> 浅色
            </button>
            <button
              type="button"
              onClick={() => setDark(true)}
              className={cn(
                'flex items-center justify-center gap-1 py-1.5 rounded-md border text-xs transition-colors',
                dark
                  ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 font-medium'
                  : 'border-input text-muted-foreground hover:border-border-strong',
              )}
            >
              <Moon className="w-3 h-3" /> 深色
            </button>
          </div>
        </div>

        <p className="text-[11px] text-foreground-subtle">纯文本约 {plainText.replace(/\s/g, '').length} 字</p>

        <div className="space-y-2 pt-1">
          <Button
            size="sm"
            onClick={handleCopyRich}
            disabled={!html}
            className="w-full gap-1.5"
          >
            <Copy className="w-3.5 h-3.5" /> 复制富文本
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopyPlain}
            disabled={!plainText}
            className="w-full gap-1.5"
          >
            <ClipboardType className="w-3.5 h-3.5" /> 复制纯文本
          </Button>
        </div>
      </div>
    </div>
  )
}
