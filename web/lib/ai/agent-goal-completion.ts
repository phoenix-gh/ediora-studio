import { tool } from 'ai'
import { z } from 'zod'

import type {
  AgentGoalCompletionDeclaration,
  AgentGoalOutputReference,
  AgentRuntimeGoalEvidence,
} from './agent-runtime-types'

export const COMPLETE_GOAL_TOOL_NAME = 'complete_goal'

export const completeGoalInputSchema = z.object({
  status: z.enum(['completed', 'blocked']),
  summary: z.string().trim().min(1).max(50_000),
  outputs: z.array(z.object({
    kind: z.literal('artifact'),
    id: z.string().trim().min(1).max(300).describe(
      'Use a stable persisted artifact ID, never a transient provider tool-call ID.',
    ),
    claim: z.string().trim().min(1).max(1_000),
  }).strict()).max(100).optional(),
  remainingWork: z.array(z.string().trim().min(1).max(1_000)).max(100).optional(),
}).passthrough()

export const runtimeGoalEvidenceSchema = z.object({
  toolCalls: z.array(z.object({
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    status: z.string().min(1),
    sideEffecting: z.boolean(),
  }).strict()),
  outputs: z.array(z.object({
    kind: z.literal('artifact'),
    id: z.string().min(1),
    claim: z.string().min(1),
  }).strict()),
}).strict()

export const COMPLETE_GOAL_DESCRIPTION = [
  'Declare the final business status of the current durable task.',
  'Call this only after auditing the original objective and actual tool results.',
  'Use completed only when the entire objective is complete; otherwise use blocked and list the remaining work.',
  'The Harness records the actual tool audit automatically; never cite provider tool-call IDs in this declaration.',
  'If a durable output needs to be identified, use outputs with stable persisted artifact IDs.',
].join(' ')

export function createCompleteGoalTool(
  accept: (input: AgentGoalCompletionDeclaration) => void | Promise<void>,
) {
  return tool({
    description: COMPLETE_GOAL_DESCRIPTION,
    inputSchema: completeGoalInputSchema,
    execute: async input => {
      const declaration = normalizeGoalCompletionDeclaration(input)
      if (!declaration) throw new Error('complete_goal input has no valid declaration')
      await accept(declaration)
      return { accepted: true as const, declaration }
    },
  })
}

export function goalCompletionInstructions(objective: string) {
  return `\n\nDurable task completion protocol:\n- The original objective is: ${objective}\n- You own the judgment of whether that entire objective is complete. Audit the original objective and the actual tool results.\n- Do not stop after describing progress. When the objective is fully complete, call complete_goal with status completed and a concise final summary.\n- The Harness records actual tool audits automatically; never cite provider tool-call IDs. If a durable output needs identification, use outputs with stable persisted artifact IDs.\n- If the objective cannot be completed in this run, call complete_goal with status blocked, explain the blocker, and list remaining work.\n- Call complete_goal only once, as the final action of the run.`
}

export function goalCompletionSelfAuditMessage(objective: string) {
  return {
    role: 'user' as const,
    content: `You stopped without declaring the durable task status. Re-audit the unchanged original objective below against the actual tool results. Continue any unfinished work, then call complete_goal exactly once with completed or blocked.\n\nOriginal objective:\n${objective}`,
  }
}

export function goalCompletionFromToolOutput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const candidate = record.accepted === true ? record.declaration : value
  return normalizeGoalCompletionDeclaration(candidate)
}

export function normalizeGoalCompletionDeclaration(value: unknown) {
  const parsed = completeGoalInputSchema.safeParse(value)
  if (!parsed.success) return undefined
  const normalized: AgentGoalCompletionDeclaration = {
    status: parsed.data.status,
    summary: parsed.data.summary,
  }
  if (parsed.data.outputs !== undefined) normalized.outputs = parsed.data.outputs
  if (parsed.data.remainingWork !== undefined) normalized.remainingWork = parsed.data.remainingWork
  return normalized
}

export type GoalEvidenceToolCall = {
  toolCallId: string
  toolName: string
  status: string
  sideEffecting?: boolean
}

export function buildRuntimeGoalEvidence(
  calls: GoalEvidenceToolCall[],
  outputs: AgentGoalOutputReference[] = [],
): AgentRuntimeGoalEvidence {
  return {
    toolCalls: calls
      .filter(call => call.toolName !== COMPLETE_GOAL_TOOL_NAME)
      .map(call => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        status: call.status,
        sideEffecting: call.sideEffecting ?? false,
      })),
    outputs: outputs.map(output => ({ ...output })),
  }
}

export function blockedGoalError(declaration: AgentGoalCompletionDeclaration) {
  const remaining = declaration.remainingWork?.length
    ? `; remaining work: ${declaration.remainingWork.join('; ')}`
    : ''
  return new Error(`Agent blocked: ${declaration.summary}${remaining}`)
}
