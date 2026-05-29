import { getDrafts } from '@/lib/api/drafts'
import { getWritingPlans } from '@/lib/api/writing-plans'
import { DraftsClient } from './DraftsClient'

export const dynamic = 'force-dynamic'

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string; chat?: string }>
}) {
  const [drafts, plans, params] = await Promise.all([getDrafts(), getWritingPlans(), searchParams])
  return (
    <DraftsClient
      initialDrafts={drafts}
      initialTopics={plans}
      initialDraftId={params.draft ? parseInt(params.draft) : undefined}
      initialChatOpen={params.chat === '1'}
    />
  )
}
