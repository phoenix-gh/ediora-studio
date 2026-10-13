import { z } from 'zod'

import {
  checkpointAgentExecution,
  claimAgentToolCall,
  completeAgentExecution,
  completeAgentToolCall,
  ensureAgentExecution,
  appendAgentMessage,
  failAgentExecution,
  failAgentToolCall,
  listAgentToolCalls,
  type AgentExecutionCheckpoint,
  type DurableAgentToolCall,
  type DurableAgentExecution,
} from './agent-execution-client'
import {
  appendAgentLogEvent,
  appendAgentSessionEvent,
  type AgentLogEventInput,
  type AgentSessionEventInput,
} from './agent-log-client'
import {
  type AgentSessionEventDraft,
} from './agent-runtime'
import { CODEX_THREAD_CWD } from './codex-app-server'
import { codexThreadTurnOptions } from './codex-thread'
import {
  runCodexAgentTurn,
  type RunCodexAgentTurnOptions,
  type CodexAgentTurnResult,
} from './codex-app-server-client'
import { createCodexSessionRecorder } from './codex-session-log'
import { usableCodexModel, usableCodexReasoningEffort } from './codex-model'
import { configuredCodexTurn, loadConfiguredCodexTurn } from './codex-settings'
import { scheduledEdioraMcpServers } from './ediora-mcp'
import {
  blockedGoalError,
  buildRuntimeGoalEvidence,
  completeGoalInputSchema,
  goalCompletionFromToolOutput,
  normalizeGoalCompletionDeclaration,
  runtimeGoalEvidenceSchema,
} from './agent-goal-completion'
import { recordJobEvent } from './image-generation'
import type {
  AgentCompletionEvidence,
  AgentModelMessageEvent,
  AgentToolAudit,
  AgentToolDecision,
} from './agent-runtime-types'
import {
  apiGet,
  apiBase,
  completeJob,
  completeStep,
  failStep,
  getJob,
  rememberJobCodexThread,
  retryableForError,
  startStep,
  workerHeaders,
  type DurableJob,
} from './job-client'


export type DailyCreationAgentContext = {
  id: number
  status: string
  requested_count: number
  rule: {
    name: string
    prompt: string
    asset_type?: 'article' | 'media'
    directory?: string
    directories?: string[]
    output_type?: 'x_short_post'
    target_count?: number
    lookback_days?: number
    delivery_mode?: 'drafts'
    account_id?: string | null
    instructions?: string
    skill_mode?: 'auto' | 'manual'
    skill_name?: string | null
    codex_model?: string | null
    codex_reasoning_effort?: string | null
  }
}

type ObjectiveContext = {
  rule: Pick<DailyCreationAgentContext['rule'], 'prompt'>
}

export function buildDailyCreationAgentObjective(context: ObjectiveContext) {
  const prompt = context.rule.prompt.trim()
  if (!prompt) throw new Error('scheduled Agent prompt is blank')
  return prompt
}

type BlockingAuditOptions = {
  allowReadOnlyFailures?: boolean
}

export function firstBlockingToolAudit(
  audits: AgentToolAudit[],
  options: BlockingAuditOptions = {},
) {
  return audits.find((audit, index) => {
    if (audit.status === 'uncertain') return true
    if (audit.status !== 'failed') return false
    if (audit.sideEffecting) return true
    if (options.allowReadOnlyFailures) return false
    return !audits.slice(index + 1).some(later => (
      later.toolName === audit.toolName && later.status === 'succeeded'
    ))
  })
}

