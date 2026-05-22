import { apiFetch } from './client'

export type AgentStatus = 'idle' | 'working' | 'waiting' | 'blocked'

export interface TaskBrief {
  id: string
  title: string
  status: string
  assignee: string
  created_at: number
  started_at?: number | null
  completed_at?: number | null
  workspace_path?: string | null
}

export interface AgentState {
  name: string
  display_name: string
  role: 'scout' | 'editor' | 'writer' | 'illustrator' | 'critic'
  accent: 'amber' | 'indigo' | 'emerald' | 'violet' | 'rose'
  status: AgentStatus
  current_task: TaskBrief | null
  waiting_count: number
  completed_today: number
  elapsed_seconds: number | null
}

export interface BoardSnapshot {
  agents: AgentState[]
  counts: Record<string, number>
  recent_tasks: TaskBrief[]
  server_time: number
}

export async function getStudioBoard(): Promise<BoardSnapshot> {
  return apiFetch<BoardSnapshot>('/studio/board')
}

export interface TaskFull {
  id: string
  title: string
  body: string
  assignee: string
  status: string
  priority: number
  tenant: string | null
  workspace_kind: string | null
  workspace_path: string | null
  branch_name: string | null
  created_by: string | null
  created_at: number
  started_at?: number | null
  completed_at?: number | null
  result: string | null
  skills: string[] | null
  max_retries: number | null
  session_id: string | null
  workflow_template_id: string | null
  current_step_key: string | null
}

export interface TaskComment {
  author: string
  body: string
  created_at: number
}

export interface TaskEvent {
  kind: string
  payload: Record<string, unknown> | null
  created_at: number
  run_id?: number | null
}

export interface TaskRun {
  run_id?: number | null
  outcome?: string | null
  summary?: string | null
  started_at?: number | null
  completed_at?: number | null
  elapsed_seconds?: number | null
}

export interface TaskDetail {
  task: TaskFull
  latest_summary: string | null
  parents: string[]
  children: string[]
  comments: TaskComment[]
  events: TaskEvent[]
  runs: TaskRun[]
}

export async function getStudioTaskDetail(taskId: string): Promise<TaskDetail> {
  return apiFetch<TaskDetail>(`/studio/tasks/${encodeURIComponent(taskId)}`)
}

export interface EnqueueIn {
  account_id: string
  title: string
  source_url: string
  platform?: string
  summary?: string
  note?: string
  content?: string
}

export async function enqueueStudioTask(body: EnqueueIn): Promise<{ task_id: string }> {
  return apiFetch('/studio/enqueue', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export interface RegenerateCoverIn {
  draft_id: number
  account_id: string
  note?: string
}

export async function regenerateCover(body: RegenerateCoverIn): Promise<{ task_id: string }> {
  return apiFetch('/studio/regenerate-cover', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function unblockStudioTask(taskId: string, note = ""): Promise<{ ok: boolean }> {
  return apiFetch(`/studio/tasks/${encodeURIComponent(taskId)}/unblock`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  })
}

export async function completeStudioTask(taskId: string, note = ""): Promise<{ ok: boolean }> {
  return apiFetch(`/studio/tasks/${encodeURIComponent(taskId)}/complete`, {
    method: 'POST',
    body: JSON.stringify({ note }),
  })
}

export interface DraftTaskBrief {
  id: string
  title: string
  assignee: string
  status: string
  created_at: number
  started_at: number | null
  completed_at: number | null
  result: string | null
  latest_summary: string | null
}

export async function getDraftTasks(draftId: number): Promise<{ draft_id: number; tasks: DraftTaskBrief[] }> {
  return apiFetch(`/studio/drafts/${draftId}/tasks`)
}
