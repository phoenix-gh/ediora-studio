import { getXCandidates, getXPosts } from '@/lib/api/x'
import { XClient } from './XClient'

export const dynamic = 'force-dynamic'

export default async function XPage() {
  const [candidateData, posts] = await Promise.all([
    getXCandidates(undefined, 20, 0).catch(() => ({ candidates: [], total: 0, status_counts: {} })),
    getXPosts(24).catch(() => []),
  ])
  return (
    <XClient
      initialCandidates={candidateData.candidates}
      initialTotal={candidateData.total}
      initialStatusCounts={candidateData.status_counts}
      initialPosts={posts}
    />
  )
}
