import type { ModelMessage } from 'ai'

import type {
  AgentPreparedRun,
  AgentRunResult,
} from './agent-runtime'
import { buildCanonicalModelMessages } from './chat-run-history'
import { projectChatRun, type ChatRunProjection } from './chat-run-projector'
import { applyToolEvidence } from './skill-run-evidence'
import type {
  ChatRunCheckpoint,
  ChatRunRecord,
  ChatRunStepCheckpoint,
  ChatRunToolCallCheckpoint,
} from './chat-run-types'

type ApprovalDecision = {
  decision: 'approved' | 'rejected'
  duplicate: boolean
  run_status: string
}

export type ChatRunPersistence = {
  createRun(sessionId: number, input: { user_message_id: number; objective: string }): Promise<ChatRunRecord>
  freezePreparation(sessionId: number, runId: string, input: Record<string, unknown>): Promise<ChatRunRecord>
  appendStep(sessionId: number, runId: string, input: Record<string, unknown>): Promise<ChatRunStepCheckpoint | Record<string, unknown>>
  loadCheckpoint(sessionId: number, runId: string): Promise<ChatRunCheckpoint>
  decideApproval(sessionId: number, runId: string, approvalId: string, input: {
    tool_call_id: string; approved: boolean; reason?: string
  }): Promise<ApprovalDecision>
  completeToolCall(sessionId: number, runId: string, toolCallId: string, input: {
    status: 'succeeded' | 'failed' | 'outcome_unknown'
    output_data?: unknown
    error_data?: Record<string, unknown>
  }): Promise<ChatRunToolCallCheckpoint | Record<string, unknown>>
  transitionRun(sessionId: number, runId: string, input: Record<string, unknown>): Promise<ChatRunRecord>
}

type RuntimeBoundary = {
  prepareRun(input: {
    objective: string; conversationContext?: string; selectedContext?: string
  }): Promise<AgentPreparedRun>
  executePrepared(input: {
    prepared: AgentPreparedRun
    objective: string
    modelMessages: ModelMessage[]
    conversationContext?: string
    selectedContext?: string
    maxSteps: number
  }): Promise<AgentRunResult>
  close(): Promise<void>
}

export type ChatRunOrchestratorDependencies = {
  persistence: ChatRunPersistence
  openRuntime(input: { skillName?: string }): Promise<RuntimeBoundary>
  executeApprovedTool(input: {
    checkpoint: ChatRunCheckpoint
    toolCall: ChatRunToolCallCheckpoint
  }): Promise<unknown>
}

export type StartChatRunInput = {
  sessionId: number
  userMessageId: number
  objective: string
  modelMessages: ModelMessage[]
  conversationContext?: string
  selectedContext?: string
  maxSteps: number
  skillName?: string
}

export type ResumeChatRunInput = {
  sessionId: number
  runId: string
  approvalId: string
  toolCallId: string
  approved: boolean
  reason?: string
  maxSteps: number
}

function frozenSkillInvocation(prepared: AgentPreparedRun) {
  const skill = prepared.selectedSkill
  return skill ? {
    name: skill.name, version: skill.version, digest: skill.digest,
    activation: skill.activation,
  } : null
}

function approvalParts(result: AgentRunResult) {
  return result.parts.flatMap(part => {
    if (part.state !== 'approval-requested'
      || typeof part.toolCallId !== 'string'
      || typeof part.toolName !== 'string') return []
    const approval = part.approval && typeof part.approval === 'object'
      ? part.approval as Record<string, unknown> : undefined
    if (typeof approval?.id !== 'string') return []
    return [{
      assistant: {
        type: 'tool-call', toolCallId: part.toolCallId,
        toolName: part.toolName, input: part.input ?? {},
      },
      call: {
        tool_call_id: part.toolCallId,
        tool_name: part.toolName,
        input_data: part.input ?? {},
        approval_id: approval.id,
        side_effecting: true,
      },
    }]
  })
}

