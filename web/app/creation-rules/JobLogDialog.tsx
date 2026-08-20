'use client'

import { useEffect, useState } from 'react'
import { getJobAgentLog, type ContentJob, type ContentJobStep } from '@/lib/api/jobs'
import { listAllAgentLogEvents, type AgentLogEvent } from '@/lib/ai/agent-log-client'
import type { DailyCreationAgentLog } from '@/lib/api/creation-rules'
import { AgentLogTimeline } from '@/components/features/agent/AgentLogTimeline'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { isDeveloperModeEnabled } from '@/lib/developer-mode'
import { AgentMessageTimeline } from './CreationRunLog'

const statusText: Record<string, string> = {
  queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
}

type JobLogTab = 'agent' | 'overview' | 'messages' | 'events'

type AgentEventState = {
  jobId: number
  events: AgentLogEvent[]
  loading: boolean
  error: string
}

type LegacyLogState = {
  jobId: number
  log: DailyCreationAgentLog | null
  loading: boolean
  error: string
}

function formatTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function jsonText(value: unknown) {
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}

function errorText(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback
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

function ExecutionEvents({ events }: { events: ContentJob['events'] }) {
  return <section className="flex flex-col gap-2">
    <div>
      <h3 className="font-medium">执行事件</h3>
      <p className="text-xs text-muted-foreground">Job 状态事件默认折叠；需要排查调度和步骤细节时再展开 payload。</p>
    </div>
    {events.length === 0 && <p className="text-sm text-muted-foreground">暂无事件记录</p>}
    {events.length > 0 && <div className="flex flex-col gap-2">
      {events.slice().reverse().map(event => <details key={event.id} className="rounded-lg border bg-muted/20 p-3">
        <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-xs">
          <code>{event.kind}</code>
          <span className="flex-1 text-muted-foreground">{formatTime(event.created_at)}</span>
          <span className="text-muted-foreground">展开 payload</span>
        </summary>
        <pre className="mt-2 max-h-[30rem] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">{jsonText(event.payload)}</pre>
      </details>)}
    </div>}
  </section>
}

export function JobLogDialog({ job, open, onOpenChange, onRetry }: { job: ContentJob | null; open: boolean; onOpenChange: (open: boolean) => void; onRetry: (jobId: number, stepKey: string) => void }) {
  const developerModeEnabled = isDeveloperModeEnabled()
  const jobId = job?.id
  const defaultTab: JobLogTab = developerModeEnabled ? 'agent' : 'overview'
  const [activeTab, setActiveTab] = useState<JobLogTab>(defaultTab)
  const [agentEventState, setAgentEventState] = useState<AgentEventState>({
    jobId: -1,
    events: [],
    loading: false,
    error: '',
  })
  const [legacyLogState, setLegacyLogState] = useState<LegacyLogState>({
    jobId: -1,
    log: null,
    loading: false,
    error: '',
  })

  useEffect(() => {
    if (!open || jobId == null || !developerModeEnabled) return
    let active = true
    void (async () => {
      await Promise.resolve()
      if (!active) return
      setAgentEventState({ jobId, events: [], loading: true, error: '' })
      try {
        const page = await listAllAgentLogEvents({ job_id: jobId, limit: 500 })
        if (active) setAgentEventState({ jobId, events: page.events, loading: false, error: '' })
      } catch (reason) {
        if (active) setAgentEventState({ jobId, events: [], loading: false, error: errorText(reason, '运行轨迹加载失败') })
      }
    })()
    return () => { active = false }
  }, [developerModeEnabled, jobId, open])

  useEffect(() => {
    if (!open || jobId == null || !developerModeEnabled || activeTab !== 'messages') return
    let active = true
    void (async () => {
      await Promise.resolve()
      if (!active) return
      setLegacyLogState({ jobId, log: null, loading: true, error: '' })
      try {
        const log = await getJobAgentLog(jobId)
        if (active) setLegacyLogState({ jobId, log, loading: false, error: '' })
      } catch (reason) {
        if (active) setLegacyLogState({ jobId, log: null, loading: false, error: errorText(reason, '完整消息加载失败') })
      }
    })()
    return () => { active = false }
  }, [activeTab, developerModeEnabled, jobId, open])

  if (!job) return null

  const hasCurrentEvents = agentEventState.jobId === job.id
  const hasCurrentLegacyLog = legacyLogState.jobId === job.id

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) setActiveTab(defaultTab)
    onOpenChange(nextOpen)
  }

  return <Dialog open={open} onOpenChange={handleOpenChange}>
    <DialogContent size="lg" className="max-h-[90vh] overflow-hidden">
      <DialogHeader>
        <DialogTitle>任务日志 · #{job.id}</DialogTitle>
        <DialogDescription>{job.title} · {job.flow} · {statusText[job.status] ?? job.status}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto pr-1">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-xs">
            <span className="font-medium">Job #{job.id}</span>
            <span className="rounded-full bg-muted px-2 py-0.5">{statusText[job.status] ?? job.status}</span>
            <span className="text-muted-foreground">步骤 {job.steps.length}</span>
            {developerModeEnabled && <span className="text-muted-foreground">Agent 事件 {hasCurrentEvents ? agentEventState.events.length : '—'}</span>}
          </div>
          <Tabs
            key={`${job.id}-${open ? 'open' : 'closed'}-${developerModeEnabled}`}
            defaultValue={defaultTab}
            onValueChange={value => setActiveTab(value as JobLogTab)}
            className="min-h-0"
          >
            <TabsList className="w-full justify-start overflow-x-auto" variant="line">
              {developerModeEnabled && <TabsTrigger value="agent">Agent 运行轨迹</TabsTrigger>}
              <TabsTrigger value="overview">任务概览</TabsTrigger>
              {developerModeEnabled && <TabsTrigger value="messages">AI 完整消息</TabsTrigger>}
              {developerModeEnabled && <TabsTrigger value="events">执行事件</TabsTrigger>}
            </TabsList>
            {developerModeEnabled && <TabsContent value="agent" className="min-h-0">
              <AgentLogTimeline
                events={hasCurrentEvents ? agentEventState.events : []}
                loading={!hasCurrentEvents || agentEventState.loading}
                error={hasCurrentEvents ? agentEventState.error : ''}
              />
            </TabsContent>}
            <TabsContent value="overview" className="min-h-0">
              <section className="flex flex-col gap-3">
                <div className="grid gap-2 rounded-lg bg-muted/40 p-3 text-xs sm:grid-cols-3">
                  <span>创建：{formatTime(job.created_at)}</span>
                  <span>开始：{formatTime(job.started_at)}</span>
                  <span>结束：{formatTime(job.completed_at)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-medium">执行步骤</h3>
                  <span className="text-xs text-muted-foreground">{job.steps.length} 个步骤</span>
                </div>
                {job.steps.length === 0 && <p className="text-sm text-muted-foreground">暂无步骤记录</p>}
                {job.steps.length > 0 && <div className="flex flex-col gap-2">
                  {job.steps.map(step => <StepRow key={step.id} step={step} onRetry={() => onRetry(job.id, step.key)} />)}
                </div>}
              </section>
            </TabsContent>
            {developerModeEnabled && <TabsContent value="messages" className="min-h-0">
              <AgentMessageTimeline
                log={hasCurrentLegacyLog ? legacyLogState.log : null}
                loading={!hasCurrentLegacyLog || legacyLogState.loading}
                error={hasCurrentLegacyLog ? legacyLogState.error : ''}
              />
            </TabsContent>}
            {developerModeEnabled && <TabsContent value="events" className="min-h-0">
              <ExecutionEvents events={job.events} />
            </TabsContent>}
          </Tabs>
        </div>
      </div>
    </DialogContent>
  </Dialog>
}
