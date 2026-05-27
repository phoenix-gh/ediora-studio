'use client'

import { useState, useEffect } from 'react'
import { Lightbulb, ChevronDown, ChevronUp, Loader2, Settings2 } from 'lucide-react'
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

const DEFAULT_PROMPT = `你是资深自媒体策划，擅长从社交媒体热点中提炼有价值的创作选题。

请根据以上内容，严格按以下分布生成 10 条候选选题（每种类型数量必须达到）：

【长文 long × 4】1500-3000 字，深度分析，有数据有观点

【短文 short × 2】200-500 字，X 风格，一个核心观点，语气犀利

【微故事 story × 2】只写 5-6 句话。讲一个发生在身边的真实瞬间——可以是朋友用了某个新工具的反应、同事对 AI 的困惑、自己踩坑的经历——有细节、有情绪，让人读完想转发

【发现 share × 2】只写 3-5 句话 + 一句「为什么值得关注」。触发条件：帖子里出现 GitHub 项目、开源工具、产品发布、新 API、有趣网站时，必须生成 share 类选题。格式参考：「发现一个用 Cloudflare 做的自托管邮件系统……支持自定义域名……核心亮点是……值得关注的原因是……」

注意：
- 四种类型缺一不可，share 和 story 各必须有 2 条
- source_posts 列出该选题参考的 1-3 条原帖摘要
- 仅输出 JSON 数组，不要任何解释文字，格式：
[{"title":"...","angle":"...","type":"long|short|story|share","source_posts":[{"username":"@xxx","content":"...","url":"..."}]}]`

// v2 强制刷新旧缓存（旧 key 没有 share 类型定义）
const PROMPT_STORAGE_KEY = 'wms_topic_generator_prompt_v2'

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

function typeBadge(type: string) {
  if (type === 'long')  return { label: '长文',   cls: 'bg-blue-600 text-white' }
  if (type === 'story') return { label: '微故事', cls: 'bg-amber-500 text-white' }
  if (type === 'share') return { label: '发现',   cls: 'bg-purple-600 text-white' }
  return { label: '短文', cls: 'bg-green-600 text-white' }
}

export function TopicGeneratorClient({ accounts }: { accounts: PublishAccount[] }) {
  const [accountId, setAccountId] = useState<string>('__none__')
  const [cards, setCards] = useState<TopicCard[]>([])
  const [generating, setGenerating] = useState(false)
  const [enqueueing, setEnqueueing] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [customPrompt, setCustomPrompt] = useState(DEFAULT_PROMPT)

  useEffect(() => {
    const saved = localStorage.getItem(PROMPT_STORAGE_KEY)
    if (saved) setCustomPrompt(saved)
  }, [])

  function savePrompt(value: string) {
    setCustomPrompt(value)
    localStorage.setItem(PROMPT_STORAGE_KEY, value)
  }

  function resetPrompt() {
    savePrompt(DEFAULT_PROMPT)
    toast.success('已恢复默认提示词')
  }

  const selectedCount = cards.filter(c => c.checked && !c.enqueued).length
  const isCustomPrompt = customPrompt.trim() !== DEFAULT_PROMPT.trim()

  async function handleGenerate() {
    setGenerating(true)
    try {
      const res = await generateTopics({
        account_id: accountId === '__none__' ? null : accountId,
        custom_prompt: customPrompt.trim() !== DEFAULT_PROMPT.trim() ? customPrompt : null,
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
      <div className="border-b border-zinc-100 dark:border-zinc-800">
        <div className="px-6 py-3 flex items-center gap-3">
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
          <button
            onClick={() => setPromptOpen(v => !v)}
            className={`ml-auto flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border transition-colors ${
              isCustomPrompt
                ? 'border-amber-300 text-amber-600 bg-amber-50 dark:bg-amber-950/20'
                : 'border-zinc-200 text-zinc-500 hover:text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800'
            }`}
          >
            <Settings2 className="w-3.5 h-3.5" />
            分析提示词
            {isCustomPrompt && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
            {promptOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>

        {/* Prompt editor */}
        {promptOpen && (
          <div className="px-6 pb-4 border-t border-zinc-100 dark:border-zinc-800 pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-500">此提示词会替换默认的选题分析指令（帖子数据由系统自动注入，无需手动填写）</span>
              <button
                onClick={resetPrompt}
                className="text-xs text-zinc-400 hover:text-zinc-600 underline underline-offset-2"
              >
                恢复默认
              </button>
            </div>
            <textarea
              value={customPrompt}
              onChange={e => savePrompt(e.target.value)}
              rows={10}
              className="w-full text-xs font-mono rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 px-3 py-2 text-zinc-700 dark:text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-400 resize-y"
              spellCheck={false}
            />
          </div>
        )}
      </div>

      {/* Cards */}
      {cards.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
          {generating ? '正在分析过去 24 小时的 X 热帖…' : '点击「生成选题」开始'}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {cards.map((card, idx) => {
              const badge = typeBadge(card.type)
              return (
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
                        <Badge variant="secondary" className={badge.cls}>
                          {badge.label}
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
                              {p.url && (
                                <a href={p.url} target="_blank" rel="noreferrer"
                                  className="text-indigo-500 hover:underline">[链接]</a>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
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
