export const dynamic = 'force-dynamic'

import { getKeywords } from '@/lib/api/keywords'
import { HotspotsClient } from './HotspotsClient'

export default async function HotspotsPage() {
  const keywords = await getKeywords()
  return <HotspotsClient initialKeywords={keywords} />
}
