import { getXCandidates, getXPosts } from '@/lib/api/x'
import { XClient } from './XClient'

export const dynamic = 'force-dynamic'

export default async function XPage() {
  const [candidates, posts] = await Promise.all([
    getXCandidates(undefined, 200).catch(() => []),
    getXPosts(24).catch(() => []),
  ])
  return <XClient initialCandidates={candidates} initialPosts={posts} />
}
