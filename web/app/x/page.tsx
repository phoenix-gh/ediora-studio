export const dynamic = 'force-dynamic'

import { listXSubscriptions, listXPosts } from '@/lib/api/x'
import { XClient } from './XClient'

export default async function XPage() {
  const [subs, posts] = await Promise.all([
    listXSubscriptions().catch(() => []),
    listXPosts({ hours: 168 }).catch(() => []),
  ])
  return <XClient initialSubs={subs} initialPosts={posts} />
}
