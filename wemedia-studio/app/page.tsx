import Link from 'next/link'
import { ArrowRight, Sparkles } from 'lucide-react'
import { getRecommendedTopics } from '@/lib/api/topics'
import { UrgencyBadge } from '@/components/features/UrgencyBadge'
import { ScoreStars } from '@/components/features/ScoreStars'
import { MiniSparkline } from '@/components/features/MiniSparkline'
import { GenerateButton } from '@/components/features/GenerateButton'

export const dynamic = 'force-dynamic'

export default async function Dashboard() {
  const recommended = await getRecommendedTopics(5).catch(
    () => [] as Awaited<ReturnType<typeof getRecommendedTopics>>,
  )

  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })

  return (
    <div className="px-8 py-8">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <p className="text-xs text-zinc-400 mb-1">{today}</p>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">今日工作台</h1>
          <p className="text-sm text-zinc-500 mt-1">
            共 <span className="text-zinc-900 dark:text-zinc-100 font-medium">{recommended.length}</span> 条推荐选题，
            <span className="text-red-500 font-medium">{recommended.filter(t => t.urgency === 'urgent').length}</span> 条紧急
          </p>
        </div>
        <GenerateButton />
      </div>

      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-indigo-500" />
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">系统推荐选题</h2>
            <span className="text-xs text-zinc-400">AI 从订阅内容中自动生成</span>
          </div>
          <Link href="/trend-topics" className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600 transition-colors">
            查看全部 <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
        {recommended.length === 0 ? (
          <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-6 text-center text-zinc-400 text-xs">
            暂无推荐选题 · 点击右上角「AI 一键生成」从订阅数据中生成选题
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {recommended.map(topic => (
              <Link
                key={topic.id}
                href={`/trend-topics?id=${topic.id}`}
                className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 hover:border-indigo-300 hover:shadow-sm transition-all group"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <UrgencyBadge urgency={topic.urgency} />
                  <ScoreStars score={topic.score} />
                </div>
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100 leading-snug mb-2 line-clamp-2 group-hover:text-indigo-600 transition-colors">
                  {topic.title}
                </h3>
                <p className="text-xs text-zinc-400 leading-relaxed line-clamp-2 mb-3">{topic.summary}</p>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-zinc-400">{topic.sources.length} 信源</span>
                    <span className="text-zinc-200 dark:text-zinc-700">·</span>
                    <span className="text-xs text-zinc-400">{topic.competitorCount} 竞品</span>
                  </div>
                  <div className="w-[60px]"><MiniSparkline data={topic.trendData} height={20} /></div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
