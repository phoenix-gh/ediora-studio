import { apiBase, workerHeaders } from '../ai/job-client'
import type {
  ChatRunCheckpoint,
  ChatRunRecord,
  ChatRunStepCheckpoint,
  ChatRunToolCallCheckpoint,
} from '../ai/chat-run-types'

export class ChatRunApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly detail: unknown,
  ) {
    super(message)
    this.name = 'ChatRunApiError'
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    cache: init.cache ?? 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...workerHeaders(),
      ...init.headers,
    },
  })
  if (!response.ok) {
    let detail: unknown = ''
    try {
      detail = (await response.json() as { detail?: unknown }).detail ?? ''
    } catch {
      // Keep the HTTP status as canonical evidence for non-JSON failures.
    }
    const message = typeof detail === 'string' && detail
      ? detail
      : `Chat Run request failed (${response.status})`
    throw new ChatRunApiError(message, response.status, response.status !== 409, detail)
  }
  return response.json() as Promise<T>
}

const runPath = (sessionId: number, runId?: string) => (
  `/chat/sessions/${sessionId}/runs${runId ? `/${encodeURIComponent(runId)}` : ''}`
)

export function createChatRun(
  sessionId: number,
  input: { user_message_id: number; objective: string },
) {
  return request<ChatRunRecord>(runPath(sessionId), {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function freezeChatRunPreparation(
  sessionId: number,
  runId: string,
  input: {
    expected_version: number
    skill_invocation: Record<string, unknown> | null
    validated_plan: Record<string, unknown> | null
    capability_snapshot: Record<string, unknown>
  },
) {
  return request<ChatRunRecord>(`${runPath(sessionId, runId)}/preparation`, {
    method: 'PUT', body: JSON.stringify(input),
  })
}

export function appendChatRunStep(
  sessionId: number,
  runId: string,
  input: {
    expected_version: number
    assistant_content: Array<Record<string, unknown>>
    tool_calls: Array<Record<string, unknown>>
    finish_reason?: string
    usage_data?: Record<string, unknown>
  },
) {
  return request<ChatRunStepCheckpoint>(`${runPath(sessionId, runId)}/steps`, {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function loadChatRunCheckpoint(sessionId: number, runId: string) {
  return request<ChatRunCheckpoint>(runPath(sessionId, runId))
}

export function decideChatRunApproval(
  sessionId: number,
  runId: string,
  approvalId: string,
  input: { tool_call_id: string; approved: boolean; reason?: string },
) {
  return request<{
    run_id: string
    tool_call_id: string
    decision: 'approved' | 'rejected'
    duplicate: boolean
    run_status: string
    checkpoint_version: number
  }>(`${runPath(sessionId, runId)}/approvals/${encodeURIComponent(approvalId)}`, {
    method: 'POST', body: JSON.stringify(input),
  })
}

export function completeChatRunToolCall(
  sessionId: number,
  runId: string,
  toolCallId: string,
  input: {
    status: 'succeeded' | 'failed' | 'outcome_unknown'
    output_data?: unknown
    error_data?: Record<string, unknown>
  },
) {
  return request<ChatRunToolCallCheckpoint>(
    `${runPath(sessionId, runId)}/tool-calls/${encodeURIComponent(toolCallId)}/result`,
    { method: 'PUT', body: JSON.stringify(input) },
  )
}

export function transitionChatRun(
  sessionId: number,
  runId: string,
  input: {
    status: 'completed' | 'failed' | 'needs_reconciliation'
    expected_version: number
    error_data?: Record<string, unknown>
  },
) {
  return request<ChatRunRecord>(`${runPath(sessionId, runId)}/status`, {
    method: 'PATCH', body: JSON.stringify(input),
  })
}
