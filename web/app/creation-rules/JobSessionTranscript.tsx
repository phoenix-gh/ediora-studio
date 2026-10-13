'use client'

import { useEffect, useState } from 'react'

import { ApiError } from '@/lib/api/client'
import { listAgentTrajectory } from '@/lib/ai/agent-log-client'
import { mergeAgentSessionEvents, type AgentSessionEvent } from '@/lib/ai/agent-trajectory'
import { buildJobSession, type JobSessionEntry } from '@/lib/ai/job-session-transcript'
import { cn } from '@/lib/utils'

function TextBlock({ label, text, muted = false }: { label: string; text: string; muted?: boolean }) {
  return <div className="mt-2">
    <p className="text-xs text-muted-foreground">{label}</p>
    <pre className={cn(
      'mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]',
      muted ? 'text-muted-foreground' : 'text-foreground',
    )}>{text}</pre>
  </div>
}

function EntryBody({ entry }: { entry: JobSessionEntry }) {
  if (entry.kind === 'user') {
    return <article className="rounded-lg border bg-muted/20 p-3">
      <h4 className="text-sm font-medium">任务要求</h4>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{entry.text}</p>
    </article>
  }
  if (entry.kind === 'assistant') {
    return <article className="rounded-lg border bg-background p-3">
      {entry.text && <p className="whitespace-pre-wrap break-words text-sm">{entry.text}</p>}
      {entry.reasoning && <TextBlock label="思考" text={entry.reasoning} muted />}
    </article>
  }
  return <article className={cn('rounded-lg border p-3', entry.failed ? 'border-danger/40 bg-danger/5' : 'bg-background')}>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <code className="font-medium">{entry.title}</code>
      <span className={entry.failed ? 'text-danger' : 'text-muted-foreground'}>{entry.failed ? '失败' : '完成'}</span>
    </div>
    {entry.error && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-danger">{entry.error}</p>}
    {entry.argumentsText && <TextBlock label="参数" text={entry.argumentsText} muted />}
    {entry.outputText && <TextBlock label="输出" text={entry.outputText} muted />}
  </article>
}

export function JobSessionTranscript({ jobId, open }: { jobId: number; open: boolean }) {
  const [events, setEvents] = useState<AgentSessionEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let active = true
    const load = async () => {
      setLoading(true)
      setError('')
      setEvents([])
      try {
        let cursor: number | null = null
        let merged: AgentSessionEvent[] = []
        for (let page = 0; page < 20; page += 1) {
          const result = await listAgentTrajectory({ job_id: jobId }, cursor, 500)
          if (!active) return
          merged = mergeAgentSessionEvents(merged, result.events)
          if (!result.has_more) break
          const next = result.next_sequence ?? result.events.at(-1)?.seq ?? null
          if (next === null || next === cursor) break
          cursor = next
        }
        if (active) setEvents(merged)
      } catch (reason) {
        if (!active) return
        setError(reason instanceof ApiError ? reason.message : '会话记录加载失败')
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false }
  }, [jobId, open])

  const entries = buildJobSession(events)
  return <section data-testid="job-session-panel" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
    <div>
      <h3 className="font-medium">会话过程</h3>
      <p className="text-xs text-muted-foreground">按执行顺序显示任务要求、助手说明、思考、工具参数和输出。</p>
    </div>
    {loading && <p className="text-sm text-muted-foreground">会话加载中…</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {!loading && !error && entries.length === 0 && <p className="text-sm text-muted-foreground">这次执行没有留下会话记录。</p>}
    {entries.map(entry => <EntryBody key={entry.id} entry={entry} />)}
  </section>
}
