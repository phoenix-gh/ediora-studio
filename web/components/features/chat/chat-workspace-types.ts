import type {
  ChatDraft,
  ChatMessage,
  ChatPart,
  ChatRole,
  ChatSession,
  ChatSkill,
  UIMessageStreamEvent,
} from '@/lib/api/chat'

export type DisplayMessage = Omit<ChatMessage, 'id'> & {
  id: string | number
}

export type ToolEventPart = ChatPart & {
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

export type ChatApprovalArgs = {
  sessionId: number
  messageId: number
  toolCallId: string
  approvalId: string
  approved: boolean
}

export type ChatComposerSelection = {
  skillName: string
  draftId: number | null
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
  UIMessageStreamEvent,
}
