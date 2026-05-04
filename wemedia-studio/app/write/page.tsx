import { getTopics } from '@/lib/api/topics'
import { WriteClient } from './WriteClient'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ topicId?: string }>
}

export default async function WritePage({ searchParams }: Props) {
  const { topicId } = await searchParams
  const topics = await getTopics()
  const topic = topicId ? topics.find(t => t.id === topicId) : topics.find(t => t.status === 'accepted')
  const acceptedTopics = topics.filter(t => t.status === 'accepted')

  return <WriteClient topic={topic ?? null} acceptedTopics={acceptedTopics} />
}
