import { createOpenAI } from '@ai-sdk/openai'
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
import { appendAgentLogEvent, type AgentLogEventInput } from './agent-log-client'
import {
  agentSkillRunAudit,
  openAgentRuntime,
  type AgentRuntime,
  type OpenAgentRuntimeOptions,
} from './agent-runtime'
import { pinCapabilitySnapshot } from './agent-capabilities'
import {
  capabilityPinFromExecution,
  restoredSkillNameFromExecution,
} from './agent-capability-pin'
import { createDirectImageGenerator, mcpUrl } from './global-chat-tools'
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
  retryableForError,
  startStep,
  workerHeaders,
  type DurableJob,
} from './job-client'
import { textModelConfigFromSettings, type TextModelSettings } from './runtime-config'

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

export function firstBlockingToolAudit(audits: AgentToolAudit[]) {
  return audits.find((audit, index) => {
    if (audit.status === 'uncertain') return true
    if (audit.status !== 'failed') return false
    if (audit.sideEffecting) return true
    return !audits.slice(index + 1).some(later => (
      later.toolName === audit.toolName && later.status === 'succeeded'
    ))
  })
}

const agentRunEvidenceSchema = z.object({
  kind: z.literal('agent_run'),
  executionId: z.number().int().positive(),
  finalText: z.string().max(2_000),
  toolCallCount: z.number().int().nonnegative(),
})

type Model = OpenAgentRuntimeOptions['model']

export type DailyCreationAgentJobDependencies = {
  getJob(jobId: number): Promise<DurableJob>
  getContext(runId: number, jobId: number): Promise<DailyCreationAgentContext>
  loadModel(jobId: number): Promise<Model>
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
  openRuntime(options: OpenAgentRuntimeOptions): Promise<AgentRuntime>
  apiRoot(): string
}

function defaultApiRoot() {
  return apiBase()
}

async function configuredModel(jobId: number): Promise<Model> {
  const settings = await apiGet<TextModelSettings>(
    '/settings/ai-runtime', workerHeaders(jobId),
  )
  const runtime = textModelConfigFromSettings(settings)
  return createOpenAI({
    apiKey: runtime.apiKey,
    baseURL: runtime.baseURL,
  }).chat(runtime.modelName)
}

const defaultDependencies: DailyCreationAgentJobDependencies = {
  getJob,
  getContext: (runId, jobId) => apiGet(
    `/creation-rules/runs/${runId}/context`, workerHeaders(jobId),
  ),
  loadModel: configuredModel,
  ensureExecution: ensureAgentExecution,
  checkpointExecution: checkpointAgentExecution,
  appendMessage: appendAgentMessage,
  appendLogEvent: (jobId, event) => appendAgentLogEvent(event, jobId),
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
  openRuntime: openAgentRuntime,
  apiRoot: defaultApiRoot,
}

function completedStepEvidence(job: DurableJob) {
  const output = [...job.steps]
    .filter(step => step.key === 'agent' && step.status === 'succeeded')
    .sort((left, right) => right.attempt - left.attempt)[0]?.output
  const parsed = agentRunEvidenceSchema.safeParse(output)
  return parsed.success ? parsed.data : undefined
}

function durableExecutionEvidence(execution: DurableAgentExecution) {
  for (const candidate of [
    execution.completion_evidence,
    execution.checkpoint.evidence,
  ]) {
    const parsed = agentRunEvidenceSchema.safeParse(candidate)
    if (parsed.success && parsed.data.executionId === execution.id) return parsed.data
  }
  return undefined
}

