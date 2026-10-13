import type {
  ChatDraft,
  ChatMessage,
  ChatPart,
  ChatRole,
  ChatSession,
  ChatSkill,
  ChatStreamStatus,
  SubmittedSkillInvocation,
  UIMessageStreamEvent,
} from '@/lib/api/chat'

export type DisplayMessage = Omit<ChatMessage, 'id'> & {
  id: string | number
}

export type ToolEventPart = ChatPart & {
  runId?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  state?: string
  approval?: {
    id?: string
    approved?: boolean
  }
}

export type ChatStatusPart = ChatPart & ChatStreamStatus & {
  type: 'chat-status'
  id: string
}

export type ChatApprovalArgs = {
  sessionId: number
  runId: string
  toolCallId: string
  approvalId: string
  approved: boolean
  reason?: string
}

export type ChatComposerSelection = {
  skillName: string
  draftId: number | null
  pipelineInvocations: SubmittedSkillInvocation[]
}

export type ChatWorkspaceState = {
  sessions: ChatSession[]
  activeSessionId: number | null
  messagesBySession: Record<string, DisplayMessage[]>
  loadingBySession: Record<string, boolean>
  runningBySession: Record<string, boolean>
  errorsBySession: Record<string, string | null>
  composer: ChatComposerSelection
}

export type {
  ChatDraft,
  ChatPart,
  ChatRole,
  ChatSession,
  ChatSkill,
  SubmittedSkillInvocation,
  UIMessageStreamEvent,
}
