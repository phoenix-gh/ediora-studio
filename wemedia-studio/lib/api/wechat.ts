import { apiFetch } from './client'

export interface WechatArticle {
  id: string
  biz: string
  account_name: string
  title: string
  url: string
  cover_url: string
  digest: string
  published_at: string
  collected_at: string
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
  return apiFetch<WechatArticle[]>(`/wechat/articles${qs ? `?${qs}` : ''}`)
}

export async function addWechatArticle(url: string): Promise<WechatArticle> {
  return apiFetch<WechatArticle>('/wechat/articles', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

export async function deleteWechatArticle(id: string): Promise<void> {
  return apiFetch<void>(`/wechat/articles/${id}`, { method: 'DELETE' })
}
