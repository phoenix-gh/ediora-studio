'use client'

import { ExternalLink, FileText, PlaySquare } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import type { ResponseDetail } from '@/lib/api/responses'
import { cn } from '@/lib/utils'

export function ResponseSourcePane({ detail }: { detail: ResponseDetail }) {
  const source = detail.source
  const body = source.type === 'x_post'
    ? source.raw_markdown || source.content || ''
    : source.transcript_text || ''

  return (
    <section className="flex min-h-0 flex-col rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex items-start gap-3 border-b border-border p-5">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted">
          {source.type === 'x_post'
            ? <FileText className="size-4 text-sky-600" />
            : <PlaySquare className="size-4 text-red-500" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{source.type === 'x_post' ? 'X 原文' : 'YouTube 字幕'}</Badge>
            <span>{source.author || '未知来源'}</span>
          </div>
          <h2 className="text-lg font-semibold leading-7">{source.title || detail.source_title}</h2>
        </div>
        {source.url && (
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'shrink-0')}
          >
            打开原文 <ExternalLink className="ml-1 size-3.5" />
          </a>
        )}
      </div>

      <div data-testid="response-source-scroll" className="min-h-0 flex-1 overflow-y-auto p-5">
        {!source.available ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/30 p-5 text-sm text-muted-foreground">
            <p>{source.unavailable_reason || '原文正文暂不可用'}</p>
            {source.url && <p className="mt-2">请打开原文查看，情报中心不会用猜测内容替代原文。</p>}
          </div>
        ) : (
          <>
            {source.type === 'youtube_video' && source.description && (
              <div className="mb-5 rounded-xl bg-muted/40 p-4 text-sm leading-6 text-muted-foreground">
                <p className="mb-1 text-xs font-medium text-foreground-subtle">视频说明</p>
                {source.description}
              </div>
            )}
            <article className="whitespace-pre-wrap text-sm leading-7 text-foreground">
              {body}
            </article>
          </>
        )}
      </div>
    </section>
  )
}
