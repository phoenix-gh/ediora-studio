export const dynamic = 'force-dynamic'

import { getJuejinArticles, getJuejinCategories } from '@/lib/api/juejin'
import { JuejinClient } from './JuejinClient'

export default async function JuejinPage() {
  const [initial, categories] = await Promise.all([
    getJuejinArticles({ category: 'hot', limit: 50 }).catch(() => []),
    getJuejinCategories().catch(() => []),
  ])
  return <JuejinClient initial={initial} categories={categories} />
}
