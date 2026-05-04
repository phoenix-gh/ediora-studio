'use client'

import { useTopicsStore } from '@/store/topics'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { UrgencyBadge } from './UrgencyBadge'
import { ScoreStars } from './ScoreStars'
import { MiniSparkline } from './MiniSparkline'
import { TopicActions } from './TopicActions'
import { ExternalLink, Clock, Users, Database, Layers } from 'lucide-react'

const platformColors: Record<string, string> = {
  HN: 'bg-orange-100 text-orange-700',
  X: 'bg-sky-100 text-sky-700',
  '知乎': 'bg-blue-100 text-blue-700',
  '微博': 'bg-red-100 text-red-700',
  arXiv: 'bg-green-100 text-green-700',
  GitHub: 'bg-zinc-100 text-zinc-700',
  Reddit: 'bg-rose-100 text-rose-700',
  '36Kr': 'bg-violet-100 text-violet-700',
  '少数派': 'bg-teal-100 text-teal-700',
  '量子位': 'bg-indigo-100 text-indigo-700',
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function TopicDrawer() {
  const { topics, selectedTopicId, isDrawerOpen, closeDrawer } = useTopicsStore()
  const topic = topics.find(t => t.id === selectedTopicId)

  if (!topic) return null

  const primarySources = topic.sources.filter(s => !s.type || s.type === 'primary')
  const secondarySources = topic.sources.filter(s => s.type === 'secondary')
  const discussionSources = topic.sources.filter(s => s.type === 'discussion')

  return (
    <Sheet open={isDrawerOpen} onOpenChange={open => !open && closeDrawer()}>
      <SheetContent className="w-[480px] sm:max-w-[480px] p-0 flex flex-col">
        <SheetHeader className="px-6 pt-6 pb-4 border-b border-zinc-100 dark:border-zinc-800">
          <div className="flex items-center gap-2 mb-2">
            <UrgencyBadge urgency={topic.urgency} />
            <Badge variant="outline" className="text-[11px] text-zinc-500">{topic.category}</Badge>
          </div>
          <SheetTitle className="text-base font-semibold text-zinc-900 dark:text-zinc-100 leading-snug text-left">
            {topic.title}
          </SheetTitle>
          <div className="flex items-center gap-3 mt-2">
            <ScoreStars score={topic.score} />
            <div className="flex items-center gap-1 text-xs text-zinc-400">
              <Clock className="w-3 h-3" />
              {formatDate(topic.createdAt)}
            </div>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="px-6 py-4 space-y-5">
            {/* 核心摘要 */}
            <section>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">核心摘要</h3>
              <p className="text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed">{topic.summary}</p>
            </section>

            <Separator />

            {topic.clusterTitle && (
              <>
                <section>
                  <div className="flex items-center gap-2 mb-2">
                    <Layers className="w-3.5 h-3.5 text-emerald-500" />
                    <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">归并主题</h3>
                  </div>
                  <div className="bg-emerald-50 dark:bg-emerald-950/40 rounded-lg px-3 py-2.5">
                    <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300 leading-relaxed">{topic.clusterTitle}</p>
                    {!!topic.clusterSourceCount && (
                      <p className="text-[10px] text-emerald-600/70 dark:text-emerald-300/70 mt-1">
                        已归并 {topic.clusterSourceCount} 个同主题信源
                      </p>
                    )}
                  </div>
                </section>

                <Separator />
              </>
            )}

            {/* 推荐理由 */}
            <section>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">为什么推荐给你</h3>
              <div className="bg-indigo-50 dark:bg-indigo-950/50 rounded-lg px-3 py-2.5">
                <p className="text-xs text-indigo-700 dark:text-indigo-300 leading-relaxed">{topic.recommendReason}</p>
              </div>
            </section>

            <Separator />

            {/* 热度趋势 */}
            <section>
              <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-3">24 小时热度趋势</h3>
              <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3">
                <MiniSparkline data={topic.trendData} height={60} color="#6366f1" fill />
                <div className="flex justify-between mt-1">
                  <span className="text-[10px] text-zinc-400">24h 前</span>
                  <span className="text-[10px] text-zinc-400">现在</span>
                </div>
              </div>
            </section>

            <Separator />

            {/* 信源证据 */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">信源证据</h3>
                <div className="flex items-center gap-1 text-xs text-zinc-400">
                  <Database className="w-3 h-3" />
                  {topic.sources.length} 条
                </div>
              </div>

              {primarySources.length > 0 && (
                <div className="mb-3">
                  <p className="text-[10px] font-medium text-zinc-400 mb-1.5">一手信源</p>
                  <div className="space-y-1.5">
                    {primarySources.map((s, index) => (
                      <a
                        key={s.id || s.url || index}
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 group"
                      >
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${platformColors[s.platform] || 'bg-zinc-100 text-zinc-600'}`}>
                          {s.platform || '来源'}
                        </span>
                        <span className="text-xs text-zinc-600 dark:text-zinc-400 flex-1 truncate">{s.title || s.url}</span>
                        <ExternalLink className="w-3 h-3 text-zinc-300 group-hover:text-zinc-500 flex-shrink-0" />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {secondarySources.length > 0 && (
                <div className="mb-3">
                  <p className="text-[10px] font-medium text-zinc-400 mb-1.5">二次报道</p>
                  <div className="space-y-1.5">
                    {secondarySources.map((s, index) => (
                      <a
                        key={s.id || s.url || index}
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 group"
                      >
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${platformColors[s.platform] || 'bg-zinc-100 text-zinc-600'}`}>
                          {s.platform || '来源'}
                        </span>
                        <span className="text-xs text-zinc-600 dark:text-zinc-400 flex-1 truncate">{s.title || s.url}</span>
                        <ExternalLink className="w-3 h-3 text-zinc-300 group-hover:text-zinc-500 flex-shrink-0" />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {discussionSources.length > 0 && (
                <div>
                  <p className="text-[10px] font-medium text-zinc-400 mb-1.5">社区讨论</p>
                  <div className="space-y-1.5">
                    {discussionSources.map((s, index) => (
                      <a
                        key={s.id || s.url || index}
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 group"
                      >
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${platformColors[s.platform] || 'bg-zinc-100 text-zinc-600'}`}>
                          {s.platform || '来源'}
                        </span>
                        <span className="text-xs text-zinc-600 dark:text-zinc-400 flex-1 truncate">{s.title || s.url}</span>
                        <ExternalLink className="w-3 h-3 text-zinc-300 group-hover:text-zinc-500 flex-shrink-0" />
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <Separator />

            {/* 竞争分析 */}
            <section>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">竞争分析</h3>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-zinc-800 dark:text-zinc-200">{topic.competitorCount}</div>
                  <div className="text-[10px] text-zinc-400 mt-0.5">已发布竞品</div>
                </div>
                <div className="bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Users className="w-4 h-4 text-zinc-400" />
                    <span className="text-2xl font-bold text-zinc-800 dark:text-zinc-200">{topic.sources.length}</span>
                  </div>
                  <div className="text-[10px] text-zinc-400 mt-0.5">信源数量</div>
                </div>
              </div>
              <div className="mt-2">
                <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1">
                  <span>竞争强度</span>
                  <span>{topic.competitorCount < 10 ? '低' : topic.competitorCount < 20 ? '中' : '高'}</span>
                </div>
                <div className="h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      topic.competitorCount < 10 ? 'bg-emerald-400' :
                      topic.competitorCount < 20 ? 'bg-amber-400' : 'bg-red-400'
                    }`}
                    style={{ width: `${Math.min(100, (topic.competitorCount / 40) * 100)}%` }}
                  />
                </div>
              </div>
            </section>

            {/* 标签 */}
            <section>
              <div className="flex flex-wrap gap-1.5">
                {topic.tags.map(tag => (
                  <Badge key={tag} variant="secondary" className="text-[11px] font-normal px-2 py-0.5">
                    {tag}
                  </Badge>
                ))}
              </div>
            </section>
          </div>
        </ScrollArea>

        {/* 底部操作栏 */}
        <div className="border-t border-zinc-100 dark:border-zinc-800 px-6 py-4">
          <p className="text-[10px] text-zinc-400 mb-2">操作此选题</p>
          <TopicActions topicId={topic.id} currentStatus={topic.status} onAction={closeDrawer} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
