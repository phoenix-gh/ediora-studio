export const API_BASE = (
  typeof window === 'undefined' ? process.env.API_URL : undefined
) ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && init?.body instanceof FormData
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: isFormData
      ? init?.headers
      : { 'Content-Type': 'application/json', ...init?.headers },
    cache: init?.cache ?? 'no-store',
  })
  if (!res.ok) {
    let detail: unknown = ''
    try { detail = (await res.json()).detail ?? '' } catch { /* ignore */ }
    const validationMessage = Array.isArray(detail)
      ? detail.find((item): item is { msg: string } => (
          typeof item === 'object'
          && item !== null
          && 'msg' in item
          && typeof item.msg === 'string'
        ))?.msg ?? ''
      : ''
    const rawMessage = typeof detail === 'string'
      ? detail
      : typeof detail === 'object' && detail && 'message' in detail
        ? String(detail.message)
        : validationMessage
    const message = rawMessage.replace(/^Value error,\s*/i, '')
    throw new ApiError(
      message || `API ${path} → ${res.status}`,
      res.status,
      detail,
    )
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T
  }
  return res.json()
}
