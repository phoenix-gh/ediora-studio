const TYPE_LABELS = Object.freeze({
  article: '文章',
  x: 'X',
  mp: '公众号',
  bili: 'B站',
  xhs: '小红书',
})

const KNOWN_TYPE_ORDER = Object.freeze(['article', 'x', 'mp', 'bili', 'xhs'])

function invalidResponseError(message) {
  const error = new Error(message)
  error.code = 'DRAFT_API_INVALID_RESPONSE'
  return error
}

function toTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function normalizeDraft(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidResponseError('草稿条目不是对象')
  }
  if (raw.id === undefined || raw.id === null || String(raw.id).trim() === '') {
    throw invalidResponseError('草稿条目缺少有效 id')
  }

  return {
    id: raw.id,
    title: String(raw.title ?? ''),
    content: String(raw.content ?? raw.draft ?? ''),
    status: String(raw.status ?? ''),
    draft_type: String(raw.draft_type ?? 'article'),
    updated_at: String(raw.updated_at ?? ''),
  }
}

export function normalizeDrafts(rawDrafts) {
  if (!Array.isArray(rawDrafts)) throw invalidResponseError('草稿响应不是数组')
  return rawDrafts.map(normalizeDraft)
}

export function selectReadyDrafts(rawDrafts) {
  return normalizeDrafts(rawDrafts)
    .filter(draft => draft.status === 'ready')
    .sort((left, right) => toTimestamp(right.updated_at) - toTimestamp(left.updated_at))
}

export function filterDrafts(drafts, { query = '', type = 'all' } = {}) {
  const needle = String(query ?? '').trim().toLocaleLowerCase()

  return drafts.filter(draft => {
    if (type !== 'all' && draft.draft_type !== type) return false
    if (!needle) return true
    return `${draft.title}\n${draft.content}`.toLocaleLowerCase().includes(needle)
  })
}

export function getDraftTypeLabel(value) {
  const normalized = String(value ?? '')
  return TYPE_LABELS[normalized] || normalized || '未知平台'
}

export function getDraftTypeOptions(drafts) {
  const values = new Set(drafts.map(draft => String(draft.draft_type ?? 'article')))
  const known = KNOWN_TYPE_ORDER.filter(value => values.has(value))
  const unknown = [...values]
    .filter(value => !KNOWN_TYPE_ORDER.includes(value))
    .sort((left, right) => getDraftTypeLabel(left).localeCompare(getDraftTypeLabel(right), 'zh-CN'))
  return [...known, ...unknown]
}

export function getDraftTitle(draft) {
  const title = String(draft?.title ?? '').trim()
  return title || '未命名草稿'
}

export function formatRelativeTime(value, now = new Date()) {
  const timestamp = toTimestamp(value)
  if (!timestamp) return '时间未知'

  const diff = Math.max(0, now.getTime() - timestamp)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return '刚刚'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`

  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}
