import Link from 'next/link'
import { GitFork, ArrowRight, ExternalLink } from 'lucide-react'
import { fmtRelTime } from '@/lib/format'
import type { ReleaseToday } from '@/lib/api/dashboard'
import { AsyncState } from '@/components/layout/AsyncState'
import { StatusBadge } from '@/components/layout/StatusBadge'
import { GenerateDraftButton } from './GenerateDraftButton'

export function ReleasesToday({ releases }: { releases: ReleaseToday[] }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-center gap-2">
        <GitFork className="text-success" />
        <h2 className="text-sm font-semibold text-foreground">今日可写 · GitHub 新发布</h2>
        <Link href="/github" className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline">
          全部仓库 <ArrowRight />
        </Link>
      </div>
      {releases.length === 0 ? (
        <AsyncState variant="empty" title="今天暂无新 Release" />
      ) : (
        <div className="flex flex-col gap-2">
          {releases.map(r => (
            <div
              key={`${r.repo_id}:${r.tag_name}`}
              className="flex h-16 items-center gap-3 rounded-xl border border-border bg-surface px-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <a
                    href={r.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-sm font-medium text-foreground hover:text-primary"
                  >
                    {r.repo_id} <span className="font-normal text-foreground-subtle">{r.tag_name}</span>
                  </a>
                  {r.is_prerelease && (
                    <StatusBadge variant="warning">pre</StatusBadge>
                  )}
                  <ExternalLink className="shrink-0 text-foreground-subtle" />
                </div>
                <p className="mt-0.5 truncate text-xs text-foreground-subtle">{r.name} · {fmtRelTime(r.published_at)}</p>
              </div>
              {r.draft_ids.length > 0 ? (
                <Link
                  href={`/drafts?draft=${r.draft_ids[0]}`}
                  className="shrink-0 text-xs font-medium text-primary hover:underline"
                >
                  查看草稿（{r.draft_ids.length}）
                </Link>
              ) : (
                <GenerateDraftButton repoId={r.repo_id} tag={r.tag_name} />
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
