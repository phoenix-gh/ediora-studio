export const dynamic = 'force-dynamic'

import { DailyPlanClient } from './DailyPlanClient'
import { apiFetch } from '@/lib/api/client'
import type { TodayPlanResponse } from '@/lib/api/daily-plan'

export default async function DailyPlanPage() {
  const initial = await apiFetch<TodayPlanResponse>('/daily-plan/today')
    .catch(() => ({ plan: null }) as TodayPlanResponse)
  return <DailyPlanClient initialPlan={initial.plan} />
}
