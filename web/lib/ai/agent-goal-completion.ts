import { tool } from 'ai'
import { z } from 'zod'

import type { AgentGoalCompletionDeclaration } from './agent-runtime-types'

export const COMPLETE_GOAL_TOOL_NAME = 'complete_goal'

export const completeGoalInputSchema = z.object({
  status: z.enum(['completed', 'blocked']),
  summary: z.string().trim().min(1).max(50_000),
  evidence: z.array(z.object({
    kind: z.enum(['tool_call', 'artifact']),
    id: z.string().trim().min(1).max(300),
    claim: z.string().trim().min(1).max(1_000),
  }).strict()).max(100),
  remainingWork: z.array(z.string().trim().min(1).max(1_000)).max(100).optional(),
}).strict()

export const COMPLETE_GOAL_DESCRIPTION = [
  'Declare the final business status of the current durable task.',
  'Call this only after auditing the original objective and actual tool results.',
  'Use completed only when the entire objective is complete; otherwise use blocked and list the remaining work.',
  'Cite successful tool calls or persisted artifacts that support the declaration.',
].join(' ')

export function createCompleteGoalTool(
  accept: (input: AgentGoalCompletionDeclaration) => void | Promise<void>,
) {
  return tool({
    description: COMPLETE_GOAL_DESCRIPTION,
    inputSchema: completeGoalInputSchema,
    execute: async input => {
      await accept(input)
      return { accepted: true as const, declaration: input }
    },
  })
}

export function goalCompletionInstructions(objective: string) {
  return `\n\nDurable task completion protocol:\n- The original objective is: ${objective}\n- You own the judgment of whether that entire objective is complete. Audit the original objective and the actual tool results.\n- Do not stop after describing progress. When the objective is fully complete, call complete_goal with status completed, a concise final summary, and evidence references.\n- If the objective cannot be completed in this run, call complete_goal with status blocked, explain the blocker, and list remaining work.\n- Call complete_goal only once, as the final action of the run.`
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
  const parsed = completeGoalInputSchema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}

export type GoalEvidenceToolCall = {
  toolCallId: string
  toolName: string
  status: string
}

export function validateGoalCompletionEvidence(
  declaration: AgentGoalCompletionDeclaration,
  calls: GoalEvidenceToolCall[],
) {
  const successfulCallIds = new Set(calls
    .filter(call => call.status === 'succeeded' && call.toolName !== COMPLETE_GOAL_TOOL_NAME)
    .map(call => call.toolCallId))
  for (const reference of declaration.evidence) {
    if (reference.kind === 'tool_call' && !successfulCallIds.has(reference.id)) {
      throw new Error(`Goal completion cites an unavailable tool call: ${reference.id}`)
    }
  }
}

export function blockedGoalError(declaration: AgentGoalCompletionDeclaration) {
  const remaining = declaration.remainingWork?.length
    ? `; remaining work: ${declaration.remainingWork.join('; ')}`
    : ''
  return new Error(`Agent blocked: ${declaration.summary}${remaining}`)
}
