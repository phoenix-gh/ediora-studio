'use client'

import { type ContentJob, type ContentJobStep, type TokenUsageSummary } from '@/lib/api/jobs'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { JobSessionTranscript } from './JobSessionTranscript'

const statusText: Record<string, string> = {
  queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
}

function formatTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function formatTokenCount(value: number | undefined) {
  return value === undefined ? '—' : new Intl.NumberFormat('zh-CN').format(value)
}

function TokenUsageSummaryCard({ usage }: { usage: TokenUsageSummary | null | undefined }) {
  if (!usage) return null
  return <section data-testid="job-token-usage" className="shrink-0 rounded-lg border bg-muted/30 p-3 text-xs">
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

export function JobLogDialog({ job, open, onOpenChange, onRetry }: { job: ContentJob | null; open: boolean; onOpenChange: (open: boolean) => void; onRetry: (jobId: number, stepKey: string) => void }) {
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
            <span className="text-muted-foreground">创建 {formatTime(job.created_at)}</span>
            <span className="text-muted-foreground">开始 {formatTime(job.started_at)}</span>
            <span className="text-muted-foreground">结束 {formatTime(job.completed_at)}</span>
          </div>
          <TokenUsageSummaryCard usage={job.token_usage} />
          {job.steps.some(step => step.error || step.status === 'failed') && <div className="flex shrink-0 flex-col gap-2">
            {job.steps.filter(step => step.error || step.status === 'failed').map(step => (
              <StepRow key={step.id} step={step} onRetry={() => onRetry(job.id, step.key)} />
            ))}
          </div>}
          <JobSessionTranscript jobId={job.id} open={open} />
        </div>
      </div>
    </DialogContent>
  </Dialog>
}
