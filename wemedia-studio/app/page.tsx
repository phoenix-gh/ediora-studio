import Link from 'next/link'
import { ArrowRight, Flame, Sparkles, TrendingUp, TrendingDown, Minus, BarChart2, ExternalLink, Tag } from 'lucide-react'
import { getRecommendedTopics } from '@/lib/api/topics'
import { getKeywords, getWordCloud } from '@/lib/api/keywords'
import { getUrgentPosts } from '@/lib/api/accounts'
import { getEconomicItems } from '@/lib/api/economic'
import { mockAccounts } from '@/mock/accounts'
import { UrgencyBadge } from '@/components/features/UrgencyBadge'
import { ScoreStars } from '@/components/features/ScoreStars'
import { MiniSparkline } from '@/components/features/MiniSparkline'
import { GenerateButton } from '@/components/features/GenerateButton'
import { WordCloud } from '@/components/features/WordCloud'
import { cn } from '@/lib/utils'

export const dynamic = 'force-dynamic'

function formatRelativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return `${Math.floor(diff / 60000)} 分钟前`
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

function formatNumber(n: number) {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}w` : n.toLocaleString()
}

const impactColor: Record<string, string> = {
  positive: 'text-emerald-600 dark:text-emerald-400',
  negative: 'text-red-500 dark:text-red-400',
  neutral: 'text-zinc-500',
}
const impactLabel: Record<string, string> = { positive: '↑ 利好', negative: '↓ 利空', neutral: '→ 中性' }

const trendIcon = {
  rising: <TrendingUp className="w-3 h-3 text-red-500" />,
  stable: <Minus className="w-3 h-3 text-zinc-400" />,
  declining: <TrendingDown className="w-3 h-3 text-zinc-400" />,
}
const trendColor = { rising: 'text-red-500', stable: 'text-zinc-400', declining: 'text-zinc-400' }

export default async function Dashboard() {
  const [recommended, keywords, wordCloudData, urgentPosts, economicItems] = await Promise.all([
    getRecommendedTopics(5),
    getKeywords(),
    getWordCloud(24, 60),
    getUrgentPosts(5),
    getEconomicItems({ }),
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

          {/* 关注号动态 */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Flame className="w-4 h-4 text-orange-500" />
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">关注号紧急动态</h2>
                <span className="text-xs text-zinc-400">异常爆火</span>
              </div>
              <Link href="/following" className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
                查看全部 <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            {urgentPosts.length === 0 ? (
              <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-6 text-center text-zinc-400 text-xs">
                暂无紧急动态 · 在「关注动态」中添加订阅账号
              </div>
            ) : (
              <div className="space-y-2">
                {urgentPosts.map(post => {
                  const account = mockAccounts.find(a => a.id === post.accountId)
                  return (
                    <div key={post.id} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl p-4 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors">
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-900 flex items-center justify-center flex-shrink-0">
                          <span className="text-xs font-semibold text-indigo-600 dark:text-indigo-300">{account?.avatar}</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{account?.name ?? post.accountId}</span>
                            <span className="text-xs text-zinc-400">{account?.platform}</span>
                            <span className="ml-auto text-xs text-zinc-400">{formatRelativeTime(post.publishedAt)}</span>
                          </div>
                          <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed line-clamp-2">{post.content}</p>
                          <div className="flex items-center gap-3 mt-2">
                            <span className="text-xs text-zinc-400">❤ {formatNumber(post.metrics.likes)}</span>
                            <span className="text-xs text-zinc-400">↻ {formatNumber(post.metrics.reposts)}</span>
                            <span className="text-xs text-zinc-400">💬 {formatNumber(post.metrics.comments)}</span>
                            {post.url && (
                              <a
                                href={post.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-auto flex items-center gap-1 text-xs text-zinc-400 hover:text-indigo-500 transition-colors"
                              >
                                <ExternalLink className="w-3 h-3" />
                                原文
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* 经济动态 */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <BarChart2 className="w-4 h-4 text-blue-500" />
                <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">经济动态</h2>
                <span className="text-xs text-zinc-400">AI 提炼</span>
              </div>
              <Link href="/economic" className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-600 transition-colors">
                查看全部 <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            {economicItems.length === 0 ? (
              <div className="bg-zinc-50 dark:bg-zinc-900/50 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-6 text-center text-zinc-400 text-xs">
                暂无经济动态 · 点击「AI 一键生成」分析订阅内容
              </div>
            ) : (
              <div className="space-y-2">
                {economicItems.slice(0, 4).map(item => (
                  <div key={item.id} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">{item.category}</span>
                          <span className={cn('text-[10px] font-medium', impactColor[item.impact])}>{impactLabel[item.impact]}</span>
                          <span className="ml-auto text-[10px] text-zinc-400">
                            {new Date(item.published_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
                          </span>
                        </div>
                        <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{item.title}</p>
                        <p className="text-xs text-zinc-500 mt-0.5 line-clamp-1">{item.summary}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
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
