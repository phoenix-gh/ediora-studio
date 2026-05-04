export const dynamic = 'force-dynamic'

import { getEconomicItems } from '@/lib/api/economic'
import { EconomicClient } from './EconomicClient'

export default async function EconomicPage() {
  const items = await getEconomicItems()
  return <EconomicClient initialItems={items} />
}
