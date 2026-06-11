import Link from 'next/link'
import { GitFork, ArrowRight, ExternalLink } from 'lucide-react'
import { fmtRelTime } from '@/lib/format'
import type { ReleaseToday } from '@/lib/api/dashboard'
import { GenerateDraftButton } from './GenerateDraftButton'

export function ReleasesToday({ releases }: { releases: ReleaseToday[] }) {
  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <GitFork className="w-4 h-4 text-emerald-600" />
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">今日可写 · GitHub 新发布</h2>
        <Link href="/github" className="ml-auto flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600">
          全部仓库 <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      {releases.length === 0 ? (
        <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-4 text-center text-zinc-400 text-xs">
          今天暂无新 Release
        </div>
      ) : (
        <div className="space-y-2">
          {releases.map(r => (
            <div
              key={`${r.repo_id}:${r.tag_name}`}
              className="flex items-center gap-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <a
                    href={r.html_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:text-indigo-600 truncate"
                  >
                    {r.repo_id} <span className="text-zinc-400 font-normal">{r.tag_name}</span>
                  </a>
                  {r.is_prerelease && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 shrink-0">pre</span>
                  )}
                  <ExternalLink className="w-3 h-3 text-zinc-300 shrink-0" />
                </div>
                <p className="text-xs text-zinc-400 truncate mt-0.5">{r.name} · {fmtRelTime(r.published_at)}</p>
              </div>
              {r.draft_ids.length > 0 ? (
                <Link
                  href={`/drafts?draft=${r.draft_ids[0]}`}
                  className="text-xs font-medium text-emerald-600 hover:text-emerald-700 shrink-0"
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
