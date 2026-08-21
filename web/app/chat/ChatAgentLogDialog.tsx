'use client'

import { useCallback, useEffect, useState } from 'react'

import { AgentLogTimeline } from '@/components/features/agent/AgentLogTimeline'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { listAllAgentLogEvents, type AgentLogEvent } from '@/lib/ai/agent-log-client'

const TRACE_REFRESH_INTERVAL_MS = 2_000

export function mergeAgentLogEvents(previous: AgentLogEvent[], incoming: AgentLogEvent[]) {
  const existingSequences = new Set(previous.map(event => event.sequence))
  const additions = incoming.filter(event => !existingSequences.has(event.sequence))
  if (additions.length === 0) return previous
  return [...previous, ...additions].sort((left, right) => left.sequence - right.sequence)
}

export function ChatAgentLogDialog({
  sessionId,
  open,
  developerModeEnabled,
  onOpenChange,
}: {
  sessionId: number | null
  open: boolean
  developerModeEnabled: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [events, setEvents] = useState<AgentLogEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async (currentSessionId: number, active: () => boolean) => {
    try {
      const page = await listAllAgentLogEvents({ session_id: currentSessionId, limit: 500 })
      if (!active()) return
      setEvents(current => mergeAgentLogEvents(current, page.events))
      setError('')
    } catch (reason) {
      if (active()) setError(reason instanceof Error ? reason.message : '运行轨迹加载失败')
    } finally {
      if (active()) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!open || !developerModeEnabled || sessionId === null) return
    let active = true
    const initialRefresh = window.setTimeout(() => {
      if (active) void refresh(sessionId, () => active)
    }, 0)
    const timer = window.setInterval(() => void refresh(sessionId, () => active), TRACE_REFRESH_INTERVAL_MS)
    return () => {
      active = false
      window.clearTimeout(initialRefresh)
      window.clearInterval(timer)
    }
  }, [developerModeEnabled, open, refresh, sessionId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="chat-agent-log-dialog"
        size="lg"
        className="flex h-[min(720px,calc(100dvh-2rem))] min-h-[min(520px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>运行轨迹</DialogTitle>
          <DialogDescription>查看本会话的 LLM、Skill 和工具执行记录。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AgentLogTimeline events={events} loading={loading} error={error} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
