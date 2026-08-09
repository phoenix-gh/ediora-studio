'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { getCreationRunAgentLog, type CreationDashboardRun, type CreationSchedulerLog, type DailyCreationAgentLog } from '@/lib/api/creation-rules'
import { summarizeDirectories } from './directory-summary'

function formatTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function statusLabel(status: string) {
  return ({ queued: '排队中', running: '执行中', succeeded: '成功', partial: '部分完成', failed: '失败', cancelled: '已取消' } as Record<string, string>)[status] ?? status
}

function statusClass(status: string) {
  if (status === 'succeeded') return 'bg-emerald-100 text-emerald-700'
  if (status === 'failed') return 'bg-red-100 text-red-700'
  if (status === 'partial') return 'bg-amber-100 text-amber-700'
  if (status === 'running') return 'bg-blue-100 text-blue-700'
  return 'bg-muted text-muted-foreground'
}

function jsonText(value: unknown) {
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}

function messageLabel(direction: string) {
  return ({
    model_request: 'AI → 模型',
    model_response: '模型 → AI',
    model_error: '模型错误',
  } as Record<string, string>)[direction] ?? direction
}

export function AgentMessageTimeline({ log, loading, error }: { log: DailyCreationAgentLog | null; loading: boolean; error: string }) {
  return <section className="space-y-2 rounded-lg border bg-background p-3">
    <div>
      <h3 className="font-medium">AI 完整消息</h3>
      <p className="text-muted-foreground">包含模型请求、模型响应、Skill 阶段和错误；敏感字段已脱敏。</p>
    </div>
    {loading && <p className="text-muted-foreground">完整消息加载中…</p>}
    {error && <p className="text-red-600">{error}</p>}
    {!loading && !error && log && <>
      {log.execution?.objective && <details className="rounded border bg-muted/30 p-2">
        <summary className="cursor-pointer font-medium">任务目标</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{log.execution.objective}</pre>
      </details>}
      {log.messages.length === 0 && <p className="text-muted-foreground">暂无模型消息记录（可能是旧任务）。</p>}
      <div className="space-y-2">
        {log.messages.map(message => <details key={message.id} className="rounded border bg-muted/30 p-2">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2">
            <span className="font-medium">{messageLabel(message.direction)}</span>
            <code>{message.phase}</code>
            <span className="text-muted-foreground">{formatTime(message.created_at)}</span>
          </summary>
          <pre className="mt-2 max-h-[30rem] overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{jsonText(message.payload)}</pre>
        </details>)}
      </div>
      {log.tools.length > 0 && <details className="rounded border bg-muted/30 p-2">
        <summary className="cursor-pointer font-medium">工具完整记录（{log.tools.length}）</summary>
        <div className="mt-2 space-y-2">
          {log.tools.map(tool => <details key={tool.id} className="rounded border bg-background p-2">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2">
              <code>{tool.tool_name}</code><span>{tool.status}</span><span className="text-muted-foreground">{formatTime(tool.started_at)}</span>
            </summary>
            <pre className="mt-2 max-h-[30rem] overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{jsonText({ input: tool.input_summary, output: tool.output, error: tool.error })}</pre>
          </details>)}
        </div>
      </details>}
    </>}
  </section>
}

