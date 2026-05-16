import { getDrafts } from '@/lib/api/drafts'
import { getTopics } from '@/lib/api/content-topics'
import { DraftsClient } from './DraftsClient'

export const dynamic = 'force-dynamic'

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string; chat?: string }>
}) {
  const [drafts, topics, params] = await Promise.all([getDrafts(), getTopics(), searchParams])
  return (
    <DraftsClient
      initialDrafts={drafts}
      initialTopics={topics}
      initialDraftId={params.draft ? parseInt(params.draft) : undefined}
      initialChatOpen={params.chat === '1'}
    />
  )
}
