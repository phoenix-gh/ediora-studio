'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Loader2 } from 'lucide-react'
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
const JOB_COLOR: Record<string, string> = {
  collect: 'text-indigo-500 dark:text-indigo-400',
  github:  'text-violet-500 dark:text-violet-400',
  analyze: 'text-amber-500 dark:text-amber-400',
  x:       'text-sky-500 dark:text-sky-400',
}
const STATUS_DOT: Record<string, string> = {
  ok:    'bg-emerald-500',
  warn:  'bg-amber-400',
  error: 'bg-red-500',
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
    <div className="flex flex-col flex-1 min-h-0 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-zinc-400">自动每 30 秒刷新</p>
        <button onClick={fetchLogs}
          className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-600 transition-colors">
          <RefreshCw className="w-3 h-3" />刷新
        </button>
      </div>

      <div className="flex flex-col flex-1 min-h-0 bg-zinc-950 rounded-xl overflow-hidden border border-zinc-800 font-mono text-xs">
        {/* Legend */}
        <div className="flex items-center gap-4 px-3 py-2 border-b border-zinc-800 text-zinc-500">
          {Object.entries(JOB_LABEL).map(([k, v]) => (
            <span key={k} className={cn('flex items-center gap-1', JOB_COLOR[k])}>
              <span className="text-[10px]">■</span>{v}
            </span>
          ))}
        </div>

        {/* Rows */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-zinc-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />加载中…
            </div>
          ) : logs.length === 0 ? (
            <div className="px-3 py-4 text-zinc-600">暂无日志 · 等待首次调度</div>
          ) : (
            logs.map(log => (
              <div key={log.id}>
                <div
                  className={cn(
                    'flex items-start gap-2 px-3 py-1.5 hover:bg-zinc-900 transition-colors',
                    log.detail && 'cursor-pointer'
                  )}
                  onClick={() => log.detail && setExpanded(expanded === log.id ? null : log.id)}
                >
                  <span className="text-zinc-600 flex-shrink-0 tabular-nums w-28">{formatTime(log.created_at)}</span>
                  <span className={cn('flex-shrink-0 w-14 text-center', JOB_COLOR[log.job] ?? 'text-zinc-400')}>
                    {JOB_LABEL[log.job] ?? log.job}
                  </span>
                  <span className={cn(
                    'flex-shrink-0 w-1.5 h-1.5 rounded-full mt-1.5',
                    STATUS_DOT[log.status] ?? 'bg-zinc-500'
                  )} />
                  <span className={cn(
                    'flex-1 min-w-0',
                    log.status === 'error' ? 'text-red-400' : log.status === 'warn' ? 'text-amber-400' : 'text-zinc-300'
                  )}>
                    {log.message}
                    {log.detail && <span className="text-zinc-600 ml-1">▸</span>}
                  </span>
                </div>
                {expanded === log.id && log.detail && (
                  <div className="px-3 pb-2 ml-[7rem] text-red-400/80 whitespace-pre-wrap break-all text-[10px] leading-relaxed">
                    {log.detail}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
