import { getTopics, getTags } from '@/lib/api/content-topics'
import { TopicsClient } from './TopicsClient'

export const dynamic = 'force-dynamic'

export default async function TopicsPage() {
  const [topics, allTags] = await Promise.all([getTopics(), getTags()])
  return <TopicsClient initialTopics={topics} initialTags={allTags} />
}