function structuredToolOutput(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const direct = value as Record<string, unknown>
  if ('saved' in direct) return direct
  if (direct.structuredContent !== undefined) {
    const structured = direct.structuredContent
    if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
      const record = structured as Record<string, unknown>
      return structuredToolOutput(record.result ?? record)
    }
  }
  if (direct.result !== undefined) return structuredToolOutput(direct.result)
  const content = Array.isArray(direct.content) ? direct.content : []
  const textPart = content.find(item => (
    item && typeof item === 'object'
    && (item as Record<string, unknown>).type === 'text'
    && typeof (item as Record<string, unknown>).text === 'string'
  )) as Record<string, unknown> | undefined
  if (!textPart) return undefined
  try {
    const parsed = JSON.parse(String(textPart.text))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function isNoveltySaveConflictResult(
  toolName: string, status: string, rawOutput: unknown,
) {
  if (toolName !== 'save_draft' || status !== 'succeeded') return false
  const output = structuredToolOutput(rawOutput)
  const novelty = output?.novelty
  const decision = novelty && typeof novelty === 'object' && !Array.isArray(novelty)
    ? String((novelty as Record<string, unknown>).decision ?? '')
    : ''
  return output?.saved === false && ['duplicate', 'uncertain'].includes(decision)
}

export function isNoveltySaveConflict(audit: AgentToolAudit) {
  return isNoveltySaveConflictResult(audit.toolName, audit.status, audit.output)
}

const TIMELINE_CODEX_METHODS = new Set([
  'thread/started',
  'turn/started',
  'turn/completed',
  'turn/failed',
  'turn/cancelled',
  'warning',
  'error',
])

const TIMELINE_TOOL_ITEM_TYPES = new Set([
  'mcpToolCall',
  'McpToolCall',
  'commandExecution',
  'CommandExecution',
])

function timelineText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : ''
}

export function jobTimelineActivity(
  notification: { method: string; params?: Record<string, unknown> },
): { activity: string; payload: Record<string, unknown> } | null {
  if (TIMELINE_CODEX_METHODS.has(notification.method)) {
    return { activity: 'codex', payload: { method: notification.method } }
  }
  if (notification.method !== 'item/completed') return null
  const item = notification.params?.item
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const record = item as Record<string, unknown>
  const itemType = timelineText(record.type)
  if (!TIMELINE_TOOL_ITEM_TYPES.has(itemType)) return null
  const tool = timelineText(record.tool) || timelineText(record.command)
  const server = timelineText(record.server)
  const status = timelineText(record.status)
  return {
    activity: 'tool',
    payload: {
      method: 'item/completed',
      itemType,
      ...(tool ? { tool } : {}),
      ...(server ? { server } : {}),
      ...(status ? { status } : {}),
    },
  }
}

export function startAgentActivityHeartbeat(
  onHeartbeat: () => void | Promise<void>,
  intervalMs = 15_000,
) {
  const timer = setInterval(() => {
    void Promise.resolve()
      .then(onHeartbeat)
      .catch(() => {
        // Activity reporting is best effort and must never keep a worker alive.
      })
  }, intervalMs)
  return () => clearInterval(timer)
}

const agentRunEvidenceSchema = z.object({
  kind: z.literal('agent_run'),
  executionId: z.number().int().positive(),
  finalText: z.string().max(2_000),
  toolCallCount: z.number().int().nonnegative(),
  goalCompletion: completeGoalInputSchema,
  runtimeEvidence: runtimeGoalEvidenceSchema.optional(),
})

function firstBlockingRecordedCall(
  calls: DurableAgentToolCall[],
  options: BlockingAuditOptions = {},
) {
  return calls.find((call, index) => {
    if (call.status === 'uncertain') return true
    if (call.status !== 'failed') return false
    if (call.side_effecting) return true
    if (options.allowReadOnlyFailures) return false
    return !calls.slice(index + 1).some(later => (
      later.tool_name === call.tool_name && later.status === 'succeeded'
    ))
  })
}

function successfulBusinessToolCallCount(calls: Array<{
  toolName: string
  status: string
}>) {
  return calls.filter(call => (
    call.status === 'succeeded' && call.toolName !== 'complete_goal'
  )).length
}

