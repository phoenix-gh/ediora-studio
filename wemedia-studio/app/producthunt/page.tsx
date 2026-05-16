export const dynamic = 'force-dynamic'

import { getProductHuntPosts } from '@/lib/api/producthunt'
import { ProductHuntClient } from './ProductHuntClient'

export default async function ProductHuntPage() {
  const posts = await getProductHuntPosts({ days: 7, limit: 100 }).catch(() => [])
  return <ProductHuntClient initialPosts={posts} />
}
