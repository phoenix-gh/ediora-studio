'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
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
const STATUS_META: Record<string, {
  label: string
  variant: 'success' | 'warning' | 'destructive' | 'outline'
  dot: string
}> = {
  ok:    { label: '成功', variant: 'success', dot: 'bg-success' },
  warn:  { label: '警告', variant: 'warning', dot: 'bg-warning' },
  error: { label: '错误', variant: 'destructive', dot: 'bg-destructive' },
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
  const [loadError, setLoadError] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const requestSequence = useRef(0)
  const active = useRef(true)

  const fetchLogs = useCallback(async () => {
    if (!active.current) return
    const requestId = ++requestSequence.current
    try {
      const res = await fetch(`${API}/settings/logs?limit=100`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const nextLogs = await res.json()
      if (active.current && requestId === requestSequence.current) {
        setLogs(nextLogs)
        setLoadError('')
      }
    } catch {
      if (active.current && requestId === requestSequence.current) {
        setLoadError('日志加载失败，请稍后重试')
      }
    } finally {
      if (active.current && requestId === requestSequence.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    active.current = true
    queueMicrotask(() => void fetchLogs())
    const t = setInterval(() => void fetchLogs(), 30_000)
    return () => {
      active.current = false
      requestSequence.current += 1
      clearInterval(t)
    }
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
          {loadError ? (
              <div role="alert" className="border-b border-border px-3 py-3 text-destructive">
                {loadError}
              </div>
          ) : null}
          {loading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-muted-foreground">
                <Loader2 className="animate-spin" />
                加载中…
            </div>
          ) : logs.length === 0 ? (
              <div className="px-3 py-4 text-muted-foreground">暂无日志 · 等待首次调度</div>
          ) : (
            logs.map(log => {
              const status = STATUS_META[log.status] ?? {
                label: log.status || '未知',
                variant: 'outline' as const,
                dot: 'bg-muted-foreground',
              }
              const detailId = `log-detail-${log.id}`
              const isExpanded = expanded === log.id

              return (
              <div key={log.id}>
                  <button
                    type="button"
                    disabled={!log.detail}
                    aria-expanded={log.detail ? isExpanded : undefined}
                    aria-controls={log.detail ? detailId : undefined}
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
                  <Badge
                    variant={status.variant}
                    aria-label={`状态：${status.label}`}
                    className="gap-1 px-1.5"
                  >
                    <span aria-hidden="true" className={cn('size-1.5 rounded-full', status.dot)} />
                    {status.label}
                  </Badge>
                  <span className={cn(
                      'min-w-0 flex-1',
                      log.status === 'error' && 'text-destructive'
                  )}>
                    {log.message}
                      {log.detail ? <span className="ml-1 text-foreground-subtle">▸</span> : null}
                  </span>
                  </button>
                {isExpanded && log.detail && (
                    <div
                      id={detailId}
                      className="ml-[7rem] whitespace-pre-wrap break-all px-3 pb-2 text-sm leading-relaxed text-destructive"
                    >
                    {log.detail}
                  </div>
                )}
              </div>
              )
            })
          )}
          </div>
        </div>
      </FormSection>
    </div>
  )
}
