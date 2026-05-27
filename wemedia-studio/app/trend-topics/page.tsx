export const dynamic = 'force-dynamic'

import { TopicGeneratorClient } from './TopicGeneratorClient'
import { apiFetch } from '@/lib/api/client'

interface PublishAccount {
  id: string
  name: string
  platform: string
  is_active: boolean
}

export default async function TrendTopicsPage() {
  const accounts = await apiFetch<PublishAccount[]>('/publish-accounts').catch(() => [])
  return <TopicGeneratorClient accounts={accounts} />
}
