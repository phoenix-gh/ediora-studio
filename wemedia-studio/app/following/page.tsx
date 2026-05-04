export const dynamic = 'force-dynamic'

import { getAccounts, getPosts } from '@/lib/api/accounts'
import { FollowingClient } from './FollowingClient'

export default async function FollowingPage() {
  const [accounts, posts] = await Promise.all([getAccounts(), getPosts()])
  return <FollowingClient accounts={accounts} posts={posts} />
}
