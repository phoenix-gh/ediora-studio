import { getDashboardOverview, EMPTY_OVERVIEW } from '@/lib/api/dashboard'
import { getTodayPlan } from '@/lib/api/daily-plan'
import { CreateTaskButton } from '@/components/features/CreateTaskDialog'
import { AlertsBar } from '@/components/features/dashboard/AlertsBar'
import { TodayPlan } from '@/components/features/dashboard/TodayPlan'
import { ReleasesToday } from '@/components/features/dashboard/ReleasesToday'
import { SourceStatusGrid } from '@/components/features/dashboard/SourceStatusGrid'
import { PageHeader } from '@/components/layout/PageHeader'

export const dynamic = 'force-dynamic'

export default async function Dashboard() {
  const [overview, todayPlanResp] = await Promise.all([
    getDashboardOverview().catch(() => EMPTY_OVERVIEW),
    getTodayPlan().catch(() => ({ plan: null })),
  ])

  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })

  return (
    <div className="min-h-full bg-background">
      <PageHeader
        eyebrow={today}
        title="今日工作台"
        description={`今日 +${overview.today_output.topics} 选题 / +${overview.today_output.drafts} 草稿`}
        actions={<CreateTaskButton />}
      />
      <div className="px-7 pb-8">
        <AlertsBar alerts={overview.alerts} />
        <TodayPlan plan={todayPlanResp.plan} />
        <ReleasesToday releases={overview.releases_today} />
        <SourceStatusGrid sources={overview.sources} />
      </div>
    </div>
  )
}
