import { apiFetch } from './client'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api'

/** Rewrite a mmbiz.qpic.cn / weixin image URL to go through the local proxy.
 * Non-WeChat URLs pass through unchanged. */
export function wechatImg(url: string | null | undefined): string {
  if (!url) return ''
  if (!/(qpic\.cn|weixin)/i.test(url)) return url
  return `${API_BASE}/wechat/img?url=${encodeURIComponent(url)}`
}

export interface WechatArticle {
  id: string
  biz: string
  account_name: string
  title: string
  url: string
  cover_url: string
  digest: string
  content?: string
  published_at: string
  collected_at: string
}

export async function getWechatArticle(id: string): Promise<WechatArticle> {
  const art = await apiFetch<WechatArticle>(`/wechat/articles/${encodeURIComponent(id)}`)
  if (art.content) art.content = rewriteImgPaths(art.content)
  return art
}

/** Backend stores `<img src="/api/wechat/img?url=...">` as relative paths so
 * we don't bake the API host into the DB. The browser resolves relative URLs
 * against the *frontend* origin (dev server :3000), not the API host, so we
 * rewrite to an absolute URL right before rendering. */
function rewriteImgPaths(html: string): string {
  const base = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000/api').replace(/\/$/, '')
  return html.replace(/(["'])\/api\/wechat\/img\?url=/g, `$1${base}/wechat/img?url=`)
}

export async function getWechatArticles(opts?: {
  biz?: string
  account?: string
  days?: number
  limit?: number
  search?: string
}): Promise<WechatArticle[]> {
  const p = new URLSearchParams()
  if (opts?.biz) p.set('biz', opts.biz)
  if (opts?.account) p.set('account', opts.account)
  if (opts?.days) p.set('days', String(opts.days))
  if (opts?.limit) p.set('limit', String(opts.limit))
  if (opts?.search) p.set('search', opts.search)
  const qs = p.toString()
  const list = await apiFetch<WechatArticle[]>(`/wechat/articles${qs ? `?${qs}` : ''}`)
  for (const a of list) if (a.content) a.content = rewriteImgPaths(a.content)
  return list
}

export async function deleteWechatArticle(id: string): Promise<void> {
  return apiFetch<void>(`/wechat/articles/${id}`, { method: 'DELETE' })
}

// ── Login state ──────────────────────────────────────────────────────────────

export interface WechatAuthState {
  logged_in: boolean
  nickname: string
  avatar: string
  expires_at: string | null
  expired: boolean
}

export interface WechatQrcode {
  qr_data_url: string
  login_token: string
}

export interface WechatPoll {
  status: number
  acct_size: number
}

export interface WechatFinalize {
  nickname: string
  avatar: string
  expires_at: string
}

export async function getWechatAuthState(): Promise<WechatAuthState> {
  return apiFetch<WechatAuthState>('/wechat/auth/state')
}

export async function startWechatQrcode(): Promise<WechatQrcode> {
  return apiFetch<WechatQrcode>('/wechat/auth/qrcode', { method: 'POST' })
}

export async function pollWechatScan(login_token: string): Promise<WechatPoll> {
  return apiFetch<WechatPoll>('/wechat/auth/poll', {
    method: 'POST', body: JSON.stringify({ login_token }),
  })
}

export async function finalizeWechatLogin(login_token: string): Promise<WechatFinalize> {
  return apiFetch<WechatFinalize>('/wechat/auth/finalize', {
    method: 'POST', body: JSON.stringify({ login_token }),
  })
}

export async function logoutWechat(): Promise<void> {
  return apiFetch<void>('/wechat/auth/logout', { method: 'POST' })
}

// ── Account subscriptions ───────────────────────────────────────────────────

export interface WechatAccountCandidate {
  fakeid: string
  nickname: string
  alias: string
  round_head_img: string
  service_type: number
}

export interface WechatSubscribedAccount {
  biz: string
  name: string
  avatar_url: string
  description: string
  muted: boolean
  last_collected_at: string | null
}

export interface WechatSyncResult {
  biz: string
  new_articles: number
  total_seen: number
  body_fetched: number
  body_failed: number
  body_errors: string[]
  list_error: string
}

export async function searchWechatAccounts(query: string, begin = 0, count = 5): Promise<WechatAccountCandidate[]> {
  const p = new URLSearchParams({ query, begin: String(begin), count: String(count) })
  return apiFetch<WechatAccountCandidate[]>(`/wechat/accounts/search?${p.toString()}`)
}

export async function listSubscribedAccounts(): Promise<WechatSubscribedAccount[]> {
  return apiFetch<WechatSubscribedAccount[]>('/wechat/accounts')
}

export async function subscribeWechatAccount(payload: {
  fakeid: string; nickname: string; alias?: string; avatar?: string
}): Promise<WechatSubscribedAccount> {
  return apiFetch<WechatSubscribedAccount>('/wechat/accounts', {
    method: 'POST', body: JSON.stringify(payload),
  })
}

export async function unsubscribeWechatAccount(biz: string): Promise<void> {
  return apiFetch<void>(`/wechat/accounts/${encodeURIComponent(biz)}`, { method: 'DELETE' })
}

export async function syncWechatAccount(biz: string, pages = 1): Promise<WechatSyncResult> {
  return apiFetch<WechatSyncResult>(
    `/wechat/accounts/${encodeURIComponent(biz)}/sync?pages=${pages}`,
    { method: 'POST' },
  )
}

// ── One-click collect all ─────────────────────────────────────────────────────

export interface WechatCollectStatus {
  running: boolean
  total: number
  done: number
  current: string
  new_articles: number
  body_fetched: number
  body_failed: number
  errors: string[]
  started_at: string | null
  finished_at: string | null
  message: string
}

/** Start a background sync of every subscribed account (10s apart). Returns the
 * initial progress; poll getWechatCollectStatus() to follow it. Throws on 409
 * (already running) / 401 (not logged in) / 400 (no subscriptions). */
export async function startWechatCollectAll(): Promise<WechatCollectStatus> {
  return apiFetch<WechatCollectStatus>('/wechat/collect', { method: 'POST' })
}

export async function getWechatCollectStatus(): Promise<WechatCollectStatus> {
  return apiFetch<WechatCollectStatus>('/wechat/collect/status')
}
