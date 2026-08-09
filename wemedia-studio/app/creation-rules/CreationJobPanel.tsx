'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { ContentJob } from '@/lib/api/jobs'
import { JobLogDialog } from './JobLogDialog'

const statusText: Record<string, string> = {
  queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
}

function statusClass(status: string) {
  if (status === 'succeeded') return 'bg-success/10 text-success'
  if (status === 'failed') return 'bg-danger/10 text-danger'
  if (status === 'running') return 'bg-info/10 text-info'
  return 'bg-muted text-muted-foreground'
}

function formatTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

export function CreationJobPanel({ jobs, onRetry, onCancel }: { jobs: ContentJob[]; onRetry: (jobId: number, stepKey: string) => void; onCancel: (jobId: number) => void }) {
  const [selectedJobId, setSelectedJobId] = useState<number | null>(null)
  const selectedJob = jobs.find(job => job.id === selectedJobId) ?? null
  return <section className="space-y-3">
    <div>
      <h2 className="font-semibold">全部任务</h2>
      <p className="text-xs text-muted-foreground">统一查看手动创作、定时创作和其他后台 Job。</p>
    </div>
    <div className="space-y-2">
      {jobs.length === 0 && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">还没有后台任务</div>}
      {jobs.map(job => {
        const latestStep = job.steps[job.steps.length - 1]
        return <article key={job.id} className="rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="font-medium">{job.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{job.flow} · Job #{job.id} · 创建于 {formatTime(job.created_at)}</p>
              {latestStep && <p className="mt-1 text-xs text-muted-foreground">当前步骤：{latestStep.key} · {statusText[latestStep.status] ?? latestStep.status}{latestStep.error ? ` · ${latestStep.error}` : ''}</p>}
            </div>
            <span className={`rounded-full px-2 py-1 text-xs ${statusClass(job.status)}`}>{statusText[job.status] ?? job.status}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedJobId(job.id)}>查看日志</Button>
            {(job.status === 'queued' || job.status === 'running') && <Button variant="ghost" size="sm" onClick={() => onCancel(job.id)}>取消</Button>}
          </div>
        </article>
      })}
    </div>
    <JobLogDialog job={selectedJob} open={selectedJob !== null} onOpenChange={open => { if (!open) setSelectedJobId(null) }} onRetry={onRetry} />
  </section>
}
