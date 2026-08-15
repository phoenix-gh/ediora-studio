import { getWritingPlans, getTags } from '@/lib/api/writing-plans'
import { WritingPlansClient } from './WritingPlansClient'

export const dynamic = 'force-dynamic'

export default async function WritingPlansPage() {
  const [plans, allTags] = await Promise.all([getWritingPlans(), getTags()])
  return <WritingPlansClient initialPlans={plans} initialTags={allTags} />
}
