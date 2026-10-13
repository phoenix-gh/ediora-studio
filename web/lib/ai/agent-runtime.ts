import type { ModelMessage, ToolSet } from 'ai'

import type { ChatSkillRuntime } from './global-chat-tools'
import type { AgentCapabilitySnapshot } from './agent-capabilities'
import { COMPLETE_GOAL_TOOL_NAME } from './agent-goal-completion'
import type { PreparedSkillRun } from './skill-run-ai-sdk'
import type { SkillRun, SkillRunActivation } from './skill-run'
import type {
  AgentGoalCompletionDeclaration,
  AgentStepCheckpoint,
} from './agent-runtime-types'
import type { AgentSessionEventType } from './agent-trajectory'
import type { RegisteredSkill } from '../skills/registry'

export type AgentSelectedSkill = {
  skill: RegisteredSkill
  activation: SkillRunActivation
}

export { MODEL_ERROR_DIAGNOSTIC_PAYLOAD_LIMIT } from './model-error-evidence'

export type AgentSessionEventDraft = {
  type: AgentSessionEventType
  turn: number | null
  step: number | null
  data: Record<string, unknown>
}

export type AgentRunRequest = {
  objective: string
  modelMessages: ModelMessage[]
  conversationContext?: string
  selectedContext?: string
  maxSteps: number
  requiredTools?: string[]
  requireGoalCompletion?: boolean
  verifyGoalCompletion?: (
    declaration: AgentGoalCompletionDeclaration,
  ) => void | Promise<void>
  getFollowUpMessages?: () => ModelMessage[] | Promise<ModelMessage[]>
  onStep?: (checkpoint: AgentStepCheckpoint) => void | Promise<void>
}

export type AgentPrepareRequest = {
  objective: string
  conversationContext?: string
  selectedContext?: string
  onStep?: AgentRunRequest['onStep']
}

export type AgentPreparedRun = {
  selectedSkill?: {
    name: string
    version: string
    digest: string
    activation: SkillRunActivation
  }
  skillRun?: PreparedSkillRun
  capabilitySnapshot: AgentCapabilitySnapshot
}

export type AgentExecutePreparedRequest = AgentRunRequest & {
  prepared: AgentPreparedRun
}

export type AgentRunResult = {
  kind: 'completed' | 'approval'
  text: string
  parts: Record<string, unknown>[]
  assistantContent?: Record<string, unknown>[]
  finishReason?: string
  stepCount?: number
  skillRun?: SkillRun
  revisionCount: 0 | 1
  selectedSkill?: { name: string; activation: SkillRunActivation }
  goalCompletion?: AgentGoalCompletionDeclaration
}

export class AgentRunIncompleteError extends Error {
  readonly name = 'AgentRunIncompleteError'

  constructor(
    readonly code: 'final_answer_missing',
    message: string,
  ) {
    super(message)
  }
}

export type AgentRuntime = {
  readonly tools: ToolSet
  readonly catalogContext: string
  readonly selectedSkill: AgentSelectedSkill | undefined
  prepare(objective: string, conversationContext?: string): Promise<AgentSelectedSkill | undefined>
  prepareRun(request: AgentPrepareRequest): Promise<AgentPreparedRun>
  executePrepared(request: AgentExecutePreparedRequest): Promise<AgentRunResult>
  run(request: AgentRunRequest): Promise<AgentRunResult>
  snapshot: ChatSkillRuntime['snapshot']
  activeContext: ChatSkillRuntime['activeContext']
  capabilitySnapshot(): AgentCapabilitySnapshot
  readReferences: ChatSkillRuntime['readReferences']
  close(): Promise<void>
}

export function planningTools(tools: ToolSet) {
  return Object.entries(tools)
    .filter(([name]) => (
      name !== 'loadSkill'
      && name !== 'readSkillReference'
      && name !== COMPLETE_GOAL_TOOL_NAME
    ))
    .map(([name, value]) => ({
      name,
      description: typeof (value as { description?: unknown }).description === 'string'
        ? (value as { description: string }).description
        : '',
    }))
}

export function executionParts(result: {
  toolResults: Array<Record<string, unknown>>
  content: Array<Record<string, unknown>>
}) {
  const parts: Record<string, unknown>[] = []
  for (const item of result.toolResults) {
    if (typeof item.toolName !== 'string' || typeof item.toolCallId !== 'string') continue
    parts.push({
      type: 'dynamic-tool', toolName: item.toolName, toolCallId: item.toolCallId,
      state: 'output-available', output: item.output,
    })
  }
  for (const item of result.content) {
    if (item.type !== 'tool-approval-request' || !item.toolCall || typeof item.toolCall !== 'object') continue
    const toolCall = item.toolCall as Record<string, unknown>
    if (typeof toolCall.toolName !== 'string' || typeof toolCall.toolCallId !== 'string' || typeof item.approvalId !== 'string') continue
    parts.push({
      type: 'dynamic-tool', toolName: toolCall.toolName, toolCallId: toolCall.toolCallId,
      state: 'approval-requested', input: toolCall.input, approval: { id: item.approvalId },
    })
  }
  return parts
}

export function agentSkillRunAudit(result: AgentRunResult) {
  const run = result.skillRun
  if (!run) return undefined
  return {
    skillName: run.skillName,
    activation: run.activation,
    steps: run.steps.map(step => ({ id: step.id, status: step.status, evidence: step.evidence })),
    loadedReferences: run.loadedReferences,
    toolEvidence: run.toolEvidence,
    validation: run.validation,
    revisionCount: result.revisionCount,
  }
}
