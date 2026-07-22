'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { GithubRepo, GithubTrendingRepo, GithubRelease } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  GitFork, TrendingUp, Plus, RefreshCw,
  Trash2, VolumeX, Volume2, Star, ExternalLink, ChevronDown, Loader2,
  BookOpen, Clock, Tag, Settings, FileText,
} from 'lucide-react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  addGithubRepo, deleteGithubRepo, updateGithubRepo,
  collectOneRepo, collectOneRepoReleases, collectAllGithub,
  getTrendingRepos, getGithubReleases,
  generateReleaseDraft, dispatchReleaseWrite, dispatchRepoIntro,
} from '@/lib/api/github'
import { WritingPlan, getWritingPlans } from '@/lib/api/writing-plans'
import { PublishAccount, listPublishAccounts } from '@/lib/api/publish-accounts'
import { AddToTopicPopover } from '@/components/features/AddToTopicPopover'

type Tab = 'trending' | 'releases'

function formatStars(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function formatRelative(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const d = Math.floor(diff / 86400000)
  if (d === 0) return '今天'
  if (d === 1) return '昨天'
  return `${d} 天前`
}

// ── Subscribe Dialog ──────────────────────────────────────────────────────────

function SubscribeDialog({
  open, onOpenChange, repos, onAdded, onUpdated, onDeleted,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  repos: GithubRepo[]
  onAdded: (r: GithubRepo) => void
  onUpdated: (r: GithubRepo) => void
  onDeleted: (id: string) => void
}) {
  const [input, setInput] = useState('')
  const [intervalMin, setIntervalMin] = useState('60')
  const [group, setGroup] = useState('未分组')
  const [adding, setAdding] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const [expandedRepoId, setExpandedRepoId] = useState<string | null>(null)

  async function handleAdd(e?: React.FormEvent) {
    e?.preventDefault()
    const parts = input.trim().replace(/^https?:\/\/github\.com\//, '').split('/')
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      toast.error('格式：owner/repo 或完整 GitHub URL')
      return
    }
    const [owner, repo] = parts
    setAdding(true)
    try {
      const added = await addGithubRepo(owner, repo, group, parseInt(intervalMin) || 60)
      onAdded(added)
      toast.success(`已添加 ${owner}/${repo}，后台采集中…`)
      setInput('')
    } catch (e) {
      toast.error(`添加失败：${e}`)
    } finally {
      setAdding(false)
    }
  }

  async function handleSync(r: GithubRepo) {
    setActingId(r.id)
    try {
      await collectOneRepo(r.owner, r.repo)
      toast.success(`${r.id}：后台同步已启动`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '同步失败')
    } finally {
      setActingId(null)
    }
  }

  async function handleToggleMute(r: GithubRepo) {
    setActingId(r.id)
    try {
      const u = await updateGithubRepo(r.owner, r.repo, { muted: !r.muted })
      onUpdated(u)
    } catch {
      toast.error('操作失败')
    } finally {
      setActingId(null)
    }
  }

  async function handleDelete(r: GithubRepo) {
    setActingId(r.id)
    try {
      await deleteGithubRepo(r.owner, r.repo)
      onDeleted(r.id)
      toast(`已移除 ${r.id}`)
    } catch {
      toast.error('删除失败')
    } finally {
      setActingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>订阅管理 · GitHub</DialogTitle>
          <DialogDescription>
            添加要追踪的仓库，系统会按设定间隔自动采集 Releases。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleAdd} className="flex items-center gap-2">
          <Input value={input} onChange={e => setInput(e.target.value)}
            placeholder="owner/repo 或 GitHub URL" className="h-8 text-xs flex-1" />
          <Input value={group} onChange={e => setGroup(e.target.value)}
            placeholder="未分组" className="h-8 text-xs w-24" />
          <Input value={intervalMin} onChange={e => setIntervalMin(e.target.value)}
            type="number" min="1" className="h-8 text-xs w-20" title="采集间隔（分钟）" />
          <Button type="submit" size="sm" className="h-8 text-xs" disabled={adding || !input.trim()}>
            {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '添加'}
          </Button>
        </form>

        <div>
          <div className="text-[11px] uppercase tracking-wider text-zinc-400 mb-1.5 px-0.5">
            已订阅 · {repos.length}
          </div>
          {repos.length === 0 ? (
            <div className="text-xs text-zinc-400 py-6 text-center border border-dashed rounded-md">
              暂无追踪仓库。输入 owner/repo 后点击「添加」。
            </div>
          ) : (
            <div className="border border-zinc-200 dark:border-zinc-800 rounded-md max-h-72 overflow-y-auto">
              {repos.map(r => (
                <div key={r.id} className={cn('border-b border-zinc-100 dark:border-zinc-800 last:border-0', r.muted && 'opacity-50')}>
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <GitFork className="w-4 h-4 text-zinc-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{r.id}</div>
                    <div className="text-[11px] text-zinc-400 truncate">
                      <Star className="w-2.5 h-2.5 inline -mt-0.5" /> {formatStars(r.stars)}
                      {r.language && <> · {r.language}</>} · {r.collect_interval_minutes}m
                      {r.last_collected_at && <> · 最近 {formatRelative(r.last_collected_at)}</>}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 px-2"
                    disabled={actingId === r.id} onClick={() => handleSync(r)}>
                    {actingId === r.id
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <RefreshCw className="w-3 h-3" />}
                    同步
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                    disabled={actingId === r.id}
                    title={r.muted ? '取消静音' : '静音'}
                    onClick={() => handleToggleMute(r)}>
                    {r.muted ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
                    title="草稿设置"
                    onClick={() => setExpandedRepoId(expandedRepoId === r.id ? null : r.id)}>
                    <FileText className="w-3 h-3" />
                  </Button>
                  <Button size="sm" variant="ghost"
                    className="h-7 w-7 p-0 text-red-400 hover:text-red-600"
                    disabled={actingId === r.id}
                    onClick={() => handleDelete(r)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                  </div>
                {expandedRepoId === r.id && (
                  <div className="px-2.5 py-2 bg-zinc-50 dark:bg-zinc-900 border-t border-zinc-100 dark:border-zinc-800 flex items-center gap-3 flex-wrap">
                    <span className="text-[11px] text-zinc-500">发布稿</span>
                    <button
                      className={cn(
                        'text-[11px] px-2 py-0.5 rounded border transition-colors',
                        r.release_draft_enabled
                          ? 'bg-indigo-50 border-indigo-200 text-indigo-600 dark:bg-indigo-950 dark:border-indigo-800 dark:text-indigo-400'
                          : 'bg-zinc-100 border-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:border-zinc-700'
                      )}
                      onClick={async () => {
                        const u = await updateGithubRepo(r.owner, r.repo, { release_draft_enabled: !r.release_draft_enabled })
                        onUpdated(u)
                      }}
                    >
                      {r.release_draft_enabled ? '已开启' : '已关闭'}
                    </button>
                    {r.release_draft_enabled && (
                      <>
                        {(['tech', 'product'] as const).map(t => {
                          const active = r.release_draft_types?.includes(t) ?? true
                          const label = t === 'tech' ? '技术向' : '产品向'
                          return (
                            <button
                              key={t}
                              className={cn(
                                'text-[11px] px-2 py-0.5 rounded border transition-colors',
                                active
                                  ? 'bg-emerald-50 border-emerald-200 text-emerald-600 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-400'
                                  : 'bg-zinc-100 border-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:border-zinc-700'
                              )}
                              onClick={async () => {
                                const current = r.release_draft_types ?? ['tech', 'product']
                                const next = active
                                  ? current.filter(x => x !== t)
                                  : [...current, t]
                                if (next.length === 0) return
                                const u = await updateGithubRepo(r.owner, r.repo, { release_draft_types: next })
                                onUpdated(u)
                              }}
                            >
                              {label}
                            </button>
                          )
                        })}
                      </>
                    )}
                  </div>
                )}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Trending Tab ───────────────────────────────────────────────────────────────

function TrendingTab({ items }: { items: GithubTrendingRepo[] }) {
  const [period, setPeriod] = useState<'daily' | 'weekly'>('daily')
  const [localItems, setLocalItems] = useState(items)
  const [loading, setLoading] = useState(false)

  async function handlePeriodChange(p: 'daily' | 'weekly') {
    setPeriod(p)
    setLoading(true)
    try {
      setLocalItems(await getTrendingRepos(p))
    } catch {
      toast.error('获取失败')
    } finally {
      setLoading(false)
    }
  }

  async function handleRefresh() {
    setLoading(true)
    try {
      await collectAllGithub()
      setLocalItems(await getTrendingRepos(period))
      toast.success('趋势刷新任务已启动')
    } catch {
      toast.error('刷新失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-3">
        <div className="flex gap-1 bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
          {(['daily', 'weekly'] as const).map(p => (
            <button
              key={p}
              onClick={() => handlePeriodChange(p)}
              className={cn(
                'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                period === p
                  ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-700'
              )}
            >
              {p === 'daily' ? '今日' : '本周'}
            </button>
          ))}
        </div>
        <span className="text-xs text-zinc-400">{localItems.length} 个仓库</span>
        <Button size="sm" variant="outline" className="ml-auto h-7 text-xs gap-1" onClick={handleRefresh} disabled={loading}>
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />刷新
        </Button>
      </div>

      {localItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 text-center gap-3">
          <GitFork className="w-10 h-10 text-zinc-300 dark:text-zinc-700" />
          <p className="text-sm text-zinc-500">暂无趋势数据</p>
          <p className="text-xs text-zinc-400">点击「刷新」从 RSSHub 获取 GitHub Trending</p>
        </div>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {localItems.map((r, i) => (
            <div key={r.id} className="flex items-center gap-4 px-6 py-3 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/30 transition-colors">
              <span className={cn(
                'text-xs font-bold tabular-nums w-5 text-center flex-shrink-0',
                i < 3 ? 'text-amber-500' : 'text-zinc-400'
              )}>#{i + 1}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:text-indigo-600 transition-colors flex items-center gap-1"
                  >
                    {r.owner}/{r.repo}
                    <ExternalLink className="w-3 h-3 opacity-50" />
                  </a>
                  {r.language && (
                    <span className="text-[10px] bg-zinc-100 dark:bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded">{r.language}</span>
                  )}
                </div>
                <p className="text-xs text-zinc-500 truncate">{r.description}</p>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0 text-xs text-zinc-400">
                <span className="flex items-center gap-1"><Star className="w-3.5 h-3.5" />{formatStars(r.stars)}</span>
                {r.stars_gained > 0 && (
                  <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400 font-medium">
                    <TrendingUp className="w-3.5 h-3.5" />+{formatStars(r.stars_gained)}
                  </span>
                )}
                <AddToTopicPopover
                  url={r.url}
                  title={`${r.owner}/${r.repo}`}
                  summary={r.description}
                  platform="github"
                  className="!w-6 !h-6"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Releases Tab ──────────────────────────────────────────────────────────────

function ReleasesTab({ repoId, releases: initial, onLoad }: { repoId: string; releases: GithubRelease[]; onLoad: (rows: GithubRelease[]) => void }) {
  const [releases, setReleases] = useState(initial)
  const [collecting, setCollecting] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [generatingId, setGeneratingId] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Agent dispatch dialog
  const [dispatchTarget, setDispatchTarget] = useState<GithubRelease | null>(null)
  const [dispatchAccounts, setDispatchAccounts] = useState<PublishAccount[]>([])
  const [dispatchPlans, setDispatchPlans] = useState<WritingPlan[]>([])
  const [dispatchAccountId, setDispatchAccountId] = useState('')
  const [dispatchPlanId, setDispatchPlanId] = useState<number | null>(null)
  const [dispatchWithCover, setDispatchWithCover] = useState(true)
  const [dispatching, setDispatching] = useState(false)

  function stopPoll() {
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null }
  }

  function applyRows(rows: GithubRelease[]) {
    setReleases(rows)
    onLoad(rows)
  }

  async function pollUntilData(rid: string, attempts = 0) {
    if (attempts > 10) { setCollecting(false); return }
    const rows = await getGithubReleases(rid, 30).catch(() => null)
    if (rows && rows.length > 0) {
      applyRows(rows)
      setCollecting(false)
    } else {
      pollTimer.current = setTimeout(() => pollUntilData(rid, attempts + 1), 3000)
    }
  }

  // Manual refresh button — only user-initiated
  async function handleCollect() {
    setCollecting(true)
    stopPoll()
    try {
      const [owner, repo] = repoId.split('/')
      await collectOneRepoReleases(owner, repo)
      const rows = await getGithubReleases(repoId, 30)
      applyRows(rows)
      toast.success('发布记录已更新')
    } catch {
      toast.error('采集失败')
    } finally {
      setCollecting(false)
    }
  }

  async function handleGenerateDraft(rel: GithubRelease) {
    const [owner, repo] = repoId.split('/')
    setGeneratingId(rel.id)
    try {
      const result = await generateReleaseDraft(owner, repo, rel.tag_name)
      const rows = await getGithubReleases(repoId, 30)
      applyRows(rows)
      if (result.drafts_created > 0) {
        toast.success(`已生成 ${result.drafts_created} 份草稿，前往草稿箱查看`)
      } else {
        toast('草稿已存在，未重复创建')
      }
    } catch {
      toast.error('生成失败，请检查 LLM 配置')
    } finally {
      setGeneratingId(null)
    }
  }

  function openDispatch(rel: GithubRelease) {
    setDispatchTarget(rel)
    setDispatching(false)
    Promise.all([listPublishAccounts(), getWritingPlans()]).then(([accs, plans]) => {
      const active = accs.filter(a => a.is_active)
      setDispatchAccounts(active)
      setDispatchPlans(plans)
      if (active.length > 0 && !dispatchAccountId) setDispatchAccountId(active[0].id)
      if (plans.length > 0 && dispatchPlanId === null) setDispatchPlanId(plans[0].id)
    }).catch(() => toast.error('加载数据失败'))
  }

  async function handleDispatch() {
    if (!dispatchTarget || !dispatchAccountId || dispatchPlanId === null) return
    const [owner, repo] = repoId.split('/')
    setDispatching(true)
    try {
      const result = await dispatchReleaseWrite(owner, repo, dispatchTarget.tag_name, dispatchAccountId, dispatchPlanId, dispatchWithCover)
      setDispatchTarget(null)
      toast.success('已创建创作任务', {
        description: `任务 ${result.task_id}`,
        action: { label: '查看看板', onClick: () => window.location.href = result.kanban_url },
      })
    } catch {
      toast.error('派发失败，请检查任务服务')
    } finally {
      setDispatching(false)
    }
  }

  // When no data yet, poll — backend is already collecting in background
  useEffect(() => {
    stopPoll()
    setReleases(initial)
    if (initial.length === 0) {
      setCollecting(true)
      pollUntilData(repoId)
    }
    return stopPoll
  }, [repoId])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-3">
        <span className="text-xs text-zinc-400">{releases.length} 条发布记录</span>
        <Button size="sm" variant="outline" className="ml-auto h-7 text-xs gap-1" onClick={handleCollect} disabled={collecting}>
          <RefreshCw className={cn('w-3.5 h-3.5', collecting && 'animate-spin')} />刷新
        </Button>
      </div>

      {releases.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
          <Tag className="w-10 h-10 text-zinc-300 dark:text-zinc-700" />
          <p className="text-sm text-zinc-500">暂无发布记录</p>
          <p className="text-xs text-zinc-400">点击「刷新」从 GitHub 拉取</p>
        </div>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {releases.map(rel => {
            const isOpen = expanded === rel.id
            return (
              <div key={rel.id} className="px-6 py-4 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/30 transition-colors">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Tag className="w-3.5 h-3.5 text-zinc-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* Header */}
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <a
                        href={rel.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 hover:text-indigo-600 transition-colors font-mono"
                      >
                        {rel.tag_name}
                      </a>
                      {rel.name && rel.name !== rel.tag_name && (
                        <span className="text-sm text-zinc-600 dark:text-zinc-400 truncate">{rel.name}</span>
                      )}
                      {rel.is_prerelease && (
                        <span className="text-[10px] font-medium border px-1.5 py-0.5 rounded-full text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800">
                          Pre-release
                        </span>
                      )}
                      {rel.draft_generated_at && (
                        <a
                          href="/drafts"
                          className="text-[10px] font-medium border px-1.5 py-0.5 rounded-full text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950 border-emerald-200 dark:border-emerald-800 hover:opacity-80 transition-opacity"
                        >
                          草稿已生成
                        </a>
                      )}
                      <span className="ml-auto flex items-center gap-1 text-[11px] text-zinc-400 flex-shrink-0">
                        <Clock className="w-3 h-3" />
                        {formatRelative(rel.published_at)}
                      </span>
                    </div>

                    {/* Changelog body */}
                    {rel.body && (
                      <div>
                        <p className={cn(
                          'text-xs text-zinc-500 leading-relaxed whitespace-pre-wrap',
                          !isOpen && 'line-clamp-3'
                        )}>
                          {rel.body}
                        </p>
                        {rel.body.length > 200 && (
                          <button
                            onClick={() => setExpanded(isOpen ? null : rel.id)}
                            className="mt-1 flex items-center gap-0.5 text-[11px] text-zinc-400 hover:text-indigo-500"
                          >
                            <ChevronDown className={cn('w-3 h-3 transition-transform', isOpen && 'rotate-180')} />
                            {isOpen ? '收起' : '查看完整 Changelog'}
                          </button>
                        )}
                      </div>
                    )}

                    <div className="mt-2 flex items-center gap-3 flex-wrap">
                      <a
                        href={rel.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-indigo-500 transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />在 GitHub 查看
                      </a>
                      <button
                        onClick={() => openDispatch(rel)}
                        className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-indigo-600 transition-colors"
                      >
                        <FileText className="w-3 h-3" />
                        创建稿件
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 创作任务 dialog */}
      <Dialog open={!!dispatchTarget} onOpenChange={open => { if (!open) setDispatchTarget(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">创建稿件</DialogTitle>
            <DialogDescription className="text-xs">
              {dispatchTarget && (
                <span className="font-mono">{dispatchTarget.tag_name}</span>
              )}
              {' '}— 选择账号和写作方案后创建创作任务
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1 block">发布账号</label>
              {dispatchAccounts.length === 0 ? (
                <p className="text-xs text-zinc-400">加载中…</p>
              ) : (
                <select
                  value={dispatchAccountId}
                  onChange={e => setDispatchAccountId(e.target.value)}
                  className="w-full text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2.5 py-1.5 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 outline-none focus:border-indigo-400"
                >
                  {dispatchAccounts.map(a => (
                    <option key={a.id} value={a.id}>{a.name} ({a.platform})</option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1 block">写作方案</label>
              {dispatchPlans.length === 0 ? (
                <p className="text-xs text-zinc-400">加载中…</p>
              ) : (
                <select
                  value={dispatchPlanId ?? ''}
                  onChange={e => setDispatchPlanId(Number(e.target.value))}
                  className="w-full text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2.5 py-1.5 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 outline-none focus:border-indigo-400"
                >
                  {dispatchPlans.map(p => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={dispatchWithCover}
                onChange={e => setDispatchWithCover(e.target.checked)}
                className="rounded"
              />
              <span className="text-xs text-zinc-600 dark:text-zinc-400">同时配封面</span>
            </label>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => setDispatchTarget(null)}>
                取消
              </Button>
              <Button
                size="sm"
                className="text-xs h-8 gap-1"
                disabled={dispatching || !dispatchAccountId || dispatchPlanId === null}
                onClick={handleDispatch}
              >
                {dispatching && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                创建创作任务
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Main Client ────────────────────────────────────────────────────────────────

interface Props {
  initialRepos: GithubRepo[]
  initialTrending: GithubTrendingRepo[]
  initialReleases: GithubRelease[]
}

export function GithubClient({ initialRepos, initialTrending, initialReleases }: Props) {
  const [repos, setRepos] = useState(initialRepos)
  const [allReleases, setAllReleases] = useState(initialReleases)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('trending')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [subsOpen, setSubsOpen] = useState(false)

  // 写简介 dialog state
  const [introTargetRepo, setIntroTargetRepo] = useState<GithubRepo | null>(null)
  const [introAccounts, setIntroAccounts] = useState<PublishAccount[]>([])
  const [introPlans, setIntroPlans] = useState<WritingPlan[]>([])
  const [introAccountId, setIntroAccountId] = useState<string>('')
  const [introPlanId, setIntroPlanId] = useState<number | null>(null)
  const [introWithCover, setIntroWithCover] = useState(true)
  const [introDispatching, setIntroDispatching] = useState(false)

  const selected = repos.find(r => r.id === selectedId) ?? null

  const repoReleases = useMemo(
    () => allReleases.filter(r => r.repo_id === selectedId),
    [allReleases, selectedId]
  )

  const handleSelectRepo = useCallback((id: string) => {
    setSelectedId(id)
    setTab('releases')
  }, [])

  async function handleDelete(repo: GithubRepo) {
    setDeletingId(repo.id)
    try {
      await deleteGithubRepo(repo.owner, repo.repo)
      setRepos(prev => prev.filter(r => r.id !== repo.id))
      if (selectedId === repo.id) { setSelectedId(null); setTab('trending') }
      toast(`已移除 ${repo.id}`)
    } catch {
      toast.error('删除失败')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleToggleMute(repo: GithubRepo) {
    try {
      const updated = await updateGithubRepo(repo.owner, repo.repo, { muted: !repo.muted })
      setRepos(prev => prev.map(r => r.id === updated.id ? updated : r))
    } catch {
      toast.error('操作失败')
    }
  }

  async function openIntroDispatch(repo: GithubRepo) {
    setIntroTargetRepo(repo)
    setIntroDispatching(false)
    try {
      const [accounts, plans] = await Promise.all([listPublishAccounts(), getWritingPlans()])
      setIntroAccounts(accounts)
      setIntroPlans(plans)
      if (accounts.length > 0) setIntroAccountId(accounts[0].id)
      if (plans.length > 0) setIntroPlanId(plans[0].id)
    } catch {
      toast.error('加载账号/方案失败')
    }
  }

  async function handleIntroDispatch() {
    if (!introTargetRepo || !introAccountId || introPlanId === null) return
    setIntroDispatching(true)
    try {
      await dispatchRepoIntro(introTargetRepo.owner, introTargetRepo.repo, introAccountId, introPlanId, introWithCover)
      toast.success(`已派发「${introTargetRepo.id}」简介写稿任务`)
      setIntroTargetRepo(null)
    } catch {
      toast.error('派发失败')
    } finally {
      setIntroDispatching(false)
    }
  }

  const tabs: { id: Tab; label: string; icon: typeof GitFork }[] = [
    { id: 'trending', label: '热门趋势', icon: TrendingUp },
    { id: 'releases', label: '发布', icon: Tag },
  ]

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar */}
      <aside className="w-60 flex-shrink-0 border-r border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-2">
          <GitFork className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">GitHub 雷达</h2>
            <p className="text-[11px] text-zinc-400">{repos.length} 个跟踪仓库</p>
          </div>
          <Button size="sm" variant="outline" className="h-7 w-7 p-0"
            title="订阅管理" onClick={() => setSubsOpen(true)}>
            <Settings className="w-3.5 h-3.5" />
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {/* Trending entry */}
          <button
            onClick={() => { setSelectedId(null); setTab('trending') }}
            className={cn(
              'w-full flex items-center gap-2.5 px-4 py-2 text-xs transition-colors',
              !selectedId
                ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300'
                : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            )}
          >
            <TrendingUp className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="font-medium">热门趋势</span>
            <span className="ml-auto text-zinc-400">{initialTrending.length}</span>
          </button>

          {repos.length > 0 && (
            <>
              <div className="px-4 py-1.5 mt-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                跟踪仓库
              </div>
              {repos.map(repo => (
                <div
                  key={repo.id}
                  className={cn(
                    'group relative flex items-center gap-2 px-4 py-1.5 cursor-pointer transition-colors',
                    selectedId === repo.id
                      ? 'bg-indigo-50 dark:bg-indigo-950/50'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-800',
                    repo.muted && 'opacity-40'
                  )}
                  onClick={() => handleSelectRepo(repo.id)}
                >
                  <GitFork className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className={cn(
                      'text-xs truncate',
                      selectedId === repo.id
                        ? 'text-indigo-700 dark:text-indigo-300 font-medium'
                        : 'text-zinc-700 dark:text-zinc-300'
                    )}>
                      {repo.owner}/{repo.repo}
                    </p>
                    <p className="text-[10px] text-zinc-400 flex items-center gap-1">
                      <Star className="w-2.5 h-2.5" />{formatStars(repo.stars)}
                      {repo.language && <span>· {repo.language}</span>}
                      <span>· {repo.collect_interval_minutes}m</span>
                    </p>
                  </div>
                  <span
                    className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={e => e.stopPropagation()}
                  >
                    <button
                      onClick={() => openIntroDispatch(repo)}
                      className="p-1 rounded hover:bg-indigo-100 dark:hover:bg-indigo-950 text-zinc-400 hover:text-indigo-600"
                      title="写简介"
                    >
                      <BookOpen className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleToggleMute(repo)}
                      className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 hover:text-zinc-700"
                      title={repo.muted ? '取消静音' : '静音'}
                    >
                      <VolumeX className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleDelete(repo)}
                      disabled={deletingId === repo.id}
                      className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-950 text-zinc-400 hover:text-red-500"
                      title="移除"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </span>
                </div>
              ))}
            </>
          )}

          {repos.length === 0 && (
            <div className="px-4 py-6 text-center">
              <p className="text-xs text-zinc-400">还没有跟踪仓库</p>
            </div>
          )}
        </div>

      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Tab bar */}
        <div className="flex-shrink-0 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6">
          <div className="flex items-center gap-1 h-11">
            {tabs.map(t => {
              const disabled = t.id !== 'trending' && !selected
              return (
                <button
                  key={t.id}
                  onClick={() => !disabled && setTab(t.id)}
                  disabled={disabled}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors h-full',
                    tab === t.id
                      ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                      : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300',
                    disabled && 'opacity-40 cursor-not-allowed'
                  )}
                >
                  <t.icon className="w-3.5 h-3.5" />
                  {t.label}
                  {t.id !== 'trending' && selected && (
                    <span className="text-[10px] text-zinc-400">
                      ({repoReleases.length})
                    </span>
                  )}
                </button>
              )
            })}
            {selected && (
              <a
                href={`https://github.com/${selected.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto flex items-center gap-1 text-xs text-zinc-400 hover:text-indigo-500 transition-colors"
              >
                <GitFork className="w-3.5 h-3.5" />
                {selected.id}
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>

        {/* Tab content */}
        {tab === 'trending' && <TrendingTab items={initialTrending} />}
        {tab === 'releases' && selected && (
          <ReleasesTab
            repoId={selected.id}
            releases={repoReleases}
            onLoad={rows => setAllReleases(prev => [...prev.filter(r => r.repo_id !== selected.id), ...rows])}
          />
        )}
        {tab !== 'trending' && !selected && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-zinc-400">请先在左侧选择一个仓库</p>
          </div>
        )}
      </div>

      <SubscribeDialog
        open={subsOpen}
        onOpenChange={setSubsOpen}
        repos={repos}
        onAdded={r => { setRepos(prev => [...prev, r]); setSelectedId(r.id); setTab('releases') }}
        onUpdated={u => setRepos(prev => prev.map(r => r.id === u.id ? u : r))}
        onDeleted={id => {
          setRepos(prev => prev.filter(r => r.id !== id))
          if (selectedId === id) { setSelectedId(null); setTab('trending') }
        }}
      />

      {/* 写简介 dialog */}
      <Dialog open={!!introTargetRepo} onOpenChange={open => { if (!open) setIntroTargetRepo(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">写简介</DialogTitle>
            <DialogDescription className="text-xs">
              {introTargetRepo && <span className="font-mono">{introTargetRepo.id}</span>}
              {' '}— 选择账号和写作方案后创建创作任务
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1 block">发布账号</label>
              {introAccounts.length === 0 ? (
                <p className="text-xs text-zinc-400">加载中…</p>
              ) : (
                <select
                  value={introAccountId}
                  onChange={e => setIntroAccountId(e.target.value)}
                  className="w-full text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2.5 py-1.5 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 outline-none focus:border-indigo-400"
                >
                  {introAccounts.map(a => (
                    <option key={a.id} value={a.id}>{a.name} ({a.platform})</option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1 block">写作方案</label>
              {introPlans.length === 0 ? (
                <p className="text-xs text-zinc-400">加载中…</p>
              ) : (
                <select
                  value={introPlanId ?? ''}
                  onChange={e => setIntroPlanId(Number(e.target.value))}
                  className="w-full text-xs border border-zinc-200 dark:border-zinc-700 rounded-md px-2.5 py-1.5 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 outline-none focus:border-indigo-400"
                >
                  {introPlans.map(p => (
                    <option key={p.id} value={p.id}>{p.title}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={introWithCover}
                onChange={e => setIntroWithCover(e.target.checked)}
                className="rounded"
              />
              <span className="text-xs text-zinc-600 dark:text-zinc-400">同时配封面</span>
            </label>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" className="text-xs h-8" onClick={() => setIntroTargetRepo(null)}>
                取消
              </Button>
              <Button
                size="sm"
                className="text-xs h-8 gap-1"
                disabled={introDispatching || !introAccountId || introPlanId === null}
                onClick={handleIntroDispatch}
              >
                {introDispatching && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                创建创作任务
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
