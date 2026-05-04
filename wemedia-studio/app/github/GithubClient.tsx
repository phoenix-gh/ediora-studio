'use client'

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { GithubRepo, GithubIssue, IssuePainPoint, GithubTrendingRepo, GithubRelease } from '@/lib/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  GitFork, TrendingUp, AlertCircle, Zap, Plus, RefreshCw,
  Trash2, VolumeX, Star, ExternalLink, ChevronDown, Loader2,
  Bug, Lightbulb, Gauge, MousePointer, BookOpen, Clock, Tag,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  addGithubRepo, deleteGithubRepo, updateGithubRepo,
  collectOneRepo, collectOneRepoReleases, collectAllGithub, analyzePainPoints,
  getGithubIssues, getPainPoints, getTrendingRepos, getGithubReleases,
} from '@/lib/api/github'

type Tab = 'trending' | 'issues' | 'pain-points' | 'releases'

const severityColor: Record<string, string> = {
  high: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800',
  medium: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950 border-amber-200 dark:border-amber-800',
  low: 'text-zinc-500 bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700',
}
const severityLabel: Record<string, string> = { high: '高', medium: '中', low: '低' }

const categoryIcon: Record<string, typeof Bug> = {
  bug: Bug,
  feature: Lightbulb,
  performance: Gauge,
  ux: MousePointer,
  docs: BookOpen,
}
const categoryLabel: Record<string, string> = {
  bug: 'Bug', feature: '功能', performance: '性能', ux: '体验', docs: '文档',
}

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

// ── Add Repo Dialog ────────────────────────────────────────────────────────────

function AddRepoDialog({ onAdded }: { onAdded: (r: GithubRepo) => void }) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [intervalMin, setIntervalMin] = useState('10')
  const [group, setGroup] = useState('未分组')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('')

  async function handleAdd() {
    const parts = input.trim().replace(/^https?:\/\/github\.com\//, '').split('/')
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      toast.error('格式：owner/repo 或完整 GitHub URL')
      return
    }
    const [owner, repo] = parts
    setLoading(true)
    setStatus('添加仓库中…')
    try {
      const added = await addGithubRepo(owner, repo, group, parseInt(intervalMin) || 10)
      // Backend immediately kicks off collection in background — no need to call collect here
      onAdded(added)
      toast.success(`已添加 ${owner}/${repo}，后台采集中…`)
      setOpen(false)
      setInput('')
      setStatus('')
    } catch (e) {
      toast.error(`添加失败：${e}`)
      setStatus('')
    } finally {
      setLoading(false)
    }
  }

  if (!open) return (
    <Button size="sm" className="h-7 gap-1 text-xs w-full" onClick={() => setOpen(true)}>
      <Plus className="w-3.5 h-3.5" />添加仓库
    </Button>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setOpen(false)}>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-5 w-80 shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-4">添加跟踪仓库</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">仓库</label>
            <Input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="owner/repo 或 GitHub URL"
              className="h-8 text-sm"
              onKeyDown={e => e.key === 'Enter' && handleAdd()}
              autoFocus
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-xs text-zinc-500 mb-1 block">分组</label>
              <Input value={group} onChange={e => setGroup(e.target.value)} placeholder="未分组" className="h-8 text-sm" />
            </div>
            <div className="w-28">
              <label className="text-xs text-zinc-500 mb-1 block">采集间隔（分钟）</label>
              <Input value={intervalMin} onChange={e => setIntervalMin(e.target.value)} className="h-8 text-sm" type="number" min="1" />
            </div>
          </div>
        </div>
        {status && (
          <p className="mt-3 text-xs text-zinc-400 flex items-center gap-1.5">
            {loading && <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />}
            {status}
          </p>
        )}
        <div className="flex gap-2 mt-4">
          <Button size="sm" onClick={handleAdd} disabled={loading} className="flex-1 gap-1">
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}添加
          </Button>
          <Button size="sm" variant="outline" onClick={() => setOpen(false)} disabled={loading}>取消</Button>
        </div>
      </div>
    </div>
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
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Issues Tab ─────────────────────────────────────────────────────────────────

