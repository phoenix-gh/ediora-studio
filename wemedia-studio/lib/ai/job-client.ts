export const apiBase = () => (
  process.env.WMS_API_URL
  ?? process.env.NEXT_PUBLIC_API_URL
  ?? 'http://localhost:8000/api'
).replace(/\/$/, '')

export type JobStep = {
  id?: number
  key: string
  attempt: number
  status: string
  output: Record<string, unknown>
}

export type DurableJob = {
  id: number
  flow: string
  title: string
  status: string
  input: Record<string, unknown>
  steps: JobStep[]
}

export class ApiRequestError extends Error {
  retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'ApiRequestError'
    this.retryable = retryable
  }
}

export function retryableForError(error: unknown, fallback = true) {
  return error instanceof ApiRequestError ? error.retryable : fallback
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    cache: init?.cache ?? 'no-store',
  })
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.json() as { detail?: string }).detail ?? '' } catch { /* no JSON body */ }
    const retryableHeader = response.headers.get('X-WMS-Retryable')
    const retryable = retryableHeader === null
      ? true
      : retryableHeader.toLowerCase() === 'true'
    throw new ApiRequestError(
      detail || `${path} failed (${response.status})`,
      retryable,
    )
  }
  return response.json() as Promise<T>
}

export function getJob(jobId: number) {
  return jsonRequest<DurableJob>(`/jobs/${jobId}`)
}

export function startStep(jobId: number, step: string) {
  return jsonRequest<{ id: number }>(`/jobs/${jobId}/steps/${step}/start`, { method: 'POST' })
}

export function completeStep(jobId: number, stepId: number, output: Record<string, unknown>) {
  return jsonRequest(`/jobs/${jobId}/steps/${stepId}/succeed`, {
    method: 'POST',
    body: JSON.stringify({ output }),
  })
}

export function failStep(
  jobId: number,
  stepId: number,
  error: unknown,
  retryable = retryableForError(error),
) {
  const message = error instanceof Error ? error.message : String(error)
  return jsonRequest(`/jobs/${jobId}/steps/${stepId}/fail`, {
    method: 'POST',
    body: JSON.stringify({ error: message.slice(0, 500), retryable }),
  })
}

export function completeJob(jobId: number) {
  return jsonRequest(`/jobs/${jobId}/succeed`, { method: 'POST' })
}

export function apiGet<T>(path: string) {
  return jsonRequest<T>(path)
}

export function apiPost<T>(path: string, body?: unknown) {
  return jsonRequest<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
