import { getDrafts } from '@/lib/api/drafts'
import { DraftsClient } from './DraftsClient'

export const dynamic = 'force-dynamic'

export default async function DraftsPage() {
  const drafts = await getDrafts()
  return <DraftsClient initialDrafts={drafts} />
}
