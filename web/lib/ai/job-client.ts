export const apiBase = () => (
  process.env.WMS_API_URL
  ?? process.env.NEXT_PUBLIC_API_URL
  ?? 'http://localhost:8000/api'
).replace(/\/$/, '')

export function workerHeaders(jobId?: number): Record<string, string> {
  const token = process.env.WMS_WORKER_TOKEN
  if (!token) throw new Error('WMS_WORKER_TOKEN 未配置')
  return {
    'X-WMS-Worker-Token': token,
    ...(jobId === undefined ? {} : { 'X-Content-Job-Id': String(jobId) }),
  }
}

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
  responseReceived: boolean
  status?: number
  detail: unknown

  constructor(
    message: string,
    retryable: boolean,
    responseReceived = false,
    status?: number,
    detail: unknown = '',
  ) {
    super(message)
    this.name = 'ApiRequestError'
    this.retryable = retryable
    this.responseReceived = responseReceived
    this.status = status
    this.detail = detail
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
    let detail: unknown = ''
    try {
      detail = (await response.json() as { detail?: unknown }).detail ?? ''
    } catch {
      // Preserve an empty structured detail for non-JSON failures.
    }
    const message = typeof detail === 'string'
      ? detail
      : detail
        && typeof detail === 'object'
        && 'message' in detail
        ? String(detail.message)
        : ''
    const retryableHeader = response.headers.get('X-WMS-Retryable')
    const retryable = retryableHeader === null
      ? response.status !== 409
      : retryableHeader.toLowerCase() === 'true'
    throw new ApiRequestError(
      message || `${path} failed (${response.status})`,
      retryable,
      true,
      response.status,
      detail,
    )
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function getJob(jobId: number) {
  return jsonRequest<DurableJob>(`/jobs/${jobId}`)
}

export function startStep(jobId: number, step: string) {
  return jsonRequest<{ id: number; attempt: number }>(
    `/jobs/${jobId}/steps/${step}/start`,
    { method: 'POST' },
  )
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

export function apiGet<T>(path: string, headers?: HeadersInit) {
  return jsonRequest<T>(path, { headers })
}

export function apiPost<T>(
  path: string,
  body?: unknown,
  headers?: HeadersInit,
) {
  return jsonRequest<T>(path, {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export function apiPatch<T>(
  path: string,
  body: unknown,
  headers?: HeadersInit,
) {
  return jsonRequest<T>(path, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  })
}

export function apiDelete<T>(path: string, headers?: HeadersInit) {
  return jsonRequest<T>(path, { method: 'DELETE', headers })
}
