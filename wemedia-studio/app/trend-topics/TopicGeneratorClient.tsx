'use client'

import { useState } from 'react'
import { Lightbulb, ChevronDown, ChevronUp, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { generateTopics, enqueueTopics, TopicSuggestion } from '@/lib/api/topic-generator'

interface PublishAccount {
  id: string
  name: string
  platform: string
  is_active: boolean
}

interface TopicCard extends TopicSuggestion {
  checked: boolean
  enqueued: boolean
  expanded: boolean
}

export function TopicGeneratorClient({ accounts }: { accounts: PublishAccount[] }) {
  const [accountId, setAccountId] = useState<string>('__none__')
  const [cards, setCards] = useState<TopicCard[]>([])
  const [generating, setGenerating] = useState(false)
  const [enqueueing, setEnqueueing] = useState(false)

  const selectedCount = cards.filter(c => c.checked && !c.enqueued).length

  async function handleGenerate() {
    setGenerating(true)
    try {
      const res = await generateTopics({
        account_id: accountId === '__none__' ? null : accountId,
      })
      if (res.warning) toast.warning(res.warning)
      setCards(
        res.topics.map(t => ({ ...t, checked: false, enqueued: false, expanded: false }))
      )
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  function toggleCheck(idx: number) {
    setCards(prev =>
      prev.map((c, i) => (i === idx && !c.enqueued ? { ...c, checked: !c.checked } : c))
    )
  }

  function toggleExpand(idx: number) {
    setCards(prev => prev.map((c, i) => (i === idx ? { ...c, expanded: !c.expanded } : c)))
  }

  async function handleEnqueue() {
    const toEnqueue = cards.filter(c => c.checked && !c.enqueued)
    if (!toEnqueue.length) return
    setEnqueueing(true)
    try {
      const res = await enqueueTopics({
        account_id: accountId === '__none__' ? null : accountId,
        topics: toEnqueue,
      })
      toast.success(`已入队 ${res.enqueued} 条选题`)
      const titles = new Set(toEnqueue.map(t => t.title))
      setCards(prev =>
        prev.map(c => (titles.has(c.title) ? { ...c, checked: false, enqueued: true } : c))
      )
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : '入队失败')
    } finally {
      setEnqueueing(false)
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-zinc-200 dark:border-zinc-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <Lightbulb className="w-5 h-5 text-amber-500" />
          <h1 className="text-lg font-semibold">热点选题生成</h1>
        </div>
      </div>

      {/* Toolbar */}
      <div className="px-6 py-4 flex items-center gap-3 border-b border-zinc-100 dark:border-zinc-800">
        <Select value={accountId} onValueChange={(v) => setAccountId(v ?? '__none__')}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="不绑定账号" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">不绑定账号</SelectItem>
            {accounts.filter(a => a.is_active).map(a => (
              <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleGenerate} disabled={generating}>
          {generating
            ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />生成中…</>
            : <><Lightbulb className="w-4 h-4 mr-2" />生成选题</>
          }
        </Button>
      </div>

      {/* Cards */}
      {cards.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
          {generating ? '正在分析过去 24 小时的 X 热帖…' : '点击「生成选题」开始'}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {cards.map((card, idx) => (
              <div
                key={idx}
                className={`rounded-lg border p-4 transition-opacity ${
                  card.enqueued ? 'opacity-50' : ''
                } ${card.checked ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-950/20' : 'border-zinc-200 dark:border-zinc-800'}`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={card.checked}
                    onChange={() => toggleCheck(idx)}
                    disabled={card.enqueued}
                    className="mt-0.5 h-4 w-4 rounded border-zinc-300 accent-indigo-600 cursor-pointer disabled:cursor-not-allowed"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Badge
                        variant={card.type === 'long' ? 'default' : 'secondary'}
                        className={card.type === 'long' ? 'bg-blue-600' : 'bg-green-600 text-white'}
                      >
                        {card.type === 'long' ? '长文' : '短文'}
                      </Badge>
                      {card.enqueued && (
                        <Badge variant="outline" className="text-zinc-400">已入队</Badge>
                      )}
                    </div>
                    <p className="font-medium text-sm leading-snug mb-1">{card.title}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{card.angle}</p>

                    {card.source_posts.length > 0 && (
                      <button
                        onClick={() => toggleExpand(idx)}
                        className="mt-2 flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-600"
                      >
                        {card.expanded
                          ? <><ChevronUp className="w-3 h-3" />收起参考帖子</>
                          : <><ChevronDown className="w-3 h-3" />展开参考帖子（{card.source_posts.length}）</>
                        }
                      </button>
                    )}
                    {card.expanded && (
                      <ul className="mt-2 space-y-1">
                        {card.source_posts.map((p, pi) => (
                          <li key={pi} className="text-xs text-zinc-500 bg-zinc-50 dark:bg-zinc-900 rounded px-2 py-1">
                            <span className="font-mono text-zinc-400">{p.username}</span>{' '}
                            {p.content.slice(0, 100)}{p.content.length > 100 ? '…' : ''}{' '}
                            <a href={p.url} target="_blank" rel="noreferrer"
                              className="text-indigo-500 hover:underline">[链接]</a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer action bar */}
      {cards.length > 0 && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 px-6 py-3 flex items-center justify-between">
          <span className="text-sm text-zinc-500">已选 {selectedCount} 条</span>
          <Button
            onClick={handleEnqueue}
            disabled={selectedCount === 0 || enqueueing}
          >
            {enqueueing
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />入队中…</>
              : `入队选中项（${selectedCount}）`
            }
          </Button>
        </div>
      )}
    </div>
  )
}
