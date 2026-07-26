import { apiFetch } from './client'


export type XResponseAction = 'comment' | 'translate_quote' | 'watch' | 'ignore'
export type XResponseWorkflowStatus = 'ready' | 'used' | 'ignored'
export type XResponseTier = 'immediate' | 'digest' | 'silent'

export interface XResponseDecision {
  id: number
  tweet_id: string
  subscription_id: number
  source_label: string
  username: string
  display_name: string
  post_content: string
  post_url: string
  published_at: string
  action: XResponseAction
  score: number
  confidence: number
  reason: string
  summary_cn: string
  comment_draft: string | null
  quote_draft: string | null
  claims: Array<{ text: string; source_url?: string; verified?: boolean }>
  verification_status: 'verified' | 'not_required' | 'unverified'
  verified_urls: Array<{ url?: string; canonical_url?: string; title?: string }>
  notification_tier: XResponseTier
  workflow_status: XResponseWorkflowStatus
  telegram_status:
    | 'pending'
    | 'sending'
    | 'sent'
    | 'failed'
    | 'unknown'
    | 'not_required'
  telegram_message_ids: number[]
  telegram_last_error: string
  notified_at: string | null
  created_at: string
}

export interface XResponseFilters {
  action?: XResponseAction
  workflow_status?: XResponseWorkflowStatus
  notification_tier?: XResponseTier
  subscription_id?: number
}

export async function listXResponses(
  filters: XResponseFilters = {},
): Promise<{ items: XResponseDecision[] }> {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const query = params.toString()
  return apiFetch(`/x/responses${query ? `?${query}` : ''}`)
}

export function setXResponseFeedback(
  id: number,
  status: 'used' | 'ignored',
): Promise<XResponseDecision> {
  return apiFetch(`/x/responses/${id}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  })
}
