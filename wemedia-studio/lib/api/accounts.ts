import { FollowedAccount, Post } from '@/lib/types'
import { apiFetch } from './client'
import { mockAccounts, mockPosts } from '@/mock/accounts'

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

function toPost(raw: Record<string, unknown>): Post {
  const m = (raw.metrics as Record<string, number>) ?? {}
  return {
    id: raw.id as string,
    accountId: raw.account_id as string,
    title: (raw.title as string) ?? '',
    content: raw.content as string,
    url: (raw.url as string) ?? '',
    publishedAt: raw.published_at as string,
    metrics: {
      likes: m.likes ?? 0,
      reposts: m.reposts ?? 0,
      comments: m.comments ?? 0,
    },
    isAbnormallyPopular: raw.is_abnormally_popular as boolean,
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

export async function getPosts(accountIds?: string[]): Promise<Post[]> {
  try {
    const params = new URLSearchParams()
    if (accountIds?.length === 1) params.set('account_id', accountIds[0])
    const qs = params.toString() ? `?${params}` : ''
    const raw = await apiFetch<Record<string, unknown>[]>(`/posts${qs}`)
    const posts = raw.map(toPost)
    return accountIds?.length && accountIds.length > 1
      ? posts.filter(p => accountIds.includes(p.accountId))
      : posts
  } catch {
    return mockPosts
  }
}

export async function getUrgentPosts(limit = 5): Promise<Post[]> {
  try {
    const raw = await apiFetch<Record<string, unknown>[]>(`/posts?hot_only=true&limit=${limit}`)
    return raw.map(toPost)
  } catch {
    return mockPosts.filter(p => p.isAbnormallyPopular).slice(0, limit)
  }
}
