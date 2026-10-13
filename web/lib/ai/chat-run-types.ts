export type ChatRunStatus =
  | 'preparing'
  | 'running'
  | 'waiting_approval'
  | 'resuming'
  | 'completed'
  | 'failed'
  | 'needs_reconciliation'

export type ChatRunRecord = {
  id: string
  session_id: number
  user_message_id: number
  assistant_message_id: number | null
  status: ChatRunStatus
  objective: string
  skill_invocation: Record<string, unknown> | null
  validated_plan: Record<string, unknown> | null
  capability_snapshot: Record<string, unknown> | null
  current_step: number
  checkpoint_version: number
  error_data: Record<string, unknown> | null
}

export type ChatRunStepCheckpoint = {
  id: number
  run_id: string
  ordinal: number
  status: 'running' | 'waiting_approval' | 'completed' | 'failed'
  assistant_content: Array<Record<string, unknown>>
  finish_reason: string | null
  usage_data: Record<string, unknown> | null
}

export type ChatRunToolCallCheckpoint = {
  id: number
  run_id: string
  step_id: number
  tool_call_id: string
  tool_name: string
  input_data: Record<string, unknown>
  status: 'pending_approval' | 'approved' | 'rejected' | 'executing' |
    'succeeded' | 'failed' | 'outcome_unknown'
  approval_id: string | null
  approval_decision: Record<string, unknown> | null
  output_data: unknown
  error_data: Record<string, unknown> | null
  side_effecting: boolean
  replay_policy: string
  concurrency_policy: string
  idempotency_key: string
  tool_version: string
  contract_digest: string
}

export type ChatRunCheckpoint = {
  run: ChatRunRecord
  steps: ChatRunStepCheckpoint[]
  tool_calls: ChatRunToolCallCheckpoint[]
}

export type ChatRunApproval = {
  runId: string
  approvalId: string
  toolCallId: string
  approved: boolean
  reason?: string
}

export type PersistedArtifact = {
  kind: 'draft'
  id: number
  title?: string
  url: string
}
