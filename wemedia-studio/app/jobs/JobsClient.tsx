'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock3, Loader2, RotateCcw, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { cancelJob, ContentJob, listJobs, retryJobStep } from '@/lib/api/jobs'
import { Button } from '@/components/ui/button'

const statusText = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' }
const statusIcon = {
  queued: Clock3, running: Loader2, succeeded: CheckCircle2, failed: AlertTriangle, cancelled: XCircle,
}

export function JobsClient() {
  const [jobs, setJobs] = useState<ContentJob[]>([])
  const [loading, setLoading] = useState(true)

  async function refresh() {
    try { setJobs((await listJobs()).jobs) } catch (error) { toast.error(error instanceof Error ? error.message : '加载任务失败') } finally { setLoading(false) }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh() }, 0)
    return () => window.clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (!jobs.some(job => job.status === 'queued' || job.status === 'running')) return
    const timer = window.setInterval(() => { void refresh() }, 2000)
    return () => window.clearInterval(timer)
  }, [jobs])

  async function retry(jobId: number, stepKey: string) {
    try { await retryJobStep(jobId, stepKey); await refresh() } catch (error) { toast.error(error instanceof Error ? error.message : '重试失败') }
  }
  async function cancel(jobId: number) {
    try { await cancelJob(jobId); await refresh() } catch (error) { toast.error(error instanceof Error ? error.message : '取消失败') }
  }

  return <main className="ml-56 min-h-screen p-8 bg-zinc-50 dark:bg-zinc-950">
    <header className="mb-6"><h1 className="text-2xl font-semibold">创作任务</h1><p className="text-sm text-zinc-500 mt-1">查看生成进度、失败原因和可重试步骤。</p></header>
    {loading ? <div className="flex gap-2 text-sm text-zinc-500"><Loader2 className="w-4 h-4 animate-spin" />加载中</div> : jobs.length === 0 ? <div className="rounded-xl border bg-white p-8 text-sm text-zinc-500">还没有创作任务。</div> : <div className="space-y-3">
      {jobs.map(job => {
        const Icon = statusIcon[job.status]
        return <section key={job.id} className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-4"><div><div className="font-medium">{job.title}</div><div className="mt-1 flex items-center gap-2 text-xs text-zinc-500"><Icon className={job.status === 'running' ? 'w-3.5 h-3.5 animate-spin' : 'w-3.5 h-3.5'} />{statusText[job.status]} · {job.flow} · #{job.id}</div></div>
            {(job.status === 'queued' || job.status === 'running') && <Button variant="outline" size="sm" onClick={() => void cancel(job.id)}>取消</Button>}</div>
          {job.steps.length > 0 && <div className="mt-4 border-t pt-3 space-y-2">{job.steps.map(step => <div key={step.id} className="flex items-center justify-between text-sm"><span>{step.key} <span className="text-xs text-zinc-400">第 {step.attempt} 次</span></span><span className="flex items-center gap-2 text-xs text-zinc-500">{statusText[step.status]}{step.error && `：${step.error}`}{step.status === 'failed' && step.retryable && <Button variant="ghost" size="sm" onClick={() => void retry(job.id, step.key)}><RotateCcw className="w-3 h-3 mr-1" />重试</Button>}</span></div>)}</div>}
          {job.events.length > 0 && <details className="mt-4 border-t pt-3"><summary className="cursor-pointer text-sm font-medium text-zinc-700 dark:text-zinc-200">执行日志 ({job.events.length})</summary><div className="mt-3 space-y-2">{job.events.slice().reverse().map(event => <div key={event.id} className="rounded-md bg-zinc-50 px-3 py-2 text-xs dark:bg-zinc-950"><div className="font-medium text-zinc-700 dark:text-zinc-200">{event.kind}</div><pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-zinc-500">{JSON.stringify(event.payload, null, 2)}</pre></div>)}</div></details>}
        </section>
      })}
    </div>}
  </main>
}
