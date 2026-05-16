import Link from 'next/link'
import { ArrowRight, Sparkles, TrendingUp, TrendingDown, Minus, Tag } from 'lucide-react'
import { getRecommendedTopics } from '@/lib/api/topics'
import { getKeywords, getWordCloud } from '@/lib/api/keywords'
import { UrgencyBadge } from '@/components/features/UrgencyBadge'
import { ScoreStars } from '@/components/features/ScoreStars'
import { MiniSparkline } from '@/components/features/MiniSparkline'
import { GenerateButton } from '@/components/features/GenerateButton'
import { WordCloud } from '@/components/features/WordCloud'
import { cn } from '@/lib/utils'

export const dynamic = 'force-dynamic'

const trendIcon = {
  rising: <TrendingUp className="w-3 h-3 text-red-500" />,
  stable: <Minus className="w-3 h-3 text-zinc-400" />,
  declining: <TrendingDown className="w-3 h-3 text-zinc-400" />,
}
const trendColor = { rising: 'text-red-500', stable: 'text-zinc-400', declining: 'text-zinc-400' }

export default async function Dashboard() {
  const [recommended, keywords, wordCloudData] = await Promise.all([
    getRecommendedTopics(5).catch(() => [] as Awaited<ReturnType<typeof getRecommendedTopics>>),
    getKeywords(),
    getWordCloud(24, 60),
  ])

  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
  const topKeywords = keywords.slice(0, 10)

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

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className="space-y-6">
          {/* 推荐选题 */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-500" />
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">系统推荐选题</h2>
                <span className="text-xs text-zinc-400">AI 从订阅内容中自动生成</span>
              </div>
              <Link href="/topics" className="flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600 transition-colors">
                查看全部 <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            {recommended.length === 0 ? (
              <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-6 text-center text-zinc-400 text-xs">
                暂无推荐选题 · 点击右上角「AI 一键生成」从订阅数据中生成选题
              </div>
            ) : (
              <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
                {recommended.map(topic => (
                  <Link
                    key={topic.id}
                    href={`/topics?id=${topic.id}`}
                    className="flex-none w-[260px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 hover:border-indigo-300 hover:shadow-sm transition-all group"
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

          {/* 24h 词云 */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Tag className="w-4 h-4 text-violet-500" />
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">24h 词云</h2>
                <span className="text-xs text-zinc-400">过去 24 小时采集内容高频词</span>
              </div>
            </div>
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4">
              <WordCloud words={wordCloudData} />
            </div>
          </section>

        </div>

        {/* 关键词热度 */}
        <aside>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-rose-500" />
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">关键词热度</h2>
              <span className="text-xs text-zinc-400">Top 10</span>
            </div>
            <Link href="/hotspots" className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
              管理 <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {topKeywords.length === 0 ? (
            <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-6 text-center text-zinc-400 text-xs">
              暂无关键词 · <Link href="/hotspots" className="text-indigo-400 hover:underline">去添加</Link>
            </div>
          ) : (
            <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl divide-y divide-zinc-100 dark:divide-zinc-800">
              {topKeywords.map((kw, i) => (
                <div key={kw.id} className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                  <span className={cn(
                    'text-xs font-bold tabular-nums w-4 text-center flex-shrink-0',
                    i < 3 ? 'text-rose-500' : 'text-zinc-400'
                  )}>
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{kw.term}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {trendIcon[kw.trend]}
                      <span className={cn('text-[10px]', trendColor[kw.trend])}>
                        {kw.mention_count_24h} 提及
                      </span>
                    </div>
                  </div>
                  <div className="flex-shrink-0">
                    <div className="text-xs font-medium text-zinc-500 tabular-nums">{kw.heat}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
