'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { AtSign, RefreshCw, Trash2, ExternalLink, Users, Loader2, CheckCircle, XCircle, Clock, TrendingUp, PauseCircle, PlayCircle } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { XCandidate, XPost, getXCandidates, updateXCandidate, deleteXCandidate, triggerXCollect, triggerTl1UsersCollect } from '@/lib/api/x'
import { XPostsPanel } from './XPostsPanel'

type StatusFilter = 'all' | 'candidate' | 'following' | 'rejected'

const STATUS_LABEL: Record<string, string> = {
  candidate: '待评估',
  following: '已关注',
  rejected: '已忽略',
}

const STATUS_STYLE: Record<string, string> = {
  candidate: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
  following: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
  rejected: 'bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700',
}

function formatFollowers(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const BACKEND = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api').replace(/\/api$/, '')

function AvatarCell({ name, username }: { name: string; username: string }) {
  const [failed, setFailed] = useState(false)
  const initials = name.charAt(0).toUpperCase() || '?'
  const src = `${BACKEND}/api/avatars/x/${username}`
  return (
    <div className="w-8 h-8 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center flex-shrink-0 overflow-hidden">
      {!failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} className="w-full h-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{initials}</span>
      )}
    </div>
  )
}

function formatDate(iso: string) {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export function XClient({
  initialCandidates,
  initialPosts,
}: {
  initialCandidates: XCandidate[]
  initialPosts: XPost[]
}) {

  const [tab, setTab] = useState<'candidates' | 'posts'>('candidates')
  const [candidates, setCandidates] = useState<XCandidate[]>(initialCandidates)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [collecting, setCollecting] = useState(false)
  const [crawling, setCrawling] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [updatingRow, setUpdatingRow] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [countdown, setCountdown] = useState(30)

  const filtered = useMemo(() => {
    let list = candidates
    if (statusFilter !== 'all') list = list.filter(c => c.status === statusFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(c =>
        c.username.toLowerCase().includes(q) ||
        c.display_name.toLowerCase().includes(q) ||
        c.bio.toLowerCase().includes(q)
      )
    }
    return list.sort((a, b) => b.followers - a.followers)
  }, [candidates, statusFilter, search])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const fresh = await getXCandidates(undefined, 200)
      setCandidates(fresh)
    } catch {
      toast.error('刷新失败')
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    if (!autoRefresh || tab !== 'candidates') return
    setCountdown(30)
    const tick = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) {
          refresh()
          return 30
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(tick)
  }, [autoRefresh, tab, refresh])

  const handleCollect = useCallback(async () => {
    setCollecting(true)
    try {
      const res = await triggerXCollect()
      toast.success(res.message || 'X 采集任务已启动，稍后刷新查看新增结果')
      setTimeout(refresh, 15000)
    } catch (e) {
      toast.error(`启动采集失败：${e}`)
    } finally {
      setCollecting(false)
    }
  }, [refresh])

  const handleStatusChange = useCallback(async (username: string, newStatus: string) => {
    setUpdatingRow(username)
    try {
      const updated = await updateXCandidate(username, newStatus)
      setCandidates(prev => prev.map(c => c.username === username ? updated : c))
    } catch {
      toast.error('更新状态失败')
    } finally {
      setUpdatingRow(null)
    }
  }, [])

  const handleDelete = useCallback(async (username: string) => {
    setUpdatingRow(username)
    try {
      await deleteXCandidate(username)
      setCandidates(prev => prev.filter(c => c.username !== username))
      toast.success(`已删除 @${username}`)
    } catch {
      toast.error('删除失败')
    } finally {
      setUpdatingRow(null)
    }
  }, [])

  const counts = useMemo(() => ({
    all: candidates.length,
    candidate: candidates.filter(c => c.status === 'candidate').length,
    following: candidates.filter(c => c.status === 'following').length,
    rejected: candidates.filter(c => c.status === 'rejected').length,
  }), [candidates])

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center">
            <AtSign className="w-4 h-4 text-white dark:text-zinc-900" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">X 监控</h1>
            <p className="text-xs text-zinc-500">博主候选库 · 近期帖子趋势</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'candidates' && (
            <>
              <button
                onClick={() => setAutoRefresh(v => !v)}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors',
                  autoRefresh
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-400'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                )}
              >
                {autoRefresh
                  ? <><PauseCircle className="w-3.5 h-3.5" />自动刷新 {countdown}s</>
                  : <><PlayCircle className="w-3.5 h-3.5" />自动刷新</>}
              </button>
              <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
                <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', refreshing && 'animate-spin')} />
                刷新
              </Button>
              <Button size="sm" onClick={handleCollect} disabled={collecting}>
                {collecting
                  ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  : <Users className="w-3.5 h-3.5 mr-1.5" />}
                采集时间线
              </Button>
              <Button variant="outline" size="sm" disabled={crawling} onClick={async () => {
                setCrawling(true)
                try {
                  const res = await triggerTl1UsersCollect(100)
                  toast.success(res.message || 'tl1 博主抓取已启动，预计需要 30-50 分钟')
                } catch (e) {
                  toast.error(`启动失败：${e}`)
                } finally {
                  setCrawling(false)
                }
              }}>
                {crawling
                  ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  : <TrendingUp className="w-3.5 h-3.5 mr-1.5" />}
                抓取 tl1 博主
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-sm w-fit">
        <button
          onClick={() => setTab('candidates')}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2 transition-colors',
            tab === 'candidates'
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
          )}
        >
          <Users className="w-3.5 h-3.5" />
          博主候选库
          <span className="text-xs opacity-60">{candidates.length}</span>
        </button>
        <button
          onClick={() => setTab('posts')}
          className={cn(
            'flex items-center gap-1.5 px-4 py-2 transition-colors',
            tab === 'posts'
              ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
              : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
          )}
        >
          <TrendingUp className="w-3.5 h-3.5" />
          帖子趋势
          <span className="text-xs opacity-60">{initialPosts.length}</span>
        </button>
      </div>

      {/* Posts panel */}
      {tab === 'posts' && <XPostsPanel initialPosts={initialPosts} />}

      {/* Candidates panel */}
      {tab === 'candidates' && <>

      {/* Filter bar */}
      <div className="flex items-center gap-3">
        <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-sm">
          {(['all', 'candidate', 'following', 'rejected'] as StatusFilter[]).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                'px-3 py-1.5 transition-colors',
                statusFilter === s
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
              )}
            >
              {s === 'all' ? '全部' : STATUS_LABEL[s]}
              <span className="ml-1.5 text-xs opacity-60">{counts[s]}</span>
            </button>
          ))}
        </div>
        <Input
          placeholder="搜索用户名、昵称、简介…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-xs h-8 text-sm"
        />
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-zinc-400">
          <AtSign className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm">暂无候选账户</p>
          <p className="text-xs mt-1">点击「采集时间线」开始发现优质账户</p>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b border-zinc-100 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                <th className="text-left px-4 py-3 w-44 min-w-[176px]">博主</th>
                <th className="text-right px-3 py-3">粉丝</th>
                <th className="text-right px-3 py-3">热帖</th>
                <th className="text-right px-3 py-3">推文</th>
                <th className="text-right px-3 py-3">关注</th>
                <th className="text-right px-3 py-3">给赞</th>
                <th className="text-left px-3 py-3">位置</th>
                <th className="text-left px-3 py-3">加入</th>
                <th className="text-center px-3 py-3">状态</th>
                <th className="text-center px-3 py-3">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {filtered.map(c => (
                <tr
                  key={c.username}
                  className={cn(
                    'hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors',
                    updatingRow === c.username && 'opacity-50 pointer-events-none'
                  )}
                >
                  {/* 博主 — fixed width, truncate */}
                  <td className="px-4 py-2.5 w-44 min-w-[176px] max-w-[176px]">
                    <div className="flex items-center gap-2">
                      <AvatarCell name={c.display_name} username={c.username} />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100 truncate text-xs leading-tight" title={c.display_name}>
                          {c.display_name || c.username}
                        </div>
                        <a
                          href={c.profile_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 flex items-center gap-0.5 truncate"
                        >
                          @{c.username}
                          <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
                        </a>
                      </div>
                    </div>
                  </td>

                  <td className="px-3 py-2.5 text-right text-xs font-semibold text-zinc-800 dark:text-zinc-200">{formatFollowers(c.followers)}</td>
                  <td className="px-3 py-2.5 text-right text-xs text-zinc-600 dark:text-zinc-400">{c.hot_post_count || '—'}</td>
                  <td className="px-3 py-2.5 text-right text-xs text-zinc-600 dark:text-zinc-400">{formatFollowers(c.tweet_count)}</td>
                  <td className="px-3 py-2.5 text-right text-xs text-zinc-600 dark:text-zinc-400">{formatFollowers(c.following_count)}</td>
                  <td className="px-3 py-2.5 text-right text-xs text-zinc-600 dark:text-zinc-400">{formatFollowers(c.favourites_count)}</td>
                  <td className="px-3 py-2.5 text-xs text-zinc-500 dark:text-zinc-400 max-w-[100px] truncate" title={c.location}>{c.location || '—'}</td>
                  <td className="px-3 py-2.5 text-xs text-zinc-400">{c.join_date ? c.join_date.slice(0, 4) : '—'}</td>

                  {/* Status */}
                  <td className="px-3 py-2.5 text-center">
                    <span className={cn(
                      'inline-flex items-center px-2 py-0.5 rounded-full text-xs border',
                      STATUS_STYLE[c.status] ?? STATUS_STYLE.candidate
                    )}>
                      {STATUS_LABEL[c.status] ?? c.status}
                    </span>
                  </td>

                  {/* Actions */}
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-center gap-1">
                      {c.status !== 'following' && (
                        <button onClick={() => handleStatusChange(c.username, 'following')} title="标记为已关注"
                          className="p-1 rounded text-zinc-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950 transition-colors">
                          <CheckCircle className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {c.status !== 'rejected' && (
                        <button onClick={() => handleStatusChange(c.username, 'rejected')} title="忽略"
                          className="p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                          <XCircle className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {c.status !== 'candidate' && (
                        <button onClick={() => handleStatusChange(c.username, 'candidate')} title="重新放入候选"
                          className="p-1 rounded text-zinc-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950 transition-colors">
                          <Clock className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button onClick={() => handleDelete(c.username)} title="删除"
                        className="p-1 rounded text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>}
    </div>
  )
}
