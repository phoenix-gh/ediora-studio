import { listXResponses } from '@/lib/api/x-responses'

import { XResponsesClient } from './XResponsesClient'


export const dynamic = 'force-dynamic'

export default async function XResponsesPage() {
  const initial = await listXResponses({ workflow_status: 'ready' })
    .then(result => result.items)
    .catch(() => [])
  return <XResponsesClient initialItems={initial} />
}
