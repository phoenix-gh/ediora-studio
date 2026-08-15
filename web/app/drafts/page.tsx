import { getDraftPage } from '@/lib/api/drafts'
import { getWritingPlans } from '@/lib/api/writing-plans'
import { DraftsClient } from './DraftsClient'

export const dynamic = 'force-dynamic'

export default async function DraftsPage({
  searchParams,
}: {
  searchParams: Promise<{ draft?: string; chat?: string }>
}) {
  const [draftPage, plans, params] = await Promise.all([getDraftPage(), getWritingPlans(), searchParams])
  return (
    <DraftsClient
      initialDrafts={draftPage.items}
      initialNextCursor={draftPage.next_cursor}
      initialTopics={plans}
      initialDraftId={params.draft ? parseInt(params.draft) : undefined}
      initialChatOpen={params.chat === '1'}
    />
  )
}
