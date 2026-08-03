import type {
  AgentCompletionEvidence,
  AgentSkillMode,
  AgentToolAudit,
  AgentToolDecision,
} from './agent-runtime-types'
import { apiGet, apiPatch, apiPost, workerHeaders } from './job-client'

export type DurableAgentExecution = {
  id: number
  job_id: number
  status: string
  objective: string
  skill_mode: AgentSkillMode
  skill_name: string | null
  skill_activation?: string | null
  phase: string
  checkpoint: Record<string, unknown>
  audit: Record<string, unknown>
  completion_evidence: Record<string, unknown>
  final_summary?: string
  version: number
  error?: string
}

export type AgentExecutionCheckpoint = {
  phase: string
  checkpoint: Record<string, unknown>
  audit: Record<string, unknown>
}

export type DurableAgentToolCall = {
  tool_call_id: string
  tool_name: string
  status: string
  input_summary?: Record<string, unknown>
  output?: unknown
  error?: string
  auto_approved?: boolean
  side_effecting?: boolean
}

function inputSummary(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value }
}

export function ensureAgentExecution(jobId: number, request: {
  objective: string
  skillMode: AgentSkillMode
  skillName?: string | null
}) {
  return apiPost<DurableAgentExecution>('/agent-executions', {
    job_id: jobId,
    objective: request.objective,
    skill_mode: request.skillMode,
    skill_name: request.skillName ?? null,
  }, workerHeaders(jobId))
}

export function getAgentExecutionByJob(jobId: number) {
  return apiGet<DurableAgentExecution>(
    `/agent-executions/by-job/${jobId}`,
    workerHeaders(jobId),
  )
}

export function listAgentToolCalls(jobId: number, executionId: number) {
  return apiGet<DurableAgentToolCall[]>(
    `/agent-executions/${executionId}/tool-calls`,
    workerHeaders(jobId),
  )
}

export function checkpointAgentExecution(
  jobId: number,
  executionId: number,
  expectedVersion: number,
  update: AgentExecutionCheckpoint,
) {
  return apiPatch<DurableAgentExecution>(
    `/agent-executions/${executionId}/checkpoint`,
    { expected_version: expectedVersion, ...update },
    workerHeaders(jobId),
  )
}

export function claimAgentToolCall(
  jobId: number,
  executionId: number,
  event: AgentToolAudit,
) {
  return apiPost<AgentToolDecision>(
    `/agent-executions/${executionId}/tool-calls/${encodeURIComponent(event.toolCallId)}/claim`,
    {
      tool_name: event.toolName,
      input_summary: inputSummary(event.inputSummary),
      auto_approved: event.autoApproved,
      side_effecting: event.sideEffecting,
    },
    workerHeaders(jobId),
  )
}

export function completeAgentToolCall(
  jobId: number,
  executionId: number,
  toolCallId: string,
  output: unknown,
) {
  return apiPost(
    `/agent-executions/${executionId}/tool-calls/${encodeURIComponent(toolCallId)}/succeed`,
    { output },
    workerHeaders(jobId),
  )
}

export function failAgentToolCall(
  jobId: number,
  executionId: number,
  toolCallId: string,
  error: string,
  uncertain: boolean,
) {
  return apiPost(
    `/agent-executions/${executionId}/tool-calls/${encodeURIComponent(toolCallId)}/fail`,
    { error, uncertain },
    workerHeaders(jobId),
  )
}

export function completeAgentExecution(
  jobId: number,
  executionId: number,
  evidence: AgentCompletionEvidence,
) {
  return apiPost<DurableAgentExecution>(
    `/agent-executions/${executionId}/complete`,
    { completion_evidence: evidence },
    workerHeaders(jobId),
  )
}
