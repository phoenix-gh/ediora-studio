export const dynamic = 'force-dynamic'

import { getRedditSubscriptions, getRedditPosts } from '@/lib/api/reddit'
import { RedditClient } from './RedditClient'

export default async function RedditPage() {
  const [subs, posts] = await Promise.all([
    getRedditSubscriptions().catch(() => []),
    getRedditPosts({ view: 'hot', days: 14, limit: 200 }).catch(() => []),
  ])
  return <RedditClient initialSubs={subs} initialPosts={posts} />
}
