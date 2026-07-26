export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api'

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
    let detail = ''
    try { detail = (await res.json()).detail ?? '' } catch { /* ignore */ }
    throw new Error(detail || `API ${path} → ${res.status}`)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T
  }
  return res.json()
}
