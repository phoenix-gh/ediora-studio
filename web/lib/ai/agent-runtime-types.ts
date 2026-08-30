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

export type AgentGoalOutputReference = {
  kind: 'artifact'
  id: string
  claim: string
}

export type AgentGoalCompletionDeclaration = {
  status: 'completed' | 'blocked'
  summary: string
  outputs?: AgentGoalOutputReference[]
  remainingWork?: string[]
}

export type AgentRuntimeToolEvidence = {
  toolCallId: string
  toolName: string
  status: string
  sideEffecting: boolean
}

export type AgentRuntimeGoalEvidence = {
  toolCalls: AgentRuntimeToolEvidence[]
  outputs: AgentGoalOutputReference[]
}

export type AgentModelMessageEvent = {
  callId: string
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
      goalCompletion: AgentGoalCompletionDeclaration
      runtimeEvidence?: AgentRuntimeGoalEvidence
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
  phase: 'plan' | 'references' | 'execute' | 'finalize' | 'validate' | 'revise'
  parts?: Record<string, unknown>[]
  detail?: unknown
}
