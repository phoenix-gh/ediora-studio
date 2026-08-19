import { apiGet, apiPost, workerHeaders } from './job-client'

export type AgentLogStreamKind = 'chat' | 'job'

export type AgentLogEventInput = {
  stream_kind: AgentLogStreamKind
  stream_key: string
  session_id?: number | null
  job_id?: number | null
  execution_id?: number | null
  turn_id?: string | null
  step_id?: string | null
  event_type: string
  phase?: string
  status?: string
  payload?: unknown
  usage?: Record<string, unknown> | null
  duration_ms?: number | null
}

export type AgentLogEvent = AgentLogEventInput & {
  id: number
  sequence: number
  session_id: number | null
  job_id: number | null
  execution_id: number | null
  turn_id: string | null
  step_id: string | null
  phase: string
  status: string
  payload: unknown
  usage: Record<string, unknown> | null
  duration_ms: number | null
  created_at: string
}

export type AgentLogEventPage = {
  events: AgentLogEvent[]
  next_sequence: number | null
  has_more: boolean
}

export type AgentLogEventFilters = {
  stream_key?: string
  session_id?: number
  job_id?: number
  execution_id?: number
  event_type?: string
  phase?: string
  status?: string
  after_sequence?: number
  limit?: number
}

export function appendAgentLogEvent(event: AgentLogEventInput, jobId?: number) {
  return apiPost<AgentLogEvent>('/agent-logs/events', event, workerHeaders(jobId))
}

export function listAgentLogEvents(filters: AgentLogEventFilters = {}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const query = params.toString()
  return apiGet<AgentLogEventPage>(`/agent-logs${query ? `?${query}` : ''}`)
}

export async function listAllAgentLogEvents(
  filters: AgentLogEventFilters = {},
  maxPages = 20,
): Promise<AgentLogEventPage> {
  const events: AgentLogEvent[] = []
  let nextFilters = { ...filters }
  let hasMore = false
  let nextSequence: number | null = null
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await listAgentLogEvents(nextFilters)
    events.push(...page.events)
    hasMore = page.has_more
    nextSequence = page.next_sequence
    if (!page.has_more || page.next_sequence === null) break
    nextFilters = { ...nextFilters, after_sequence: page.next_sequence }
  }
  return { events, has_more: hasMore, next_sequence: nextSequence }
}
