export type AgentApprovalPolicy = 'interactive' | 'automatic'

export type AgentSkillMode = 'auto' | 'manual'

export type AgentToolDecision =
  | { action: 'execute' }
  | { action: 'replay'; output: unknown }
  | { action: 'uncertain'; error: string }

export type AgentToolAudit = {
  toolName: string
  toolCallId: string
  sideEffecting: boolean
  autoApproved: boolean
  status: 'started' | 'succeeded' | 'failed' | 'uncertain'
  inputSummary: unknown
  output?: unknown
  error?: string
  occurredAt: string
  step?: number
}

export type AgentModelMessageEvent = {
  phase: string
  step?: number
  direction: 'model_request' | 'model_response' | 'model_error'
  payload: Record<string, unknown>
  occurredAt: string
}

export type AgentCompletionEvidence =
  | {
      kind: 'agent_run'
      executionId: number
      finalText: string
      toolCallCount: number
    }
  | {
      kind: 'model_evaluation'
      executionId: number
      flow: string
      messageCount: number
    }
  | {
      toolName: 'save_draft'
      toolCallId: string
      draftId: number
      responseItemId: number
    }

export type AgentStepCheckpoint = {
  phase: 'plan' | 'references' | 'execute' | 'validate' | 'revise'
  parts?: Record<string, unknown>[]
  detail?: unknown
}
