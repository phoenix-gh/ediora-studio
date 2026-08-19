'use client'

import { useEffect, useState } from 'react'
import { getJobAgentLog, type ContentJob, type ContentJobStep } from '@/lib/api/jobs'
import { listAllAgentLogEvents, type AgentLogEvent } from '@/lib/ai/agent-log-client'
import type { DailyCreationAgentLog } from '@/lib/api/creation-rules'
import { AgentLogTimeline } from '@/components/features/agent/AgentLogTimeline'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AgentMessageTimeline } from './CreationRunLog'

const statusText: Record<string, string> = {
  queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
}

function formatTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function StepRow({ step, onRetry }: { step: ContentJobStep; onRetry: () => void }) {
  return <div className="rounded-lg border bg-background p-3">
    <div className="flex flex-wrap items-center gap-2">
      <code>{step.key}</code>
      <span className="text-muted-foreground">第 {step.attempt} 次</span>
      <span className="rounded-full bg-muted px-2 py-0.5">{statusText[step.status] ?? step.status}</span>
      {step.status === 'failed' && step.retryable && <Button variant="outline" size="sm" onClick={onRetry}>重试</Button>}
    </div>
    {step.error && <p className="mt-2 text-danger">{step.error}</p>}
    <p className="mt-2 text-xs text-muted-foreground">开始：{formatTime(step.started_at)} · 结束：{formatTime(step.completed_at)}</p>
  </div>
}

export function JobLogDialog({ job, open, onOpenChange, onRetry }: { job: ContentJob | null; open: boolean; onOpenChange: (open: boolean) => void; onRetry: (jobId: number, stepKey: string) => void }) {
  const jobId = job?.id
  const [agentLogState, setAgentLogState] = useState<{ jobId: number; log: DailyCreationAgentLog | null; events: AgentLogEvent[]; error: string }>({
    jobId: -1,
    log: null,
    events: [],
    error: '',
  })

  useEffect(() => {
    if (!open || jobId == null) return
    let active = true
    void Promise.allSettled([
      getJobAgentLog(jobId),
      listAllAgentLogEvents({ job_id: jobId, limit: 500 }),
    ]).then(([legacyResult, unifiedResult]) => {
      if (!active) return
      const log = legacyResult.status === 'fulfilled' ? legacyResult.value : null
      const events = unifiedResult.status === 'fulfilled' ? unifiedResult.value.events : []
      const error = legacyResult.status === 'rejected' && unifiedResult.status === 'rejected'
        ? (legacyResult.reason instanceof Error ? legacyResult.reason.message : '完整消息加载失败')
        : ''
      setAgentLogState({ jobId, log, events, error })
    })
    return () => { active = false }
  }, [jobId, open])

  if (!job) return null
  const hasCurrentAgentLog = agentLogState.jobId === job.id
  const hasUnifiedEvents = hasCurrentAgentLog && agentLogState.events.length > 0
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="lg" className="max-h-[85vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>任务日志 · #{job.id}</DialogTitle>
        <DialogDescription>{job.title} · {job.flow} · {statusText[job.status] ?? job.status}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <div className="grid gap-2 rounded-lg bg-muted/40 p-3 text-xs sm:grid-cols-3">
          <span>创建：{formatTime(job.created_at)}</span>
          <span>开始：{formatTime(job.started_at)}</span>
          <span>结束：{formatTime(job.completed_at)}</span>
        </div>
        <section className="space-y-2">
          <h3 className="font-medium">执行步骤</h3>
          {job.steps.length === 0 && <p className="text-sm text-muted-foreground">暂无步骤记录</p>}
          {job.steps.map(step => <StepRow key={step.id} step={step} onRetry={() => onRetry(job.id, step.key)} />)}
        </section>
        <section className="space-y-2">
          <h3 className="font-medium">执行事件</h3>
          {job.events.length === 0 && <p className="text-sm text-muted-foreground">暂无事件记录</p>}
          {job.events.slice().reverse().map(event => <div key={event.id} className="rounded-lg bg-muted/40 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2"><code>{event.kind}</code><span className="text-muted-foreground">{formatTime(event.created_at)}</span></div>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{JSON.stringify(event.payload, null, 2)}</pre>
          </div>)}
        </section>
        {hasUnifiedEvents ? <AgentLogTimeline
          events={agentLogState.events}
          loading={false}
          error={agentLogState.error}
        /> : <AgentMessageTimeline
          log={hasCurrentAgentLog ? agentLogState.log : null}
          loading={!hasCurrentAgentLog}
          error={hasCurrentAgentLog ? agentLogState.error : ''}
        />}
      </div>
    </DialogContent>
  </Dialog>
}
