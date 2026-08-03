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
}

export type AgentCompletionEvidence = {
  toolName: 'save_daily_creation_outputs'
  toolCallId: string
  runId: number
  createdCount: number
  outputIds: number[]
  usageIds: number[]
}
