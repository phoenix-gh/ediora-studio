import { apiFetch, API_BASE } from './client'

export interface SessionCandidate {
  session_id: string
  label: string
}

export interface ResolveOut {
  task_id: string
  profile: string
  candidates: SessionCandidate[]
}

/** List the Hermes sessions that executed `taskId`, newest first. */
export async function resolveRetroSessions(
  taskId: string,
  profile: string,
): Promise<ResolveOut> {
  const q = new URLSearchParams({ task_id: taskId, profile })
  return apiFetch<ResolveOut>(`/retro/sessions?${q.toString()}`)
}

/** Build the ws(s):// URL for the retro PTY bridge from API_BASE. */
export function retroTermUrl(profile: string, sessionId: string): string {
  // API_BASE looks like http://localhost:8000/api → ws://localhost:8000/api
  const base = API_BASE.replace(/^http/, 'ws')
  const q = new URLSearchParams({ profile, session_id: sessionId })
  return `${base}/retro/term?${q.toString()}`
}
