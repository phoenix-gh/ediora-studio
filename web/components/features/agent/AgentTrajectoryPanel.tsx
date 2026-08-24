'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

import { ApiError } from '@/lib/api/client'
import {
  listAgentTrajectory,
  type AgentTrajectoryScope,
} from '@/lib/ai/agent-log-client'
import {
  deriveAgentTrajectory,
  mergeAgentSessionEvents,
  type AgentSessionEvent,
  type PartialAssistant,
  type TrajectoryCell,
  type TrajectoryGroup,
  type TrajectoryTurn,
} from '@/lib/ai/agent-trajectory'
import { cn } from '@/lib/utils'

const TRACE_REFRESH_INTERVAL_MS = 2_000

function formatValue(value: unknown) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}

function statusLabel(status: string) {
  return ({
    running: '进行中', completed: '完成', error: '错误', aborted: '已中止',
    interrupted: '已中断', waiting_approval: '等待审批',
  } as Record<string, string>)[status] ?? status
}

function statusClass(status: string) {
  if (status === 'completed') return 'text-success'
  if (['error', 'aborted', 'interrupted'].includes(status)) return 'text-danger'
  if (status === 'running' || status === 'waiting_approval') return 'text-info'
  return 'text-muted-foreground'
}

function cellSummary(cell: TrajectoryCell) {
  if (cell.kind === 'tool' || cell.kind === 'subtool') return cell.toolName ?? 'Tool'
  if (cell.text) return cell.text.replace(/\s+/g, ' ').slice(0, 120)
  if (cell.thinkingDetail) return cell.thinkingDetail.replace(/\s+/g, ' ').slice(0, 120)
  return cell.title ?? cell.kind
}

const TrajectoryCellRow = memo(function TrajectoryCellRow({
  cell,
  selected,
  onSelect,
}: {
  cell: TrajectoryCell
  selected: boolean
  onSelect: (recordId: string) => void
}) {
  return <button
    type="button"
    data-testid={`trajectory-cell-${cell.recordId}`}
    aria-pressed={selected}
    onClick={() => onSelect(cell.recordId)}
    className={cn(
      'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
      selected ? 'border-primary bg-primary/5' : 'bg-background hover:bg-muted/40',
    )}
  >
    <span className="w-16 shrink-0 text-[11px] uppercase text-muted-foreground">{cell.kind}</span>
    <span className="min-w-0 flex-1 truncate">{cellSummary(cell)}</span>
    <span className={cn('shrink-0 text-xs', statusClass(cell.status))}>{statusLabel(cell.status)}</span>
    {cell.timeSeconds !== null && <span className="shrink-0 text-[11px] text-muted-foreground">{cell.timeSeconds.toFixed(1)}s</span>}
  </button>
})

function GroupView({
  group,
  selectedId,
  onSelect,
}: {
  group: TrajectoryGroup
  selectedId: string | null
  onSelect: (recordId: string) => void
}) {
  return <section data-testid={`trajectory-group-${group.recordId}`} className="space-y-1.5">
    <h4 className="px-1 text-xs font-semibold text-muted-foreground">{group.title}</h4>
    {group.cells.map(cell => <TrajectoryCellRow key={cell.recordId} cell={cell} selected={selectedId === cell.recordId} onSelect={onSelect} />)}
  </section>
}

function TurnView({
  turn,
  selectedId,
  onSelect,
}: {
  turn: TrajectoryTurn
  selectedId: string | null
  onSelect: (recordId: string) => void
}) {
  return <section data-testid={`trajectory-turn-${turn.turn}`} className="space-y-2 rounded-xl border bg-muted/20 p-3">
    <div className="flex items-center gap-2">
      <h3 className="font-medium">Turn {turn.turn}</h3>
      <span className={cn('text-xs', statusClass(turn.status))}>{statusLabel(turn.status)}</span>
    </div>
    {turn.groups.map(group => <GroupView key={group.recordId} group={group} selectedId={selectedId} onSelect={onSelect} />)}
  </section>
}

function findCell(snapshot: ReturnType<typeof deriveAgentTrajectory>, recordId: string | null) {
  if (!recordId) return null
  return snapshot.turns.flatMap(turn => turn.groups.flatMap(group => group.cells)).find(cell => cell.recordId === recordId) ?? null
}

