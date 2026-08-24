'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'

import { AgentTrajectoryPanel } from '@/components/features/agent/AgentTrajectoryPanel'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

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
  const [isRunning, setIsRunning] = useState(false)

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) setIsRunning(false)
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid="chat-agent-log-dialog"
        size="lg"
        className="flex h-[min(720px,calc(100dvh-2rem))] min-h-[min(520px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0">
          <div className="flex items-center gap-2">
            <DialogTitle>运行轨迹</DialogTitle>
            {open && sessionId !== null && isRunning && (
              <Loader2
                data-testid="trajectory-running-indicator"
                role="status"
                aria-label="运行中"
                className="size-4 animate-spin text-info"
              />
            )}
          </div>
          <DialogDescription>按 Turn、Message、Step 和 Tool 查看本会话 Agent 运行轨迹。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden">
          {sessionId !== null && (
            <AgentTrajectoryPanel
              scope={{ session_id: sessionId }}
              open={open}
              developerModeEnabled={developerModeEnabled}
              showHeader={false}
              onRunningChange={setIsRunning}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
