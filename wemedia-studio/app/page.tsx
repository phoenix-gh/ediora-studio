import { getDashboardOverview, EMPTY_OVERVIEW } from '@/lib/api/dashboard'
import { CreateTaskButton } from '@/components/features/CreateTaskDialog'
import { AlertsBar } from '@/components/features/dashboard/AlertsBar'
import { ReleasesToday } from '@/components/features/dashboard/ReleasesToday'
import { SourceStatusGrid } from '@/components/features/dashboard/SourceStatusGrid'

export const dynamic = 'force-dynamic'

export default async function Dashboard() {
  const overview = await getDashboardOverview().catch(() => EMPTY_OVERVIEW)

  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <p className="text-xs text-zinc-400 mb-1">{today}</p>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">今日工作台</h1>
          <p className="text-sm text-zinc-500 mt-1">
            今日 +{overview.today_output.topics} 选题 / +{overview.today_output.drafts} 草稿
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CreateTaskButton />
        </div>
      </div>

      <AlertsBar alerts={overview.alerts} />

      <ReleasesToday releases={overview.releases_today} />

      <SourceStatusGrid sources={overview.sources} />
    </div>
  )
}