const interruptedAfterSideEffects = 'scheduled Agent interrupted after side effects; review logs before retry'
const exhaustedWhileCallingTool = 'scheduled Agent exhausted 30 steps while requesting another tool call'

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
  let runtime: AgentRuntime | undefined
  let execution: DurableAgentExecution | undefined
  let pendingFinalizationEvidence: AgentCompletionEvidence | undefined
  let durableFinalizationConfirmed = false
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
  try {
    const context = await deps.getContext(runId, jobId)
    const objective = buildDailyCreationAgentObjective(context)
    executionRequest.objective = objective
    executionRequest.skillMode = context.rule.skill_mode ?? 'auto'
    executionRequest.skillName = executionRequest.skillMode === 'manual'
      ? context.rule.skill_name ?? null
      : null
    execution = await deps.ensureExecution(jobId, executionRequest)
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
    let capabilityPin = capabilityPinFromExecution(currentExecution())
    const allowSkillBootstrap = capabilityPin === undefined
    const withCapabilityAudit = (audit: Record<string, unknown>) => {
      if (!runtime) return audit
      const capabilities = runtime.capabilitySnapshot()
      capabilityPin = pinCapabilitySnapshot(
        capabilityPin,
        capabilities,
        { allowSkillBootstrap },
      )
      return { ...audit, capabilities, capabilityPin }
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
      await finalize(checkpointEvidence)
      return checkpointEvidence
    }
    const recordedCalls = await deps.listToolCalls(jobId, currentExecution().id)
    if (recordedCalls.some(call => (
      call.side_effecting
      && (call.status === 'running' || call.status === 'succeeded' || call.status === 'uncertain')
    ))) {
      throw new Error(interruptedAfterSideEffects)
    }
    const model = await deps.loadModel(jobId)
    const audits: AgentToolAudit[] = []

    const checkpoint = async (
      phase: string,
      state: Record<string, unknown>,
      audit: Record<string, unknown>,
    ) => {
      execution = await deps.checkpointExecution(
        jobId, currentExecution().id, currentExecution().version,
        { phase, checkpoint: state, audit, capabilityPin },
      )
    }

    const apiRoot = deps.apiRoot()
    runtime = await deps.openRuntime({
      mcpEndpoint: mcpUrl(apiRoot),
      imageGenerator: createDirectImageGenerator(apiRoot, jobId),
      model,
      mode: 'job',
      dailyCreationRunId: runId,
      policyProfile: 'scheduled',
      automaticSelection: false,
      skillMode: currentExecution().skill_mode,
      skillName: currentExecution().skill_name ?? undefined,
      restoredSkillName: restoredSkillNameFromExecution(currentExecution()),
      beforeToolExecute: async event => {
        const capabilities = runtime?.capabilitySnapshot()
        if (capabilities) {
          try {
            capabilityPin = pinCapabilitySnapshot(
              capabilityPin,
              capabilities,
              { allowSkillBootstrap },
            )
          } catch (error) {
            return {
              action: 'uncertain' as const,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }
        const decision = await deps.claimToolCall(jobId, currentExecution().id, event)
        return decision
      },
      onMessage: async event => {
        try {
          await deps.appendMessage?.(jobId, currentExecution().id, event)
        } catch {
          // Message logging is best effort and must not fail the content task.
        }
      },
      onToolAudit: async event => {
        audits.push(event)
        if (event.status === 'succeeded') {
          await deps.completeToolCall(
            jobId, currentExecution().id, event.toolCallId, event.output,
          )
        } else if (event.status === 'failed' || event.status === 'uncertain') {
          await deps.failToolCall(
            jobId, currentExecution().id, event.toolCallId,
            event.error || 'tool execution failed',
            event.status === 'uncertain' || event.sideEffecting,
          )
        }
      },
    })

    await recordExecutionEvent({
      event_type: 'skill/selected',
      phase: 'prepare',
      status: currentExecution().skill_name ? 'completed' : 'skipped',
      payload: {
        name: currentExecution().skill_name,
        activation: currentExecution().skill_activation || null,
      },
    })
    await recordExecutionEvent({
      event_type: 'session/capabilities',
      phase: 'prepare',
      status: 'completed',
      payload: { capabilitySnapshot: runtime.capabilitySnapshot() },
    })

    await checkpoint('prepared', { objective }, withCapabilityAudit({
      skill: runtime.snapshot(),
      toolCalls: audits,
    }))
    const result = await runtime.run({
      objective,
      modelMessages: [{ role: 'user', content: objective }],
      maxSteps: 30,
      onStep: event => checkpoint(event.phase, {
        objective,
        latestStep: event,
      }, withCapabilityAudit({
        skill: runtime?.snapshot(),
        toolCalls: audits,
      })),
    })
    const failedAudit = firstBlockingToolAudit(audits)
    if (failedAudit) {
      throw new Error(`Agent tool audit is ${failedAudit.status}: ${failedAudit.toolName}`)
    }
    if (result.finishReason === 'tool-calls' && (result.stepCount ?? 0) >= 30) {
      throw new Error(exhaustedWhileCallingTool)
    }
    const completionEvidence: AgentCompletionEvidence = {
      kind: 'agent_run',
      executionId: currentExecution().id,
      finalText: result.text.slice(0, 2_000),
      toolCallCount: audits.filter(audit => audit.status === 'succeeded').length,
    }
    pendingFinalizationEvidence = completionEvidence
    await checkpoint('finalizing', {
      objective,
      evidence: completionEvidence,
    }, withCapabilityAudit({
      skill: runtime.snapshot(),
      skillRun: agentSkillRunAudit(result),
      toolCalls: audits,
    }))
    durableFinalizationConfirmed = true
    await recordExecutionEvent({
      event_type: 'session/turn-end',
      phase: 'agent',
      status: 'completed',
      payload: {
        kind: result.kind,
        finishReason: result.finishReason ?? null,
        stepCount: result.stepCount ?? null,
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
    await recordExecutionEvent({
      event_type: 'session/error',
      phase: 'agent',
      status: 'error',
      payload: { error: message },
    })
    const deterministic = message.includes(interruptedAfterSideEffects)
      || message.includes('Selected skill is unavailable')
      || message.includes('Agent capability drift detected')
      || message.includes(exhaustedWhileCallingTool)
    if (!durableFinalizationConfirmed) {
      try {
        if (execution) await deps.failExecution(jobId, execution.id, message)
      } catch {
        // Preserve the original job failure if the auxiliary status update fails.
      }
      await deps.failStep(
        jobId, step.id, failure,
        deterministic ? false : retryableForError(failure, true),
      )
    }
    throw failure
  } finally {
    await runtime?.close()
  }
}
