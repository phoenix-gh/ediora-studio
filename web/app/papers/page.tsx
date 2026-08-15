export const dynamic = 'force-dynamic'

import { getPapers } from '@/lib/api/papers'
import { PapersClient } from './PapersClient'

export default async function PapersPage() {
  const papers = await getPapers({ limit: 100, days: 7 }).catch(() => [])
  return <PapersClient initialPapers={papers} />
}
