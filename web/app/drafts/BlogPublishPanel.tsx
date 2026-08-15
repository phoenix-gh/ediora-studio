'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Send, ExternalLink, CheckCircle, Info, ImageOff } from 'lucide-react'
import { marked } from 'marked'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DraftImage, publishDraftToBlog, BlogPublishResult } from '@/lib/api/drafts'
import { getSettings } from '@/lib/api/settings'
import { stripLeadingTitleHeading } from '@/lib/x-article'
import { isCoverImage, pickDefaultCoverImage, mdToPlainExcerpt, resolveCopyImageUrl } from './publish-helpers'

/** markdown → 预览 HTML，本站图片 src 绝对化（提交时仍用原始 markdown）。 */
function renderPreviewHtml(md: string): string {
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

export function BlogPublishPanel({
  draftId, title, content, images,
}: {
  draftId: number
  title: string
  content: string
  images: DraftImage[]
}) {
  const [pubTitle, setPubTitle] = useState(title)
  const [description, setDescription] = useState(() => mdToPlainExcerpt(content, 160))
  const [series, setSeries] = useState('')
  const [tags, setTags] = useState('')
  const [slug, setSlug] = useState('')
  const [notes, setNotes] = useState('')
  const [coverId, setCoverId] = useState<number | null>(() => pickDefaultCoverImage(images)?.id ?? null)
  const [publishing, setPublishing] = useState(false)
  const [result, setResult] = useState<BlogPublishResult | null>(null)
  const [tokenSet, setTokenSet] = useState<boolean | null>(null)

  useEffect(() => {
    getSettings()
      .then(s => setTokenSet(s.blog_api_token_set))
      .catch(() => setTokenSet(null))
  }, [])

  // 标题单独提交，正文开头与标题重复的 H1 剥掉，避免博客页标题出现两遍
  const body = useMemo(() => stripLeadingTitleHeading(content, title), [content, title])
  const html = useMemo(() => renderPreviewHtml(body), [body])

  const coverChoices = useMemo(
    () => [...images].sort((a, b) => {
      const aCover = isCoverImage(a)
      const bCover = isCoverImage(b)
      if (aCover !== bCover) return aCover ? -1 : 1
      return b.id - a.id
    }),
    [images],
  )
  const defaultCoverId = useMemo(() => pickDefaultCoverImage(images)?.id ?? null, [images])
  const effectiveCoverId = coverId && images.some(img => img.id === coverId) ? coverId : defaultCoverId

  async function handlePublish() {
    if (!pubTitle.trim()) { toast.error('标题不能为空'); return }
    if (!description.trim()) { toast.error('摘要不能为空'); return }
    if (!body.trim()) { toast.error('正文为空'); return }
    setPublishing(true)
    try {
      const res = await publishDraftToBlog(draftId, {
        title: pubTitle.trim(),
        description: description.trim(),
        content_markdown: body,
        cover_image_id: effectiveCoverId ?? undefined,
        slug: slug.trim(),
        series: series.trim(),
        tags: tags.split(/[,，]/).map(t => t.trim()).filter(Boolean),
        revision_notes: notes.trim(),
      })
      setResult(res)
      toast.success('已提交到博客，等待人工审核发布')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '提交失败')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="flex-1 flex gap-4 overflow-hidden min-h-0">
      {/* ── 预览 ── */}
      <div className="flex-1 min-w-0 rounded-lg border border-border bg-surface overflow-y-auto">
        {!body.trim() ? (
          <div className="h-full flex items-center justify-center text-sm text-foreground-subtle">
            草稿内容为空
          </div>
        ) : (
          <article className="mx-auto max-w-[640px] px-6 py-10">
            {effectiveCoverId && (() => {
              const img = images.find(i => i.id === effectiveCoverId)
              return img ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={img.hosted_url} alt={img.original_name || '封面'} className="w-full rounded-xl mb-6 object-cover aspect-video" />
              ) : null
            })()}
            <h1 className="text-[26px] font-bold leading-snug text-foreground">
              {pubTitle || '（无标题）'}
            </h1>
            {description.trim() && (
            <p className="mt-3 text-sm text-muted-foreground">{description}</p>
            )}
            <div
              className="prose dark:prose-invert mt-6 max-w-none prose-img:rounded-xl"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </article>
        )}
      </div>

      {/* ── 配置面板 ── */}
      <div className="w-72 flex-shrink-0 overflow-y-auto space-y-4 pr-1">
        {tokenSet === false && (
          <p className="text-[11px] text-amber-500 border border-amber-200 dark:border-amber-900 rounded-md px-2.5 py-2">
            未配置 Blog API Token。请到「设置 → Blog 投稿」填写后再提交。
          </p>
        )}

        <div className="rounded-md border border-border px-2.5 py-2 space-y-1 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1 font-medium text-foreground">
            <Info className="w-3 h-3" /> 投稿流程
          </div>
          <p>提交后文章进入博客后台 review 状态，人工审核确认后发布。正文里的本站图片会自动上传到博客图床。</p>
        </div>

        <div className="space-y-1">
          <Label className="text-xs">标题</Label>
          <Input
            value={pubTitle}
            onChange={e => setPubTitle(e.target.value)}
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">摘要（description）</Label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-lg border border-input bg-control px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">封面图（可选）</Label>
          {images.length === 0 ? (
            <div className="flex items-center gap-2 text-[11px] text-foreground-subtle border border-border rounded-md px-2.5 py-2">
              <ImageOff className="w-3.5 h-3.5 flex-shrink-0" />
              素材库没有图片，可先在「素材」里上传
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {/* 「无封面」选项 */}
              <button
                onClick={() => setCoverId(-1)}
                title="不设封面"
                className={cn(
                  'aspect-square rounded-md border-2 transition-colors flex items-center justify-center',
                  effectiveCoverId === null || coverId === -1
                    ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/30'
                    : 'border-border hover:border-border-strong text-foreground-subtle',
                )}
              >
                <ImageOff className="w-4 h-4" />
              </button>
              {coverChoices.map(img => (
                <button
                  key={img.id}
                  onClick={() => setCoverId(img.id)}
                  title={img.original_name}
                  className={cn(
                    'aspect-square rounded-md overflow-hidden border-2 transition-colors',
                    effectiveCoverId === img.id && coverId !== -1
                      ? 'border-indigo-400'
                      : 'border-transparent hover:border-border-strong',
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.hosted_url} alt={img.original_name} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1">
          <Label className="text-xs">系列（可选）</Label>
          <Input
            value={series}
            onChange={e => setSeries(e.target.value)}
            placeholder="如：落地手记"
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">标签（可选，逗号分隔）</Label>
          <Input
            value={tags}
            onChange={e => setTags(e.target.value)}
            placeholder="agent, cms"
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">Slug（可选）</Label>
          <Input
            value={slug}
            onChange={e => setSlug(e.target.value)}
            placeholder="留空自动生成"
            className="h-8 text-sm font-mono"
          />
        </div>

        <div className="space-y-1">
          <Label className="text-xs">审核备注（可选）</Label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            placeholder="给人工审核看的说明"
            className="w-full resize-none rounded-lg border border-input bg-control px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
          />
        </div>

        {result && (
          <div className="rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 px-2.5 py-2 space-y-1">
            <div className="flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle className="w-3 h-3" /> 已提交（{result.status}）
            </div>
            <p className="text-[11px] text-emerald-700/90 dark:text-emerald-400/90 break-all">
              slug: {result.slug}
            </p>
            {result.admin_url && (
              <a
                href={result.admin_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-400 underline"
              >
                <ExternalLink className="w-3 h-3" /> 打开后台审核
              </a>
            )}
          </div>
        )}

        <div className="pt-1">
          <Button
            size="sm"
            onClick={handlePublish}
            disabled={publishing || !body.trim() || tokenSet === false}
            className="w-full gap-1.5"
          >
            {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            提交到博客（待审核）
          </Button>
        </div>
      </div>
    </div>
  )
}