function IssuesTab({ repoId, issues: initial, onLoad }: { repoId: string; issues: GithubIssue[]; onLoad: (rows: GithubIssue[]) => void }) {
  const [issues, setIssues] = useState(initial)
  const [collecting, setCollecting] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function stopPoll() {
    if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null }
  }

  function applyRows(rows: GithubIssue[]) {
    setIssues(rows)
    onLoad(rows)
  }

  async function pollUntilData(rid: string, attempts = 0) {
    if (attempts > 20) { setCollecting(false); return }
    const rows = await getGithubIssues(rid, 100).catch(() => null)
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
      await collectOneRepo(owner, repo)
      const rows = await getGithubIssues(repoId, 100)
      applyRows(rows)
      toast.success('采集完成')
    } catch {
      toast.error('采集失败')
    } finally {
      setCollecting(false)
    }
  }

  // When no data yet, poll — backend is already collecting in background
  useEffect(() => {
    stopPoll()
    setIssues(initial)
    if (initial.length === 0) {
      setCollecting(true)
      pollUntilData(repoId)
    }
    return stopPoll
  }, [repoId])

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-3">
        <span className="text-xs text-zinc-400">{issues.length} 条 Open Issues · 按关注度排序</span>
        <Button size="sm" variant="outline" className="ml-auto h-7 text-xs gap-1" onClick={handleCollect} disabled={collecting}>
          <RefreshCw className={cn('w-3.5 h-3.5', collecting && 'animate-spin')} />立即采集
        </Button>
      </div>

      {issues.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
          <AlertCircle className="w-10 h-10 text-zinc-300 dark:text-zinc-700" />
          <p className="text-sm text-zinc-500">暂无 Issues</p>
          <p className="text-xs text-zinc-400">点击「立即采集」从 GitHub 拉取</p>
        </div>
      ) : (
        <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {issues.map(issue => {
            const isOpen = expanded === issue.id
            return (
              <div key={issue.id} className="px-6 py-3 hover:bg-zinc-50/80 dark:hover:bg-zinc-800/30 transition-colors">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start gap-2 mb-1">
                      <a
                        href={issue.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-zinc-900 dark:text-zinc-100 hover:text-indigo-600 transition-colors leading-snug flex-1"
                      >
                        {issue.title}
                      </a>
                      <span className="text-[10px] text-zinc-400 flex-shrink-0">#{issue.number}</span>
                    </div>
                    {issue.labels.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
                        {issue.labels.map(l => (
                          <span key={l} className="text-[10px] bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 px-1.5 py-0.5 rounded-full">{l}</span>
                        ))}
                      </div>
                    )}
                    {issue.body && (
                      <div>
                        <p className={cn('text-xs text-zinc-500 leading-relaxed', !isOpen && 'line-clamp-2')}>
                          {issue.body}
                        </p>
                        {issue.body.length > 200 && (
                          <button
                            onClick={() => setExpanded(isOpen ? null : issue.id)}
                            className="mt-0.5 flex items-center gap-0.5 text-[11px] text-zinc-400 hover:text-indigo-500"
                          >
                            <ChevronDown className={cn('w-3 h-3 transition-transform', isOpen && 'rotate-180')} />
                            {isOpen ? '收起' : '展开'}
                          </button>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-1.5 text-[11px] text-zinc-400">
                      <span>👍 {issue.reactions}</span>
                      <span>💬 {issue.comments}</span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />{formatRelative(issue.created_at)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
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
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

                    <div className="mt-2">
                      <a
                        href={rel.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-indigo-500 transition-colors"
                      >
                        <ExternalLink className="w-3 h-3" />在 GitHub 查看
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Pain Points Tab ────────────────────────────────────────────────────────────

function PainPointsTab({ repoId, points: initial }: { repoId: string; points: IssuePainPoint[] }) {
  const [points, setPoints] = useState(initial)
  const [analyzing, setAnalyzing] = useState(false)

  async function handleAnalyze() {
    setAnalyzing(true)
    try {
      const result = await analyzePainPoints(repoId)
      setPoints(await getPainPoints(repoId))
      toast.success(`分析完成，归纳出 ${result.new_pain_points} 个痛点`)
    } catch {
      toast.error('分析失败，请检查 LLM 配置')
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center gap-3">
        <span className="text-xs text-zinc-400">{points.length} 个用户痛点 · AI 归纳自 Issues</span>
        <Button size="sm" variant="outline" className="ml-auto h-7 text-xs gap-1" onClick={handleAnalyze} disabled={analyzing}>
          {analyzing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
          {analyzing ? 'AI 分析中…' : 'AI 重新分析'}
        </Button>
      </div>

      {points.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-center">
          <Zap className="w-10 h-10 text-zinc-300 dark:text-zinc-700" />
          <p className="text-sm text-zinc-500">暂无痛点分析</p>
          <p className="text-xs text-zinc-400">先采集 Issues，再点击「AI 重新分析」</p>
        </div>
      ) : (
        <div className="p-6 grid gap-3">
          {points.map(pp => {
            const Icon = categoryIcon[pp.category] ?? Bug
            return (
              <div
                key={pp.id}
                className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center flex-shrink-0">
                    <Icon className="w-3.5 h-3.5 text-zinc-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{pp.title}</span>
                      <span className={cn('text-[10px] font-medium border px-1.5 py-0.5 rounded-full', severityColor[pp.severity])}>
                        严重性：{severityLabel[pp.severity]}
                      </span>
                      <span className="text-[10px] text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                        {categoryLabel[pp.category] ?? pp.category}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-500 leading-relaxed mb-2">{pp.description}</p>
                    <div className="flex items-center gap-3 text-[11px] text-zinc-400">
                      <span>涉及 {pp.issue_count} 个 Issues</span>
                      {pp.example_issues.length > 0 && (
                        <span>代表：{pp.example_issues.slice(0, 5).map(n => `#${n}`).join(' ')}</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Main Client ────────────────────────────────────────────────────────────────

interface Props {
  initialRepos: GithubRepo[]
  initialTrending: GithubTrendingRepo[]
  initialIssues: GithubIssue[]
  initialPainPoints: IssuePainPoint[]
  initialReleases: GithubRelease[]
}

export function GithubClient({ initialRepos, initialTrending, initialIssues, initialPainPoints, initialReleases }: Props) {
  const [repos, setRepos] = useState(initialRepos)
  const [allIssues, setAllIssues] = useState(initialIssues)
  const [allReleases, setAllReleases] = useState(initialReleases)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('trending')
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const selected = repos.find(r => r.id === selectedId) ?? null

  const repoIssues = useMemo(
    () => allIssues.filter(i => i.repo_id === selectedId),
    [allIssues, selectedId]
  )
  const repoPainPoints = useMemo(
    () => initialPainPoints.filter(p => p.repo_id === selectedId),
    [initialPainPoints, selectedId]
  )
  const repoReleases = useMemo(
    () => allReleases.filter(r => r.repo_id === selectedId),
    [allReleases, selectedId]
  )

  const handleSelectRepo = useCallback((id: string) => {
    setSelectedId(id)
    setTab(prev => prev === 'trending' ? 'issues' : prev)
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

  const tabs: { id: Tab; label: string; icon: typeof GitFork }[] = [
    { id: 'trending', label: '热门趋势', icon: TrendingUp },
    { id: 'releases', label: '发布', icon: Tag },
    { id: 'issues', label: 'Issues', icon: AlertCircle },
    { id: 'pain-points', label: '用户痛点', icon: Zap },
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

        <div className="px-4 py-3 border-t border-zinc-100 dark:border-zinc-800">
          <AddRepoDialog onAdded={(r) => {
            setRepos(prev => [...prev, r])
            setSelectedId(r.id)
            setTab('releases')
          }} />
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
                      ({t.id === 'issues' ? repoIssues.length : t.id === 'releases' ? repoReleases.length : repoPainPoints.length})
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
        {tab === 'issues' && selected && (
          <IssuesTab
            repoId={selected.id}
            issues={repoIssues}
            onLoad={rows => setAllIssues(prev => [...prev.filter(i => i.repo_id !== selected.id), ...rows])}
          />
        )}
        {tab === 'pain-points' && selected && <PainPointsTab repoId={selected.id} points={repoPainPoints} />}
        {tab !== 'trending' && !selected && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-zinc-400">请先在左侧选择一个仓库</p>
          </div>
        )}
      </div>
    </div>
  )
}