export type DailyCreationAgentJobDependencies = {
  getJob(jobId: number): Promise<DurableJob>
  getContext(runId: number, jobId: number): Promise<DailyCreationAgentContext>
  ensureExecution(jobId: number, request: {
    objective: string
    skillMode: 'auto' | 'manual'
    skillName: string | null
  }): Promise<DurableAgentExecution>
  checkpointExecution(
    jobId: number, executionId: number, expectedVersion: number,
    update: AgentExecutionCheckpoint,
  ): Promise<DurableAgentExecution>
  appendMessage?(jobId: number, executionId: number, event: AgentModelMessageEvent): Promise<unknown>
  appendLogEvent?(jobId: number, event: AgentLogEventInput): Promise<unknown>
  appendSessionEvent?(jobId: number, executionId: number, event: AgentSessionEventInput): Promise<unknown>
  recordJobEvent?(jobId: number, kind: string, payload: Record<string, unknown>): Promise<unknown>
  claimToolCall(
    jobId: number, executionId: number, event: AgentToolAudit,
  ): Promise<AgentToolDecision>
  listToolCalls(jobId: number, executionId: number): Promise<DurableAgentToolCall[]>
  completeToolCall(jobId: number, executionId: number, toolCallId: string, output: unknown): Promise<unknown>
  failToolCall(jobId: number, executionId: number, toolCallId: string, error: string, uncertain: boolean): Promise<unknown>
  completeExecution(jobId: number, executionId: number, evidence: AgentCompletionEvidence): Promise<unknown>
  failExecution(jobId: number, executionId: number, error: string): Promise<unknown>
  startStep(jobId: number, key: string): Promise<{ id: number; attempt: number }>
  completeStep(jobId: number, stepId: number, output: Record<string, unknown>): Promise<unknown>
  failStep(jobId: number, stepId: number, error: unknown, retryable: boolean): Promise<unknown>
  completeJob(jobId: number): Promise<unknown>
  runAgentTurn(options: RunCodexAgentTurnOptions): Promise<CodexAgentTurnResult>
  rememberCodexThread?(jobId: number, threadId: string): Promise<unknown>
  apiRoot(): string
  codexTurn?(apiRoot: string): Promise<{ model?: string, reasoningEffort?: string }>
}

function defaultApiRoot() {
  return apiBase()
}

const defaultDependencies: DailyCreationAgentJobDependencies = {
  getJob,
  getContext: (runId, jobId) => apiGet(
    `/creation-rules/runs/${runId}/context`, workerHeaders(jobId),
  ),
  ensureExecution: ensureAgentExecution,
  checkpointExecution: checkpointAgentExecution,
  appendMessage: appendAgentMessage,
  appendLogEvent: (jobId, event) => appendAgentLogEvent(event, jobId),
  appendSessionEvent: (jobId, executionId, event) => appendAgentSessionEvent(event, jobId),
  recordJobEvent,
  claimToolCall: claimAgentToolCall,
  listToolCalls: listAgentToolCalls,
  completeToolCall: completeAgentToolCall,
  failToolCall: failAgentToolCall,
  completeExecution: completeAgentExecution,
  failExecution: failAgentExecution,
  startStep,
  completeStep,
  failStep,
  completeJob,
  runAgentTurn: runCodexAgentTurn,
  rememberCodexThread: rememberJobCodexThread,
  apiRoot: defaultApiRoot,
  codexTurn: loadConfiguredCodexTurn,
}

function parseAgentRunEvidence(value: unknown): AgentCompletionEvidence | undefined {
  const parsed = agentRunEvidenceSchema.safeParse(value)
  if (!parsed.success) return undefined
  const goalCompletion = normalizeGoalCompletionDeclaration(parsed.data.goalCompletion)
  if (!goalCompletion) return undefined
  return {
    ...parsed.data,
    goalCompletion,
  }
}

function completedStepEvidence(job: DurableJob) {
  const output = [...job.steps]
    .filter(step => step.key === 'agent' && step.status === 'succeeded')
    .sort((left, right) => right.attempt - left.attempt)[0]?.output
  return parseAgentRunEvidence(output)
}

function durableExecutionEvidence(execution: DurableAgentExecution) {
  for (const candidate of [
    execution.completion_evidence,
    execution.checkpoint.evidence,
  ]) {
    const parsed = parseAgentRunEvidence(candidate)
    if (parsed && 'kind' in parsed && parsed.kind === 'agent_run' && parsed.executionId === execution.id) {
      return parsed
    }
  }
  return undefined
}

const interruptedAfterSideEffects = 'scheduled Agent interrupted after side effects; review logs before retry'

