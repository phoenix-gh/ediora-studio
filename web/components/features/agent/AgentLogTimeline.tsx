'use client'

import { memo } from 'react'
import { ChevronDown, CircleAlert, CircleCheck, CircleDot, Clock3, Cpu, Wrench } from 'lucide-react'

import type { AgentLogEvent } from '@/lib/ai/agent-log-client'
import { cn } from '@/lib/utils'

const eventLabels: Record<string, string> = {
  'session/turn-start': '开始会话',
  'session/turn-end': '结束会话',
  'session/user-message': '用户消息',
  'session/assistant-message': '助手消息',
  'session/capabilities': '能力快照',
  'session/error': '会话错误',
  'skill/selected': 'Skill 选择',
  'skill/reference': 'Skill 引用',
  'llm/request': 'LLM 请求',
  'llm/response': 'LLM 响应',
  'llm/error': 'LLM 错误',
  'tool/call': '工具调用',
  'tool/approval': '工具审批',
  'tool/result': '工具结果',
  'execution/start': 'Agent 开始',
  'execution/checkpoint': '执行检查点',
  'execution/complete': 'Agent 完成',
  'execution/error': 'Agent 错误',
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function jsonText(value: unknown) {
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}

function statusLabel(status: string) {
  return ({
    running: '进行中', completed: '完成', error: '错误', failed: '失败',
    uncertain: '结果未知', approved: '已批准', rejected: '已拒绝',
    waiting_approval: '等待审批', aborted: '已中止', skipped: '跳过', info: '记录',
  } as Record<string, string>)[status] ?? status
}

function statusClass(status: string) {
  if (['completed', 'approved'].includes(status)) return 'text-success'
  if (['error', 'failed', 'uncertain', 'rejected'].includes(status)) return 'text-danger'
  if (['running', 'waiting_approval'].includes(status)) return 'text-info'
  return 'text-muted-foreground'
}

function EventIcon({ event }: { event: AgentLogEvent }) {
  if (event.event_type.startsWith('llm/')) return <Cpu className="h-3.5 w-3.5" />
  if (event.event_type.startsWith('tool/')) return <Wrench className="h-3.5 w-3.5" />
  if (event.status === 'error' || event.status === 'failed') return <CircleAlert className="h-3.5 w-3.5" />
  if (event.status === 'completed') return <CircleCheck className="h-3.5 w-3.5" />
  if (event.event_type.startsWith('execution/')) return <Clock3 className="h-3.5 w-3.5" />
  return <CircleDot className="h-3.5 w-3.5" />
}

function eventSummary(event: AgentLogEvent) {
  const payload = event.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const record = payload as Record<string, unknown>
  if (typeof record.toolName === 'string') return record.toolName
  if (typeof record.tool_name === 'string') return record.tool_name
  if (typeof record.name === 'string') return record.name
  if (typeof record.text === 'string') return record.text.replace(/\s+/g, ' ').slice(0, 120)
  return ''
}

function usageSummary(event: AgentLogEvent) {
  const usage = event.usage
  if (!usage) return ''
  const input = usage.inputTokens ?? usage.input_tokens
  const output = usage.outputTokens ?? usage.output_tokens
  const parts = []
  if (typeof input === 'number') parts.push(`输入 ${input} tokens`)
  if (typeof output === 'number') parts.push(`输出 ${output} tokens`)
  return parts.join(' · ')
}

export function AgentLogTimeline({
  events,
  loading,
  error,
  title = 'Agent 运行轨迹',
}: {
  events: AgentLogEvent[]
  loading: boolean
  error: string
  title?: string
}) {
  return <section className="space-y-2 rounded-lg border bg-background p-3">
    <div>
      <h3 className="font-medium">{title}</h3>
      <p className="text-xs text-muted-foreground">按事件顺序记录 session、Skill、LLM 和工具运行；payload 默认折叠。</p>
    </div>
    {loading && <p className="text-sm text-muted-foreground">运行轨迹加载中…</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!loading && !error && events.length === 0 && <p className="text-sm text-muted-foreground">暂无 Agent 事件记录</p>}
    {!loading && !error && events.length > 0 && <div className="space-y-1.5">
      {events.map(event => <AgentLogEventRow key={`${event.sequence}-${event.id}`} event={event} />)}
    </div>}
  </section>
}

const AgentLogEventRow = memo(function AgentLogEventRow({ event }: { event: AgentLogEvent }) {
  const summary = eventSummary(event)
  const usage = usageSummary(event)
  return <details className="rounded border bg-muted/20 p-2">
    <summary className="flex cursor-pointer list-none items-center gap-2 text-xs [&::-webkit-details-marker]:hidden">
      <span className={cn('shrink-0', statusClass(event.status))}><EventIcon event={event} /></span>
      <span className="font-medium">{eventLabels[event.event_type] ?? event.event_type}</span>
      <code className="text-[10px] text-muted-foreground">{event.phase || '—'}</code>
      {summary && <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>}
      {!summary && <span className="flex-1" />}
      <span className={cn('shrink-0', statusClass(event.status))}>{statusLabel(event.status)}</span>
      <span className="shrink-0 text-muted-foreground">{formatTime(event.created_at)}</span>
      <ChevronDown className="h-3.5 w-3.5 shrink-0 transition-transform [[open]_&]:rotate-180" />
    </summary>
    <div className="mt-2 space-y-1.5 border-t pt-2 text-[11px] text-muted-foreground">
      {event.duration_ms !== null && <p>耗时 {event.duration_ms} ms</p>}
      {usage && <p>{usage}</p>}
      <pre className="max-h-[30rem] overflow-auto whitespace-pre-wrap break-words font-mono">{jsonText(event.payload)}</pre>
    </div>
  </details>
})
