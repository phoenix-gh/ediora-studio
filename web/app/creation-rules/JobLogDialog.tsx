'use client'

import { type ContentJob, type ContentJobStep, type TokenUsageSummary } from '@/lib/api/jobs'
import { AgentTrajectoryPanel } from '@/components/features/agent/AgentTrajectoryPanel'
import { useDeveloperMode } from '@/components/providers/DeveloperModeProvider'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const statusText: Record<string, string> = {
  queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
}

type JobLogTab = 'overview' | 'events' | 'agent'

function formatTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function jsonText(value: unknown) {
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}

function formatTokenCount(value: number | undefined) {
  return value === undefined ? '—' : new Intl.NumberFormat('zh-CN').format(value)
}

function TokenUsageSummaryCard({ usage }: { usage: TokenUsageSummary | null | undefined }) {
  if (!usage) return null
  return <section data-testid="job-token-usage" className="rounded-lg border bg-muted/30 p-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-medium">Token 消耗</h3>
      <span className="text-muted-foreground">{usage.request_count} 次模型请求</span>
    </div>
    <div className="mt-2 grid gap-2 sm:grid-cols-3">
      <span>输入 {formatTokenCount(usage.input_tokens)}</span>
      <span>输出 {formatTokenCount(usage.output_tokens)}</span>
      <span>总计 {formatTokenCount(usage.total_tokens)}</span>
    </div>
    {(usage.reasoning_tokens !== undefined || usage.cached_input_tokens !== undefined) && <p className="mt-2 text-muted-foreground">
      {usage.reasoning_tokens !== undefined && `推理 ${formatTokenCount(usage.reasoning_tokens)}`}
      {usage.reasoning_tokens !== undefined && usage.cached_input_tokens !== undefined && ' · '}
      {usage.cached_input_tokens !== undefined && `缓存输入 ${formatTokenCount(usage.cached_input_tokens)}`}
    </p>}
  </section>
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
      <h3 className="font-medium">执行时间线</h3>
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
  const developerModeEnabled = useDeveloperMode()
  const defaultTab: JobLogTab = 'overview'

  if (!job) return null

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen)
  }

  return <Dialog open={open} onOpenChange={handleOpenChange}>
    <DialogContent
      size="lg"
      className="flex h-[min(720px,calc(100dvh-2rem))] min-h-[min(520px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
    >
      <DialogHeader className="shrink-0">
        <DialogTitle>任务日志 · #{job.id}</DialogTitle>
        <DialogDescription>{job.title} · {job.flow} · {statusText[job.status] ?? job.status}</DialogDescription>
      </DialogHeader>
      <div data-testid="job-log-dialog-body" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-xs">
            <span className="font-medium">Job #{job.id}</span>
            <span className="rounded-full bg-muted px-2 py-0.5">{statusText[job.status] ?? job.status}</span>
            <span className="text-muted-foreground">步骤 {job.steps.length}</span>
            {developerModeEnabled && <span className="text-muted-foreground">Agent 轨迹</span>}
          </div>
          <Tabs
            key={`${job.id}-${open ? 'open' : 'closed'}-${developerModeEnabled}`}
            defaultValue={defaultTab}
            className="min-h-0 flex-1"
          >
            <TabsList className="w-full shrink-0 justify-start overflow-x-auto" variant="line">
              <TabsTrigger value="overview">任务概览</TabsTrigger>
              {developerModeEnabled && <TabsTrigger value="events">执行时间线</TabsTrigger>}
              {developerModeEnabled && <TabsTrigger value="agent">Agent 运行轨迹</TabsTrigger>}
            </TabsList>
            <TabsContent data-testid="job-log-overview-panel" value="overview" className="min-h-0 flex-1 overflow-y-auto pr-1">
              <section className="flex flex-col gap-3">
                <div className="grid gap-2 rounded-lg bg-muted/40 p-3 text-xs sm:grid-cols-3">
                  <span>创建：{formatTime(job.created_at)}</span>
                  <span>开始：{formatTime(job.started_at)}</span>
                  <span>结束：{formatTime(job.completed_at)}</span>
                </div>
                <TokenUsageSummaryCard usage={job.token_usage} />
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
            {developerModeEnabled && <TabsContent value="events" className="min-h-0 flex-1 overflow-y-auto pr-1">
              <ExecutionEvents events={job.events} />
            </TabsContent>}
            {developerModeEnabled && <TabsContent keepMounted data-testid="job-log-agent-panel" value="agent" className="min-h-0 flex-1 overflow-hidden pr-1">
              <AgentTrajectoryPanel scope={{ job_id: job.id }} open={open} developerModeEnabled />
            </TabsContent>}
          </Tabs>
        </div>
      </div>
    </DialogContent>
  </Dialog>
}
