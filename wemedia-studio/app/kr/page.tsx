export const dynamic = 'force-dynamic'

import { getKrArticles } from '@/lib/api/kr'
import { KrClient } from './KrClient'

export default async function KrPage() {
  const initial = await getKrArticles({ feed_type: 'hot', limit: 50 }).catch(() => [])
  return <KrClient initial={initial} />
}