function RunDetail({ run, schedulerLogs, agentLog, agentLogLoading, agentLogError }: { run: CreationDashboardRun; schedulerLogs: CreationSchedulerLog[]; agentLog: DailyCreationAgentLog | null; agentLogLoading: boolean; agentLogError: string }) {
  const detail = run.detail
  const outputs = Array.isArray(detail.outputs) ? detail.outputs as Array<{ draft_id?: number }> : []
  const job = run.job
  const agent = run.agent_execution
  return <div className="mt-3 space-y-3 border-t pt-3 text-xs">
    {job && <div>
      <p className="mb-2 font-medium">Job 步骤</p>
      <div className="space-y-1.5">
        {job.steps.length === 0 && <p className="text-muted-foreground">还没有步骤记录</p>}
        {job.steps.map(step => <div key={`${step.key}-${step.attempt}`} className="rounded-lg border bg-background p-2">
          <div className="flex flex-wrap items-center gap-2">
            <code>{step.key}</code><span>第 {step.attempt} 次</span><span className={`rounded-full px-2 py-0.5 ${statusClass(step.status)}`}>{statusLabel(step.status)}</span>
          </div>
          {step.error && <p className="mt-1 text-red-600">{step.error}</p>}
        </div>)}
      </div>
      {job.events.length > 0 && <div className="mt-3 space-y-1">
        <p className="font-medium">Job 事件</p>
        {job.events.slice(0, 5).map((event, index) => <p key={`${event.kind}-${event.created_at}-${index}`} className="text-muted-foreground"><code>{event.kind}</code> · {formatTime(event.created_at)} · {JSON.stringify(event.payload)}</p>)}
      </div>}
    </div>}
    {agent && <div className="rounded-lg bg-muted/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Agent · {statusLabel(agent.status)} · {agent.phase}</span>
        {agent.skill_name && <span className="rounded-md border bg-background px-2 py-1">{agent.skill_name}</span>}
      </div>
      {agent.tools.length > 0 && <div className="mt-2 space-y-1.5">
        <p className="font-medium">工具调用摘要</p>
        {agent.tools.map((tool, index) => <div key={`${tool.tool_name}-${tool.occurred_at}-${index}`} className="rounded border bg-background p-2">
          <div className="flex flex-wrap items-center gap-2"><code>{tool.tool_name}</code><span className="text-muted-foreground">{statusLabel(tool.status)}</span>{tool.auto_approved && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">自动批准</span>}</div>
          {tool.error && <p className="mt-1 text-red-600">{tool.error}</p>}
        </div>)}
      </div>}
      {typeof agent.self_validation.summary === 'string' && agent.self_validation.summary && <p className="mt-2">自检：{agent.self_validation.summary}</p>}
    </div>}
    {run.content_job_id && <AgentMessageTimeline log={agentLog} loading={agentLogLoading} error={agentLogError} />}
    {outputs.length > 0 && <p className="text-emerald-700">已记录 {outputs.length} 条产出</p>}
    {run.status === 'failed' && !job && <p className="text-red-600">任务失败，但没有找到关联 Job 记录。</p>}
    {schedulerLogs.length > 0 && <section className="space-y-2">
      <h3 className="font-medium">调度日志</h3>
      <div className="space-y-2">{schedulerLogs.map((log, index) => <div key={`${log.created_at}-${index}`} className="flex flex-wrap gap-x-3 gap-y-1 rounded-lg bg-muted/40 p-3">
        <span className={`rounded-full px-2 py-0.5 ${log.status === 'error' ? 'bg-red-100 text-red-700' : 'bg-muted text-muted-foreground'}`}>{log.status}</span>
        <span>{log.message}</span>
        <span className="text-muted-foreground">{formatTime(log.created_at)}</span>
        {log.detail && <span className="text-red-600">{log.detail}</span>}
      </div>)}</div>
    </section>}
  </div>
}

export function CreationRunLog({ runs, schedulerLogs }: { runs: CreationDashboardRun[]; schedulerLogs: CreationSchedulerLog[] }) {
  const [selectedRun, setSelectedRun] = useState<CreationDashboardRun | null>(null)
  const [agentLog, setAgentLog] = useState<DailyCreationAgentLog | null>(null)
  const [agentLogLoading, setAgentLogLoading] = useState(false)
  const [agentLogError, setAgentLogError] = useState('')

  async function openRun(run: CreationDashboardRun) {
    setSelectedRun(run)
    setAgentLog(null)
    setAgentLogError('')
    if (!run.content_job_id) return
    setAgentLogLoading(true)
    try {
      setAgentLog(await getCreationRunAgentLog(run.id))
    } catch (error) {
      setAgentLogError(error instanceof Error ? error.message : '完整消息加载失败')
    } finally {
      setAgentLogLoading(false)
    }
  }

  return <section className="space-y-3">
    <div>
      <h2 className="font-semibold">运行日志</h2>
      <p className="text-xs text-muted-foreground">查看定时 Job、失败步骤和 AI 工具调用摘要。</p>
    </div>
    <div className="space-y-2">
      {runs.length === 0 && <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">今天还没有规则任务</div>}
      {runs.map(run => <article key={run.id} className="rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1"><h3 className="font-medium">{String(run.rule.name ?? `规则 #${run.rule_id}`)}</h3><p className="text-xs text-muted-foreground">{summarizeDirectories(run.rule.directories ?? [], String(run.rule.directory ?? ''))} · 计划 {formatTime(run.scheduled_for)} · <span>Job #{run.content_job_id ?? '—'}</span></p></div>
          <span className="text-sm font-medium">{run.created_count} / {run.requested_count}</span>
          <span className={`rounded-full px-2 py-1 text-xs ${statusClass(run.status)}`}>{statusLabel(run.status)}</span>
        </div>
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => { void openRun(run) }}>查看日志</Button>
        </div>
      </article>)}
    </div>
    <Dialog open={selectedRun !== null} onOpenChange={open => { if (!open) setSelectedRun(null) }}>
      {selectedRun && <DialogContent size="lg" className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>运行日志 · #{selectedRun.id}</DialogTitle>
          <DialogDescription>{String(selectedRun.rule.name ?? `规则 #${selectedRun.rule_id}`)} · Job #{selectedRun.content_job_id ?? '—'} · {statusLabel(selectedRun.status)}</DialogDescription>
        </DialogHeader>
        <RunDetail run={selectedRun} schedulerLogs={schedulerLogs} agentLog={agentLog} agentLogLoading={agentLogLoading} agentLogError={agentLogError} />
      </DialogContent>}
    </Dialog>
  </section>
}