function Inspector({
  cell,
  partial,
  developerModeEnabled,
}: {
  cell: TrajectoryCell | null
  partial: PartialAssistant | null
  developerModeEnabled: boolean
}) {
  if (!cell && !partial) {
    return <aside data-testid="trajectory-inspector" className="min-h-0 overflow-y-auto rounded-xl border bg-muted/20 p-3 text-sm text-muted-foreground">选择一条消息、思考或工具调用查看详情。</aside>
  }
  const item = cell ?? partial
  if (!item) return null
  return <aside data-testid="trajectory-inspector" className="min-h-0 overflow-y-auto space-y-3 rounded-xl border bg-muted/20 p-3 text-sm">
    <div className="flex items-center justify-between gap-2"><h3 className="font-medium">检查器</h3><span className={cn('text-xs', statusClass(item.status))}>{statusLabel(item.status)}</span></div>
    {'thinkingDetail' in item && item.thinkingDetail && <div><p className="text-xs font-medium text-muted-foreground">思考</p><p className="mt-1 whitespace-pre-wrap break-words">{item.thinkingDetail}</p></div>}
    {'text' in item && item.text && <div><p className="text-xs font-medium text-muted-foreground">文本</p><p className="mt-1 whitespace-pre-wrap break-words">{item.text}</p></div>}
    {'inputDetail' in item && item.inputDetail && <div><p className="text-xs font-medium text-muted-foreground">输入</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px]">{item.inputDetail}</pre></div>}
    {'outputDetail' in item && item.outputDetail && <div><p className="text-xs font-medium text-muted-foreground">输出</p><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[11px]">{item.outputDetail}</pre></div>}
    {'error' in item && item.error && <div><p className="text-xs font-medium text-muted-foreground">错误</p><p className="mt-1 break-words text-danger">{item.error}</p></div>}
    {'usage' in item && item.usage && <div><p className="text-xs font-medium text-muted-foreground">用量</p><pre className="mt-1 text-[11px]">{formatValue(item.usage)}</pre></div>}
    {item.timeSeconds !== null && <div><p className="text-xs font-medium text-muted-foreground">耗时</p><p className="mt-1">{item.timeSeconds.toFixed(1)} 秒</p></div>}
    {developerModeEnabled && <details><summary className="cursor-pointer text-xs font-medium text-muted-foreground">Raw event data</summary><pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[10px]">{formatValue('data' in item ? item.data : item)}</pre></details>}
  </aside>
}

export function AgentTrajectoryPanel({
  scope,
  open,
  developerModeEnabled,
  title = 'Agent 运行轨迹',
  showHeader = true,
  onRunningChange,
}: {
  scope: AgentTrajectoryScope
  open: boolean
  developerModeEnabled: boolean
  title?: string
  showHeader?: boolean
  onRunningChange?: (isRunning: boolean) => void
}) {
  const [scopeName, scopeValue] = Object.entries(scope)[0] as [string, number]
  const key = `${scopeName}:${scopeValue}`
  const stableScope = useMemo(
    () => ({ [scopeName]: scopeValue } as AgentTrajectoryScope),
    [scopeName, scopeValue],
  )
  const cursorRef = useRef<number | null>(null)
  const hasMoreRef = useRef(false)
  const inFlightRef = useRef(false)
  const refreshTimerRef = useRef<number | null>(null)
  const runningRef = useRef<boolean | null>(null)
  const [events, setEvents] = useState<AgentSessionEvent[]>([])
  const [sessionKey, setSessionKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [unsupportedFormat, setUnsupportedFormat] = useState(false)
  const [runningState, setRunningState] = useState<boolean | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [eventsScopeKey, setEventsScopeKey] = useState(key)

  const setTraceRunning = useCallback((next: boolean) => {
    runningRef.current = next
    setRunningState(next)
    onRunningChange?.(next)
  }, [onRunningChange])

  const refresh = useCallback(async (active: () => boolean, reset = false) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setLoading(true)
    setError('')
    setUnsupportedFormat(false)
    try {
      const cursor = reset ? null : cursorRef.current
      const page = await listAgentTrajectory(stableScope, cursor, 500)
      if (!active()) return
      setEvents(current => mergeAgentSessionEvents(reset ? [] : current, page.events))
      setEventsScopeKey(key)
      setSessionKey(page.session_key)
      cursorRef.current = page.next_sequence ?? page.events.at(-1)?.seq ?? cursor
      hasMoreRef.current = page.has_more
      setTraceRunning(page.unsupported_format ? false : page.is_running)
      setUnsupportedFormat(page.unsupported_format)
      setError('')
    } catch (reason) {
      if (!active()) return
      hasMoreRef.current = false
      setTraceRunning(false)
      if (reason instanceof ApiError && reason.status === 404) {
        setUnsupportedFormat(true)
      } else {
        setError(reason instanceof Error ? reason.message : '运行轨迹加载失败')
      }
    } finally {
      inFlightRef.current = false
      if (active()) setLoading(false)
    }
  }, [key, setTraceRunning, stableScope])

  useEffect(() => {
    if (!open) {
      runningRef.current = false
      onRunningChange?.(false)
      return
    }
    let active = true
    cursorRef.current = null
    hasMoreRef.current = false
    inFlightRef.current = false
    refreshTimerRef.current = null
    runningRef.current = null
    onRunningChange?.(false)
    const scheduleRefresh = () => {
      if (!active || (!hasMoreRef.current && runningRef.current === false)) return
      refreshTimerRef.current = window.setTimeout(async () => {
        refreshTimerRef.current = null
        if (!active) return
        await refresh(() => active)
        scheduleRefresh()
      }, TRACE_REFRESH_INTERVAL_MS)
    }
    const initialRefresh = window.setTimeout(async () => {
      if (!active) return
      await refresh(() => active, true)
      scheduleRefresh()
    }, 0)
    return () => {
      active = false
      window.clearTimeout(initialRefresh)
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = null
    }
  }, [key, onRunningChange, open, refresh])

  const snapshot = useMemo(() => deriveAgentTrajectory(
    eventsScopeKey === key ? events : [],
    eventsScopeKey === key ? sessionKey : '',
  ), [events, eventsScopeKey, key, sessionKey])
  const selectedCell = findCell(snapshot, selectedId)
  const selectedPartial = snapshot.partial?.recordId === selectedId ? snapshot.partial : null
  const selectRecord = useCallback((recordId: string) => setSelectedId(recordId), [])
  const isRunning = open && runningState === true

  return <section data-testid="agent-trajectory-panel" className="flex h-full min-h-0 flex-col gap-3 rounded-lg border bg-background p-3">
    {showHeader && <div className="flex shrink-0 flex-wrap items-start justify-between gap-2">
      <div><h3 className="font-medium">{title}</h3><p className="text-xs text-muted-foreground">按 Turn、Message、Step 和 Tool 展开；选择记录查看本地检查器。</p></div>
      <div className="flex items-center gap-2 text-xs">
        {isRunning && <Loader2 data-testid="trajectory-running-indicator" role="status" aria-label="运行中" className="size-4 animate-spin text-info" />}
      </div>
    </div>}
    {(unsupportedFormat || error) && <div data-testid="trajectory-status-slot" className="shrink-0">
      {unsupportedFormat && <p role="alert" className="text-sm text-danger">暂不支持旧格式数据</p>}
      {!unsupportedFormat && error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>}
    {!error && !unsupportedFormat && !loading && snapshot.turns.length === 0 && !snapshot.partial && <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">暂无 Agent 轨迹记录</div>}
    {!error && !unsupportedFormat && snapshot.turns.length > 0 && <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] lg:grid-rows-1">
      <div data-testid="trajectory-list" className="min-h-0 min-w-0 space-y-2 overflow-y-auto pr-1">
        {snapshot.turns.map(turn => <TurnView key={turn.recordId} turn={turn} selectedId={selectedId} onSelect={selectRecord} />)}
        {snapshot.runningCalls.length > 0 && <div className="space-y-1.5 rounded-xl border border-info/30 bg-info/5 p-3"><h4 className="text-xs font-semibold text-info">等待工具结果</h4>{snapshot.runningCalls.map(call => <TrajectoryCellRow key={call.recordId} cell={call} selected={selectedId === call.recordId} onSelect={selectRecord} />)}</div>}
      </div>
      <Inspector cell={selectedCell} partial={selectedPartial} developerModeEnabled={developerModeEnabled} />
    </div>}
  </section>
}
