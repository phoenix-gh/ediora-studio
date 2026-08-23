'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { listJobs, type ContentJob, type JobStatus } from '@/lib/api/jobs'
import { JobLogDialog } from './JobLogDialog'

const PAGE_SIZE = 30

const statusText: Record<string, string> = {
  queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
}

type FilterStatus = 'all' | JobStatus
type Filters = { status: FilterStatus }
type LoadMode = 'initial' | 'refresh' | 'append'

function statusClass(status: string) {
  if (status === 'succeeded') return 'bg-success/10 text-success'
  if (status === 'failed') return 'bg-danger/10 text-danger'
  if (status === 'running') return 'bg-info/10 text-info'
  if (status === 'cancelled') return 'bg-muted text-muted-foreground'
  return 'bg-warning/10 text-warning'
}

function formatTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function mergeJobs(existing: ContentJob[], incoming: ContentJob[]) {
  const byId = new Map(existing.map(job => [job.id, job]))
  incoming.forEach(job => byId.set(job.id, job))
  return Array.from(byId.values()).sort((left, right) => {
    const timeDiff = Date.parse(right.created_at) - Date.parse(left.created_at)
    return timeDiff || right.id - left.id
  })
}

function TaskRow({ job, onOpen, onCancel }: { job: ContentJob; onOpen: () => void; onCancel: () => void }) {
  const latestStep = job.steps[job.steps.length - 1]
  return <article className="border-b p-4 last:border-b-0">
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{job.title}</h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">固定任务</span>
          {job.schedule && <span className="rounded-full bg-ai-subtle px-2 py-0.5 text-[11px] text-ai-foreground">{job.schedule.rule_name}</span>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Job #{job.id} · 创建于 {formatTime(job.created_at)}
          {job.schedule ? ` · 计划 ${formatTime(job.schedule.scheduled_for)}` : ''}
        </p>
        {latestStep && <p className="mt-1 text-xs text-muted-foreground">
          当前步骤：{latestStep.key} · {statusText[latestStep.status] ?? latestStep.status}
          {latestStep.error ? ` · ${latestStep.error}` : ''}
        </p>}
      </div>
      <span className={`rounded-full px-2 py-1 text-xs ${statusClass(job.status)}`}>
        {statusText[job.status] ?? job.status}
      </span>
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={onOpen}>查看日志</Button>
      {(job.status === 'queued' || job.status === 'running') && <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>}
    </div>
  </article>
}

export function TaskLogList({ refreshToken, onRetry, onCancel }: {
  refreshToken: number
  onRetry: (jobId: number, stepKey: string) => void
  onCancel: (jobId: number) => void
}) {
  const [filters, setFilters] = useState<Filters>({ status: 'all' })
  const [jobs, setJobs] = useState<ContentJob[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [initialLoading, setInitialLoading] = useState(true)
  const [appendLoading, setAppendLoading] = useState(false)
  const [initialError, setInitialError] = useState('')
  const [appendError, setAppendError] = useState('')
  const [refreshError, setRefreshError] = useState('')
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null)
  const requestIdRef = useRef(0)
  const appendInFlightRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)

  const loadPage = useCallback(async (currentFilters: Filters, cursor: string | null, mode: LoadMode) => {
    const requestId = ++requestIdRef.current
    if (mode === 'append') setAppendLoading(true)
    try {
      const options: { limit: number; cursor?: string; kind: 'scheduled'; status?: JobStatus } = {
        limit: PAGE_SIZE,
        kind: 'scheduled',
      }
      if (cursor) options.cursor = cursor
      if (currentFilters.status !== 'all') options.status = currentFilters.status
      const page = await listJobs(options)
      if (requestId !== requestIdRef.current) return
      setJobs(existing => mode === 'initial' ? page.jobs : mergeJobs(existing, page.jobs))
      setNextCursor(page.next_cursor)
      setHasMore(page.has_more)
      setInitialError('')
      setAppendError('')
      setRefreshError('')
    } catch (error) {
      if (requestId !== requestIdRef.current) return
      const message = error instanceof Error ? error.message : '任务日志加载失败'
      if (mode === 'append') setAppendError(message)
      else if (mode === 'refresh') setRefreshError(message)
      else setInitialError(message)
    } finally {
      if (requestId !== requestIdRef.current) return
      if (mode !== 'append') setInitialLoading(false)
      if (mode === 'append') setAppendLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPage(filters, null, jobs.length === 0 ? 'initial' : 'refresh')
    }, 0)
    return () => window.clearTimeout(timer)
    // The refresh token intentionally reloads only the first page and merges it.
    // Filter changes clear jobs in changeFilters before this effect runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, refreshToken, loadPage])

  const hasActiveJobs = jobs.some(job => job.status === 'queued' || job.status === 'running')
  useEffect(() => {
    if (!hasActiveJobs) return
    const timer = window.setInterval(() => {
      void loadPage(filters, null, 'refresh')
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [filters, hasActiveJobs, loadPage])

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || appendInFlightRef.current) return
    appendInFlightRef.current = true
    try {
      await loadPage(filters, nextCursor, 'append')
    } finally {
      appendInFlightRef.current = false
    }
  }, [filters, hasMore, loadPage, nextCursor])

  useEffect(() => {
    const root = scrollRef.current
    const sentinel = sentinelRef.current
    if (!root || !sentinel || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore()
    }, { root, rootMargin: '160px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMore])

  function changeFilters(next: Filters) {
    setFilters(next)
    setJobs([])
    setNextCursor(null)
    setHasMore(true)
    setInitialLoading(true)
    setInitialError('')
    setAppendError('')
    setRefreshError('')
    setSelectedJobId(null)
  }

  const selectedJob = jobs.find(job => job.id === selectedJobId) ?? null

  return <section aria-label="任务日志" className="space-y-3">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="font-semibold">任务日志</h2>
        <p className="text-xs text-muted-foreground">查看定时与手动执行的固定创作规则；滚动列表加载更多历史记录。</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="task-log-status">任务状态</label>
        <NativeSelect id="task-log-status" aria-label="任务状态" className="w-auto rounded-md px-2" value={filters.status} onChange={event => changeFilters({ ...filters, status: event.target.value as FilterStatus })}>
          <option value="all">全部状态</option>
          <option value="queued">排队中</option>
          <option value="running">执行中</option>
          <option value="succeeded">已完成</option>
          <option value="failed">失败</option>
          <option value="cancelled">已取消</option>
        </NativeSelect>
      </div>
    </div>
    {refreshError && <p className="text-xs text-warning">状态刷新失败：{refreshError}</p>}
    <div ref={scrollRef} data-testid="task-log-scroll" className="max-h-[min(70vh,720px)] overflow-y-auto rounded-xl border bg-card">
      {initialLoading && jobs.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">任务日志加载中…</p>}
      {!initialLoading && initialError && jobs.length === 0 && <div className="space-y-3 p-8 text-center text-sm"><p className="text-danger">{initialError}</p><Button variant="outline" size="sm" onClick={() => { setInitialLoading(true); void loadPage(filters, null, 'initial') }}>重新加载</Button></div>}
      {!initialLoading && !initialError && jobs.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">没有符合条件的任务</p>}
      {jobs.map(job => <TaskRow key={job.id} job={job} onOpen={() => setSelectedJobId(job.id)} onCancel={() => onCancel(job.id)} />)}
      {appendLoading && <p className="p-4 text-center text-xs text-muted-foreground">正在加载更多…</p>}
      {appendError && <div className="space-y-2 p-4 text-center text-xs"><p className="text-danger">{appendError}</p><Button variant="outline" size="sm" onClick={() => { void loadMore() }}>重试加载</Button></div>}
      {!appendLoading && !appendError && hasMore && jobs.length > 0 && <div className="p-3 text-center"><Button variant="ghost" size="sm" onClick={() => { void loadMore() }}>加载更多</Button></div>}
      {!hasMore && jobs.length > 0 && <p className="p-3 text-center text-xs text-muted-foreground">已加载全部任务</p>}
      <div ref={sentinelRef} aria-hidden="true" className="h-1" />
    </div>
    <JobLogDialog job={selectedJob} open={selectedJob !== null} onOpenChange={open => { if (!open) setSelectedJobId(null) }} onRetry={onRetry} />
  </section>
}