export async function runDailyCreationAgentJob(
  jobId: number,
  deps: DailyCreationAgentJobDependencies = defaultDependencies,
): Promise<AgentCompletionEvidence> {
  const job = await deps.getJob(jobId)
  const previousEvidence = completedStepEvidence(job)
  if (previousEvidence) {
    if (job.status !== 'succeeded') await deps.completeJob(jobId)
    return previousEvidence
  }
  if (job.status === 'succeeded' || job.status === 'cancelled') {
    throw new Error(`daily creation Agent job is terminal without completion evidence: ${job.status}`)
  }
  const runId = Number(job.input.run_id)
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error('daily_creation agent flow requires run_id')
  }

  const runningStep = [...job.steps]
    .filter(item => item.key === 'agent' && item.status === 'running' && item.id)
    .sort((left, right) => right.attempt - left.attempt)[0]
  const step = runningStep?.id
    ? { id: runningStep.id, attempt: runningStep.attempt }
    : await deps.startStep(jobId, 'agent')
  let execution: DurableAgentExecution | undefined
  let pendingFinalizationEvidence: AgentCompletionEvidence | undefined
  let durableFinalizationConfirmed = false
  let canonicalTurnStarted = false
  let canonicalTurnEnded = false
  const canonicalTurn = step.attempt
  const executionRequest: {
    objective: string
    skillMode: 'auto' | 'manual'
    skillName: string | null
  } = {
    objective: '', skillMode: 'auto' as const, skillName: null,
  }
  const recordExecutionEvent = async (
    event: Omit<AgentLogEventInput, 'stream_kind' | 'stream_key' | 'job_id' | 'execution_id'>,
  ) => {
    if (!execution) return
    try {
      await deps.appendLogEvent?.(jobId, {
        stream_kind: 'job',
        stream_key: `execution:${execution.id}`,
        job_id: jobId,
        execution_id: execution.id,
        ...event,
      })
    } catch {
      // Event logging is durable when available but never blocks the job boundary.
    }
  }
  const recordJobActivity = (
    activity: string,
    payload: Record<string, unknown> = {},
  ) => {
    try {
      const pending = deps.recordJobEvent?.(jobId, 'agent_activity', {
        ...payload,
        activity,
        execution_id: execution?.id ?? null,
      })
      void pending?.catch(() => {
        // Job activity is observability only and must never fail the Agent run.
      })
    } catch {
      // Job activity is observability only and must never fail the Agent run.
    }
  }
  const recordSessionEvent = async (event: AgentSessionEventDraft) => {
    if (!execution) return
    await deps.appendSessionEvent?.(jobId, execution.id, {
      stream_kind: 'job',
      stream_key: `execution:${execution.id}`,
      job_id: jobId,
      execution_id: execution.id,
      turn_id: `execution:${execution.id}:turn:${event.turn ?? 1}`,
      step_id: event.step === null ? null : String(event.step),
      type: event.type,
      data: event.data,
    })
  }
  const finishCanonicalTurn = async (reason: Record<string, unknown>) => {
    if (!canonicalTurnStarted || canonicalTurnEnded || !execution) return
    await recordSessionEvent({
      type: 'turn/end',
      turn: canonicalTurn,
      step: null,
      data: { reason },
    })
    canonicalTurnEnded = true
  }
  try {
    const context = await deps.getContext(runId, jobId)
    const objective = buildDailyCreationAgentObjective(context)
    executionRequest.objective = objective
    executionRequest.skillMode = context.rule.skill_mode ?? 'auto'
    executionRequest.skillName = executionRequest.skillMode === 'manual'
      ? context.rule.skill_name ?? null
      : null
    execution = await deps.ensureExecution(jobId, executionRequest)
    await recordSessionEvent({
      type: 'turn/start',
      turn: canonicalTurn,
      step: null,
      data: { turn: canonicalTurn },
    })
    canonicalTurnStarted = true
    await recordSessionEvent({
      type: 'user/message',
      turn: canonicalTurn,
      step: null,
      data: {
        content: [{ kind: 'text', text: objective }],
        source: { kind: 'job' },
      },
    })
    await recordExecutionEvent({
      event_type: 'session/turn-start',
      phase: 'agent',
      status: 'running',
      payload: { objective, flow: 'daily_creation' },
    })
    const currentExecution = () => {
      if (!execution) throw new Error('daily creation Agent execution was not initialized')
      return execution
    }
    const finalize = async (evidence: AgentCompletionEvidence) => {
      if (currentExecution().status !== 'succeeded') {
        await deps.completeExecution(jobId, currentExecution().id, evidence)
      }
      await deps.completeStep(jobId, step.id, evidence)
      await deps.completeJob(jobId)
    }
    const checkpointEvidence = durableExecutionEvidence(currentExecution())
    if (checkpointEvidence) {
      pendingFinalizationEvidence = checkpointEvidence
      durableFinalizationConfirmed = true
      await finishCanonicalTurn({ kind: 'completed' })
      await finalize(checkpointEvidence)
      return checkpointEvidence
    }
    const recordedCalls = await deps.listToolCalls(jobId, currentExecution().id)
    const recordedNoveltyConflictCount = recordedCalls.filter(call => (
      isNoveltySaveConflictResult(call.tool_name, call.status, call.output)
    )).length
    if (recordedNoveltyConflictCount >= 3) {
      throw new Error(
        'no sufficiently novel topic was available in the configured time window',
      )
    }
    const recordedEvidenceCalls = recordedCalls.map(call => ({
      toolCallId: call.tool_call_id,
      toolName: call.tool_name,
      status: call.status,
      sideEffecting: call.side_effecting ?? false,
    }))
    const recordedGoalCall = [...recordedCalls].reverse().find(call => (
      call.status === 'succeeded' && call.tool_name === 'complete_goal'
    ))
    const recordedGoalDeclaration = recordedGoalCall
      ? goalCompletionFromToolOutput(recordedGoalCall.output)
      : undefined
    const failedRecordedCall = firstBlockingRecordedCall(recordedCalls, {
      allowReadOnlyFailures: recordedGoalDeclaration?.status === 'completed',
    })
    if (failedRecordedCall) {
      if (failedRecordedCall.side_effecting) {
        throw new Error(interruptedAfterSideEffects)
      }
      throw new Error(
        `Agent tool audit is ${failedRecordedCall.status}: ${failedRecordedCall.tool_name}`,
      )
    }
    if (recordedCalls.some(call => (
      call.side_effecting
      && (call.status === 'running' || call.status === 'uncertain')
    ))) {
      throw new Error(interruptedAfterSideEffects)
    }
    if (recordedGoalCall) {
      const declaration = recordedGoalDeclaration
      if (!declaration) throw new Error('Recorded complete_goal result has no valid declaration')
      if (declaration.status === 'blocked') throw blockedGoalError(declaration)
      const recoveredEvidence: AgentCompletionEvidence = {
        kind: 'agent_run',
        executionId: currentExecution().id,
        finalText: declaration.summary.slice(0, 2_000),
        toolCallCount: successfulBusinessToolCallCount(recordedEvidenceCalls),
        goalCompletion: declaration,
        runtimeEvidence: buildRuntimeGoalEvidence(recordedEvidenceCalls, declaration.outputs),
      }
      pendingFinalizationEvidence = recoveredEvidence
      await finishCanonicalTurn({ kind: 'completed', recovered: true })
      await finalize(recoveredEvidence)
      return recoveredEvidence
    }
    if (recordedCalls.some(call => (
      call.side_effecting && call.status === 'succeeded'
      && !isNoveltySaveConflictResult(call.tool_name, call.status, call.output)
    ))) {
      throw new Error(interruptedAfterSideEffects)
    }
    const checkpoint = async (
      phase: string,
      state: Record<string, unknown>,
      audit: Record<string, unknown> = {},
    ) => {
      execution = await deps.checkpointExecution(
        jobId, currentExecution().id, currentExecution().version,
        { phase, checkpoint: state, audit },
      )
    }

    await recordExecutionEvent({
      event_type: 'skill/selected',
      phase: 'prepare',
      status: currentExecution().skill_name ? 'completed' : 'skipped',
      payload: {
        name: currentExecution().skill_name,
        activation: currentExecution().skill_activation || null,
      },
    })
    await recordSessionEvent({
      type: 'agent/skill',
      turn: canonicalTurn,
      step: null,
      data: {
        name: currentExecution().skill_name ?? 'none',
        activation: currentExecution().skill_activation ?? 'automatic',
        metadata: { selected: Boolean(currentExecution().skill_name) },
      },
    })
    await recordExecutionEvent({
      event_type: 'session/capabilities',
      phase: 'prepare',
      status: 'completed',
      payload: { agent: 'codex-app-server' },
    })

    await checkpoint('prepared', { objective }, { agent: 'codex-app-server' })
    let sessionWrites = Promise.resolve()
    const sessionEvents = createCodexSessionRecorder()
    const recordCodexSession = (notification: { method: string; params?: Record<string, unknown> }) => {
      sessionWrites = sessionWrites.then(async () => {
        for (const event of sessionEvents(notification, { turn: canonicalTurn, step: 1 })) {
          await recordSessionEvent(event)
        }
      }).catch(() => undefined)
    }
    const ruleModel = usableCodexModel(context.rule.codex_model)
    const ruleEffort = usableCodexReasoningEffort(context.rule.codex_reasoning_effort)
    const settings: { model?: string, reasoningEffort?: string } = ruleModel && ruleEffort
      ? {}
      : await configuredCodexTurn(deps)
    const model = ruleModel ?? settings.model
    const reasoningEffort = ruleEffort ?? settings.reasoningEffort
    const threadJob = await deps.getJob(jobId)
    const result: CodexAgentTurnResult = await deps.runAgentTurn({
      input: objective,
      ...codexThreadTurnOptions(
        threadJob.codex_thread_id,
        threadId => deps.rememberCodexThread?.(jobId, threadId) ?? Promise.resolve(),
      ),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      cwd: CODEX_THREAD_CWD,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      mcpServers: scheduledEdioraMcpServers(runId),
      onNotification: notification => {
        const activity = jobTimelineActivity(notification)
        if (activity) recordJobActivity(activity.activity, activity.payload)
        recordCodexSession(notification)
      },
    })
    await sessionWrites
    const summary = (result.text.trim() || '既定目标已经完成').slice(0, 2_000)
    const completionEvidence: AgentCompletionEvidence = {
      kind: 'agent_run',
      executionId: currentExecution().id,
      finalText: summary,
      toolCallCount: result.items.filter(item => (
        item.type === 'mcpToolCall' || item.type === 'commandExecution'
      )).length,
      goalCompletion: {
        status: 'completed',
        summary,
      },
    }
    pendingFinalizationEvidence = completionEvidence
    await checkpoint('finalizing', {
      objective,
      evidence: completionEvidence,
      goalCompletion: completionEvidence.goalCompletion,
      threadId: result.threadId,
    }, { agent: 'codex-app-server', threadId: result.threadId })
    durableFinalizationConfirmed = true
    await finishCanonicalTurn({ kind: 'completed' })
    await recordExecutionEvent({
      event_type: 'session/turn-end',
      phase: 'agent',
      status: 'completed',
      payload: {
        kind: 'completed',
        threadId: result.threadId,
        turnId: result.turnId,
      },
    })
    await finalize(completionEvidence)
    return completionEvidence
  } catch (error) {
    let failure = error
    if (execution && pendingFinalizationEvidence && executionRequest.objective) {
      try {
        execution = await deps.ensureExecution(jobId, executionRequest)
        const evidence = durableExecutionEvidence(execution)
        if (evidence) {
          durableFinalizationConfirmed = true
          if (execution.status !== 'succeeded') {
            await deps.completeExecution(jobId, execution.id, evidence)
          }
          await deps.completeStep(jobId, step.id, evidence)
          await deps.completeJob(jobId)
          return evidence
        }
      } catch (recoveryError) {
        failure = recoveryError
      }
    }
    const message = failure instanceof Error ? failure.message : String(failure)
    let failureMessage = message
    try {
      await finishCanonicalTurn({ kind: 'error', error: message })
    } catch (trajectoryError) {
      const trajectoryMessage = trajectoryError instanceof Error ? trajectoryError.message : String(trajectoryError)
      failureMessage = `${message}; Agent trajectory finalization failed: ${trajectoryMessage}`
    }
    await recordExecutionEvent({
      event_type: 'session/error',
      phase: 'agent',
      status: 'error',
      payload: { error: failureMessage },
    })
    const deterministic = failureMessage.includes(interruptedAfterSideEffects)
      || failureMessage.includes('Selected skill is unavailable')
      || failureMessage.includes('Agent capability drift detected')
      || failureMessage.includes('Agent blocked:')
      || failureMessage.includes(
        'no sufficiently novel topic was available in the configured time window',
      )
    if (!durableFinalizationConfirmed) {
      try {
        if (execution) await deps.failExecution(jobId, execution.id, failureMessage)
      } catch {
        // Preserve the original job failure if the auxiliary status update fails.
      }
      await deps.failStep(
        jobId, step.id, new Error(failureMessage),
        deterministic ? false : retryableForError(failure, true),
      )
    }
    throw failure
  }
}
