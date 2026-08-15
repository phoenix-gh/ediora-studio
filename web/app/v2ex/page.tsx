export const dynamic = 'force-dynamic'

import { getV2exSubscriptions, getV2exTopics, getV2exPresets } from '@/lib/api/v2ex'
import { V2exClient } from './V2exClient'

export default async function V2exPage() {
  const [subs, topics, presets] = await Promise.all([
    getV2exSubscriptions().catch(() => []),
    getV2exTopics({ days: 14, limit: 200 }).catch(() => []),
    getV2exPresets().catch(() => ({ tabs: [], nodes: [] })),
  ])
  return <V2exClient initialSubs={subs} initialTopics={topics} presets={presets} />
}
