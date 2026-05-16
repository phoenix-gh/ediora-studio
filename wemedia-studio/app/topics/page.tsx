import { getTopics } from '@/lib/api/content-topics'
import { TopicsClient } from './TopicsClient'

export const dynamic = 'force-dynamic'

export default async function TopicsPage() {
  const topics = await getTopics()
  return <TopicsClient initialTopics={topics} />
}
