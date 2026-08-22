'use client'

import { AgentTrajectoryPanel } from '@/components/features/agent/AgentTrajectoryPanel'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

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
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent
      data-testid="chat-agent-log-dialog"
      size="lg"
      className="flex h-[min(720px,calc(100dvh-2rem))] min-h-[min(520px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] flex-col overflow-hidden"
    >
      <DialogHeader className="shrink-0">
        <DialogTitle>运行轨迹</DialogTitle>
        <DialogDescription>按 Turn、Message、Step 和 Tool 查看本会话 Agent 运行轨迹。</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-hidden">
        {sessionId !== null && <AgentTrajectoryPanel scope={{ session_id: sessionId }} open={open} developerModeEnabled={developerModeEnabled} />}
      </div>
    </DialogContent>
  </Dialog>
}
