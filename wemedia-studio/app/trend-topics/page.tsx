export const dynamic = 'force-dynamic'

import { TopicGeneratorClient } from './TopicGeneratorClient'
import { apiFetch } from '@/lib/api/client'
import { TopicSuggestion } from '@/lib/api/topic-generator'

interface PublishAccount {
  id: string
  name: string
  platform: string
  is_active: boolean
}

interface CachedTopicsResponse {
  generated_at: string | null
  topics: TopicSuggestion[]
}

export default async function TrendTopicsPage() {
  const [accounts, cached] = await Promise.all([
    apiFetch<PublishAccount[]>('/publish-accounts').catch(() => [] as PublishAccount[]),
    apiFetch<CachedTopicsResponse>('/topic-generator/cached').catch(() => ({ generated_at: null, topics: [] })),
  ])
  return (
    <TopicGeneratorClient
      accounts={accounts}
      initialTopics={cached.topics}
      initialGeneratedAt={cached.generated_at}
    />
  )
}
