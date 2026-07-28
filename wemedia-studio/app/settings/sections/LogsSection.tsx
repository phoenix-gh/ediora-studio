'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
import { FormSection } from '@/components/layout/FormSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api'

interface LogEntry {
  id: number
  job: string
  status: string
  message: string
  detail: string
  created_at: string
}

const JOB_LABEL: Record<string, string> = { collect: '采集', github: 'GitHub', analyze: 'AI 分析', x: 'X' }
const STATUS_DOT: Record<string, string> = {
  ok:    'bg-primary',
  warn:  'bg-muted-foreground',
  error: 'bg-destructive',
}

function formatTime(iso: string) {
  // Backend returns naive UTC strings (no Z / +00:00); append Z so JS parses as UTC
  const utc = /Z|[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z'
  const d = new Date(utc)
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
}

export function LogsSection() {
  const [logs, setLogs]       = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<number | null>(null)

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/settings/logs?limit=100`)
      if (res.ok) setLogs(await res.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchLogs()
    const t = setInterval(fetchLogs, 30_000)
    return () => clearInterval(t)
  }, [fetchLogs])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FormSection
        title="运行日志"
        description="最多显示最近 100 条记录，自动每 30 秒刷新。"
        actions={(
          <Button type="button" variant="outline" size="sm" onClick={() => void fetchLogs()}>
            <RefreshCw data-icon="inline-start" />
            刷新
          </Button>
        )}
      >
        <div className="flex min-h-[24rem] flex-col overflow-hidden rounded-xl border border-border bg-surface font-mono text-sm">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-muted px-3 py-2">
            {Object.entries(JOB_LABEL).map(([key, label]) => (
              <Badge key={key} variant="outline">{label}</Badge>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-muted-foreground">
                <Loader2 className="animate-spin" />
                加载中…
            </div>
          ) : logs.length === 0 ? (
              <div className="px-3 py-4 text-muted-foreground">暂无日志 · 等待首次调度</div>
          ) : (
            logs.map(log => (
              <div key={log.id}>
                  <button
                    type="button"
                    disabled={!log.detail}
                  className={cn(
                      'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors',
                      log.detail && 'hover:bg-surface-muted'
                  )}
                  onClick={() => log.detail && setExpanded(expanded === log.id ? null : log.id)}
                >
                    <span className="w-28 shrink-0 tabular-nums text-foreground-subtle">{formatTime(log.created_at)}</span>
                    <span className="w-14 shrink-0 text-center text-muted-foreground">
                    {JOB_LABEL[log.job] ?? log.job}
                  </span>
                  <span className={cn(
                      'mt-1.5 size-1.5 shrink-0 rounded-full',
                      STATUS_DOT[log.status] ?? 'bg-muted-foreground'
                  )} />
                  <span className={cn(
                      'min-w-0 flex-1',
                      log.status === 'error' && 'text-destructive'
                  )}>
                    {log.message}
                      {log.detail ? <span className="ml-1 text-foreground-subtle">▸</span> : null}
                  </span>
                  </button>
                {expanded === log.id && log.detail && (
                    <div className="ml-[7rem] whitespace-pre-wrap break-all px-3 pb-2 text-sm leading-relaxed text-destructive">
                    {log.detail}
                  </div>
                )}
              </div>
            ))
          )}
          </div>
        </div>
      </FormSection>
    </div>
  )
}