function checkpointToolCalls(
  result: AgentRunResult,
  assistantContent: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const approvals = new Map(approvalParts(result).map(item => [item.call.tool_call_id, item.call]))
  const resultParts = new Map(result.parts.flatMap(part => (
    typeof part.toolCallId === 'string' ? [[part.toolCallId, part] as const] : []
  )))
  const calls: Array<Record<string, unknown>> = []
  for (const part of assistantContent) {
    if (part.type !== 'tool-call' || typeof part.toolCallId !== 'string') continue
    const approval = approvals.get(part.toolCallId)
    if (approval) {
      calls.push(approval)
      continue
    }
    const executed = resultParts.get(part.toolCallId)
    if (!executed || (executed.state !== 'output-available' && executed.state !== 'output-error')) {
      throw new Error(`Executed tool call ${part.toolCallId} has no captured result`)
    }
    calls.push({
      tool_call_id: part.toolCallId,
      tool_name: typeof part.toolName === 'string' ? part.toolName : String(executed.toolName ?? ''),
      input_data: part.input ?? executed.input ?? {},
      status: executed.state === 'output-error' ? 'failed' : 'succeeded',
      output_data: executed.output ?? null,
      ...(executed.state === 'output-error'
        ? { error_data: { message: String(executed.error ?? 'Tool execution failed') } }
        : {}),
      side_effecting: false,
    })
  }
  return calls
}

function canonicalAssistantContent(result: AgentRunResult) {
  const canonical = (result.assistantContent ?? []).filter(part => (
    part.type === 'reasoning' || part.type === 'text' || part.type === 'tool-call'
  ))
  const capturedCallIds = new Set(canonical.flatMap(part => (
    part.type === 'tool-call' && typeof part.toolCallId === 'string' ? [part.toolCallId] : []
  )))
  const missingCalls = result.parts.flatMap(part => {
    if (typeof part.toolCallId !== 'string' || capturedCallIds.has(part.toolCallId)
      || typeof part.toolName !== 'string') return []
    capturedCallIds.add(part.toolCallId)
    return [{
      type: 'tool-call', toolCallId: part.toolCallId,
      toolName: part.toolName, input: part.input ?? {},
    }]
  })
  return [...missingCalls, ...canonical]
}

function preparedFromCheckpoint(checkpoint: ChatRunCheckpoint): AgentPreparedRun {
  const prepared = checkpoint.run.validated_plan?.agent_prepared_run
  if (!prepared || typeof prepared !== 'object') {
    throw new Error('Chat Run checkpoint does not contain a prepared Agent run')
  }
  const hydrated = structuredClone(prepared) as unknown as AgentPreparedRun
  if (hydrated.skillRun?.run && Array.isArray(hydrated.skillRun.run.steps)
    && Array.isArray(hydrated.skillRun.run.toolEvidence)) {
    hydrated.skillRun.run = applyToolEvidence(
      hydrated.skillRun.run,
      checkpoint.tool_calls.map(call => ({
        type: 'dynamic-tool',
        toolCallId: call.tool_call_id,
        toolName: call.tool_name,
        state: call.status === 'succeeded'
          ? 'output-available'
          : call.status === 'failed' || call.status === 'outcome_unknown'
            ? 'output-error'
            : 'approval-requested',
      })),
    )
  }
  return hydrated
}

async function persistAgentResult(
  persistence: ChatRunPersistence,
  sessionId: number,
  runId: string,
  expectedVersion: number,
  result: AgentRunResult,
) {
  const approvals = approvalParts(result)
  if (result.kind === 'approval') {
    if (approvals.length !== 1) throw new Error('Approval result must contain exactly one pending tool call')
    const canonical = canonicalAssistantContent(result)
    const assistantContent = canonical.some(part => part.type === 'tool-call')
      ? canonical
      : approvals.map(item => item.assistant)
    await persistence.appendStep(sessionId, runId, {
      expected_version: expectedVersion,
      assistant_content: assistantContent,
      tool_calls: checkpointToolCalls(result, assistantContent),
      finish_reason: result.finishReason ?? 'tool-calls',
    })
    return
  }
  await persistence.appendStep(sessionId, runId, {
    expected_version: expectedVersion,
    assistant_content: result.text ? [{ type: 'text', text: result.text }] : [],
    tool_calls: [],
    finish_reason: result.finishReason ?? 'stop',
  })
}

