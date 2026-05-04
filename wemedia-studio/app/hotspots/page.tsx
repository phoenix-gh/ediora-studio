export const dynamic = 'force-dynamic'

import { getHotspots } from '@/lib/api/hotspots'
import { HotspotsClient } from './HotspotsClient'

export default async function HotspotsPage() {
  const hotspots = await getHotspots()
  return <HotspotsClient hotspots={hotspots} />
}
