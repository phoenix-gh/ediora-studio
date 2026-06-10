import { apiFetch } from './client'

export interface CoverStyle {
  type?: string
  palette?: string
  rendering?: string
  text?: string
  mood?: string
  aspect_ratio?: string
  signature_motifs?: string[]
  negative?: string[]
}

export interface PublishAccount {
  id: string
  name: string
  platform: string
  positioning: string
  audience: string
  tone: string
  topic_focus: string[]
  taboo: string[]
  word_range: Record<string, number>
  image_style: string
  cover_style: CoverStyle
  voice_samples: string[]
  style_rules: string[]
  app_id: string
  app_secret: string
  is_active: boolean
  created_at: string
}

export type PublishAccountInput = Omit<PublishAccount, 'created_at'>
export type PublishAccountPatch = Partial<Omit<PublishAccount, 'id' | 'created_at'>>

export async function listPublishAccounts(): Promise<PublishAccount[]> {
  return apiFetch('/publish-accounts')
}

export async function createPublishAccount(body: PublishAccountInput): Promise<PublishAccount> {
  return apiFetch('/publish-accounts', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function updatePublishAccount(id: string, body: PublishAccountPatch): Promise<PublishAccount> {
  return apiFetch(`/publish-accounts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export async function deletePublishAccount(id: string): Promise<void> {
  return apiFetch(`/publish-accounts/${id}`, { method: 'DELETE' })
}
