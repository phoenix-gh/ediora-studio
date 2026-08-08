export const DEFAULT_API_BASE = 'http://localhost:8000/api'
export const API_BASE_STORAGE_KEY = 'shuceDraftApiBase'
export const ALLOWED_API_BASES = Object.freeze([
  'http://localhost:8000',
  'http://127.0.0.1:8000',
])

const SAFE_FIELDS = Object.freeze(['id', 'title', 'content', 'status', 'draft_type', 'updated_at'])

function createError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function invalidConfig(message = 'API 地址格式无效') {
  return createError('DRAFT_API_NOT_CONFIGURED', message)
}

export function normalizeApiBase(value) {
  if (typeof value !== 'string' || !value.trim()) throw invalidConfig('API 地址不能为空')

  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw invalidConfig()
  }

  if (!['http:', 'https:'].includes(url.protocol)) throw invalidConfig('API 地址必须使用 HTTP 或 HTTPS')
  if (url.username || url.password || url.search || url.hash) {
    throw invalidConfig('API 地址不能包含凭据、查询参数或片段')
  }

  const path = url.pathname.replace(/\/+$/, '')
  return url.origin + path
}

export function assertAllowedApiBase(value) {
  const normalized = normalizeApiBase(value)
  const origin = new URL(normalized).origin
  const allowed = ALLOWED_API_BASES.some(base => new URL(base).origin === origin)
  if (!allowed) throw createError('DRAFT_API_HOST_NOT_ALLOWED', '当前扩展只允许本机 8000 端口 API')
  return normalized
}

export function sanitizeDraftCollection(value) {
  if (!Array.isArray(value)) throw createError('DRAFT_API_INVALID_RESPONSE', '草稿 API 响应不是数组')

  return value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw createError('DRAFT_API_INVALID_RESPONSE', '草稿 API 返回了无效条目')
    }
    if (raw.id === undefined || raw.id === null || String(raw.id).trim() === '') {
      throw createError('DRAFT_API_INVALID_RESPONSE', '草稿 API 条目缺少 id')
    }

    return Object.fromEntries(SAFE_FIELDS.map(field => {
      if (field === 'id') return [field, raw[field]]
      if (field === 'content') return [field, String(raw.content ?? raw.draft ?? '')]
      if (field === 'title') return [field, String(raw.title ?? '')]
      if (field === 'status') return [field, String(raw.status ?? '')]
      if (field === 'draft_type') return [field, String(raw.draft_type ?? 'article')]
      return [field, String(raw.updated_at ?? '')]
    }))
  })
}

export async function fetchDraftCollection(apiBase, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const normalized = assertAllowedApiBase(apiBase)
  if (typeof fetchImpl !== 'function') throw createError('DRAFT_API_UNAVAILABLE', '当前环境不支持网络请求')

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = setTimeout(() => controller?.abort(), timeoutMs)

  let response
  try {
    response = await fetchImpl(normalized + '/write/drafts', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {}),
    })
  } catch {
    throw createError('DRAFT_API_UNAVAILABLE', '草稿 API 暂不可用，请检查服务是否运行')
  } finally {
    clearTimeout(timer)
  }

  if (!response?.ok) {
    const status = Number.isFinite(response?.status) ? `（HTTP ${response.status}）` : ''
    throw createError('DRAFT_API_UNAVAILABLE', `草稿 API 暂不可用${status}`)
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    throw createError('DRAFT_API_INVALID_RESPONSE', '草稿 API 返回的 JSON 无效')
  }
  return sanitizeDraftCollection(payload)
}
