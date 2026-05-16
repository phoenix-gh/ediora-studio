import { FollowedAccount } from '@/lib/types'
import { apiFetch } from './client'
import { mockAccounts } from '@/mock/accounts'

function toAccount(raw: Record<string, unknown>): FollowedAccount {
  return {
    id: raw.id as string,
    name: raw.name as string,
    avatar: raw.avatar as string,
    platform: raw.platform as string,
    group: raw.group as string,
    priority: raw.priority as FollowedAccount['priority'],
    muted: raw.muted as boolean,
  }
}

export async function getAccounts(): Promise<FollowedAccount[]> {
  try {
    const raw = await apiFetch<Record<string, unknown>[]>('/accounts')
    return raw.map(toAccount)
  } catch {
    return mockAccounts
  }
}