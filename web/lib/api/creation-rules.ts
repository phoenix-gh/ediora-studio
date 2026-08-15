import { apiFetch } from './client'

export type DailyCreationRule = { id: number; name: string; prompt: string; asset_type: 'article' | 'media'; directory: string; directories?: string[]; output_type: 'x_short_post'; target_count: number; execution_mode: 'once' | 'recurring'; scheduled_date: string | null; scheduled_time: string; timezone: string; lookback_days: number; delivery_mode: 'drafts'; account_id: string | null; instructions: string; skill_mode: 'auto' | 'manual'; skill_name: string | null; enabled: boolean; last_run_at: string | null; next_run_at: string | null; created_at: string; updated_at: string }
export type DailyCreationRuleInput = Omit<DailyCreationRule, 'id' | 'created_at' | 'updated_at' | 'last_run_at' | 'next_run_at' | 'directories'> & { directories: string[] }
export type GenericAgentCompletion = { kind: 'agent_run'; executionId: number; finalText: string; toolCallCount: number; createdCount?: never }
export type HistoricalAgentCompletion = { toolName?: string; createdCount?: number; outputIds?: number[]; kind?: never }
export type DailyCreationAgentExecution = { status: string; phase: string; skill_name: string | null; skill_activation: string; loaded_references: Array<{ path: string; bytes: number }>; tools: Array<{ tool_name: string; status: string; auto_approved: boolean; occurred_at: string; error: string }>; self_validation: Record<string, unknown>; completion: GenericAgentCompletion | HistoricalAgentCompletion | null }
export type AgentMessageLog = { id: number; execution_id: number; phase: string; direction: 'model_request' | 'model_response' | 'model_error'; payload: unknown; created_at: string | null }
export type AgentToolLog = { id: number; tool_call_id: string; tool_name: string; status: string; auto_approved: boolean; side_effecting: boolean; input_summary: unknown; output: unknown; error: string; started_at: string | null; completed_at: string | null }
export type DailyCreationAgentLog = { execution: { id: number; job_id: number; status: string; objective: string; phase: string; error: string; created_at: string | null; updated_at: string | null; completed_at: string | null } | null; messages: AgentMessageLog[]; tools: AgentToolLog[] }
export type DailyCreationRun = { id: number; rule_id: number; content_job_id: number | null; scheduled_for: string; trigger_kind: string; status: 'queued' | 'running' | 'failed' | 'partial' | 'succeeded' | 'cancelled'; requested_count: number; created_count: number; detail: Record<string, unknown>; rule: Partial<DailyCreationRule>; created_at: string; agent_execution?: DailyCreationAgentExecution | null }
export type CreationDashboardSummary = { enabled_rules: number; scheduled_runs: number; queued: number; running: number; succeeded: number; partial: number; failed: number; cancelled: number; next_run_at: string | null }
export type CreationDashboardStep = { key: string; attempt: number; status: string; started_at: string | null; completed_at: string | null; error: string }
export type CreationDashboardEvent = { kind: string; payload: Record<string, unknown>; created_at: string | null }
export type CreationDashboardJob = { id: number; status: string; started_at: string | null; completed_at: string | null; steps: CreationDashboardStep[]; events: CreationDashboardEvent[] }
export type CreationDashboardRun = DailyCreationRun & { job: CreationDashboardJob | null }
export type CreationSchedulerLog = { status: string; message: string; detail: string; created_at: string | null }
export type CreationDashboard = { date: string; summary: CreationDashboardSummary; rules: DailyCreationRule[]; runs: CreationDashboardRun[]; scheduler_logs: CreationSchedulerLog[] }
export const listCreationRules = () => apiFetch<DailyCreationRule[]>('/creation-rules')
export const createCreationRule = (input: DailyCreationRuleInput) => apiFetch<DailyCreationRule>('/creation-rules', { method: 'POST', body: JSON.stringify(input) })
export const updateCreationRule = (id: number, input: Partial<DailyCreationRuleInput>) => apiFetch<DailyCreationRule>(`/creation-rules/${id}`, { method: 'PATCH', body: JSON.stringify(input) })
export const deleteCreationRule = (id: number) => apiFetch<void>(`/creation-rules/${id}`, { method: 'DELETE' })
export const runCreationRule = (id: number) => apiFetch<DailyCreationRun>(`/creation-rules/${id}/run`, { method: 'POST' })
export const listCreationRuns = () => apiFetch<DailyCreationRun[]>('/creation-rules/runs')
export const getCreationRunAgentLog = (runId: number) => apiFetch<DailyCreationAgentLog>(`/creation-rules/runs/${runId}/agent-log`)
export const getCreationDashboard = (date?: string, limit = 50) => {
  const params = new URLSearchParams({ limit: String(limit) })
  if (date) params.set('date', date)
  return apiFetch<CreationDashboard>(`/creation-rules/dashboard?${params.toString()}`)
}