export function createChatRunOrchestrator(
  dependencies: ChatRunOrchestratorDependencies,
) {
  const { persistence } = dependencies

  const projectRun = async (sessionId: number, runId: string) => (
    projectChatRun(await persistence.loadCheckpoint(sessionId, runId))
  )

  const startRun = async (input: StartChatRunInput): Promise<ChatRunProjection> => {
    const created = await persistence.createRun(input.sessionId, {
      user_message_id: input.userMessageId,
      objective: input.objective,
    })
    const runtime = await dependencies.openRuntime({ skillName: input.skillName })
    try {
      const prepared = await runtime.prepareRun({
        objective: input.objective,
        conversationContext: input.conversationContext,
        selectedContext: input.selectedContext,
      })
      const frozen = await persistence.freezePreparation(input.sessionId, created.id, {
        expected_version: created.checkpoint_version,
        skill_invocation: frozenSkillInvocation(prepared),
        validated_plan: { agent_prepared_run: prepared },
        capability_snapshot: prepared.capabilitySnapshot,
      })
      const result = await runtime.executePrepared({
        prepared, objective: input.objective, modelMessages: input.modelMessages,
        conversationContext: input.conversationContext, selectedContext: input.selectedContext,
        maxSteps: input.maxSteps,
      })
      await persistAgentResult(
        persistence, input.sessionId, created.id, frozen.checkpoint_version, result,
      )
      let checkpoint = await persistence.loadCheckpoint(input.sessionId, created.id)
      if (result.kind === 'completed') {
        await persistence.transitionRun(input.sessionId, created.id, {
          status: 'completed', expected_version: checkpoint.run.checkpoint_version,
        })
        checkpoint = await persistence.loadCheckpoint(input.sessionId, created.id)
      }
      return projectChatRun(checkpoint)
    } finally {
      await runtime.close()
    }
  }

  const resumeRun = async (input: ResumeChatRunInput): Promise<ChatRunProjection> => {
    const decision = await persistence.decideApproval(
      input.sessionId, input.runId, input.approvalId,
      { tool_call_id: input.toolCallId, approved: input.approved, reason: input.reason },
    )
    if (decision.decision === 'rejected' || decision.duplicate) {
      return projectRun(input.sessionId, input.runId)
    }
    const checkpoint = await persistence.loadCheckpoint(input.sessionId, input.runId)
    const toolCall = checkpoint.tool_calls.find(call => call.tool_call_id === input.toolCallId)
    if (!toolCall || toolCall.status !== 'approved') {
      throw new Error('Approved Chat Run tool call is missing from its checkpoint')
    }
    let output: unknown
    try {
      output = await dependencies.executeApprovedTool({ checkpoint, toolCall })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = toolCall.side_effecting ? 'outcome_unknown' : 'failed'
      await persistence.completeToolCall(input.sessionId, input.runId, input.toolCallId, {
        status, error_data: { message },
      })
      return projectRun(input.sessionId, input.runId)
    }
    await persistence.completeToolCall(input.sessionId, input.runId, input.toolCallId, {
      status: 'succeeded', output_data: output,
    })
    const afterResult = await persistence.loadCheckpoint(input.sessionId, input.runId)
    let runtime: RuntimeBoundary | undefined
    try {
      const prepared = preparedFromCheckpoint(afterResult)
      const modelMessages = buildCanonicalModelMessages(afterResult)
      const skillName = prepared.selectedSkill?.name
      runtime = await dependencies.openRuntime({ skillName })
      const result = await runtime.executePrepared({
        prepared,
        objective: afterResult.run.objective,
        modelMessages,
        maxSteps: input.maxSteps,
      })
      await persistAgentResult(
        persistence, input.sessionId, input.runId,
        afterResult.run.checkpoint_version, result,
      )
      let finalCheckpoint = await persistence.loadCheckpoint(input.sessionId, input.runId)
      if (result.kind === 'completed') {
        await persistence.transitionRun(input.sessionId, input.runId, {
          status: 'completed', expected_version: finalCheckpoint.run.checkpoint_version,
        })
        finalCheckpoint = await persistence.loadCheckpoint(input.sessionId, input.runId)
      }
      return projectChatRun(finalCheckpoint)
    } catch (error) {
      const current = await persistence.loadCheckpoint(input.sessionId, input.runId)
      await persistence.transitionRun(input.sessionId, input.runId, {
        status: 'failed', expected_version: current.run.checkpoint_version,
        error_data: { message: error instanceof Error ? error.message : String(error) },
      })
      return projectRun(input.sessionId, input.runId)
    } finally {
      await runtime?.close()
    }
  }

  return { startRun, resumeRun, projectRun }
}
