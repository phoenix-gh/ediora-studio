'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check, Clock3, ExternalLink, FileText, MessageCircle, RefreshCw,
  Search, Sparkles, AtSign, Video, XCircle,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { PublishAccount } from '@/lib/api/publish-accounts'
import {
  createResponseOutputs,
  decideResponse,
  getResponse,
  getResponseEvents,
  getResponses,
  getTranscript,
  type ResponseDetail,
  type ResponseItem,
  type Transcript,
} from '@/lib/api/responses'
import { cn } from '@/lib/utils'


const outputLabels: Record<string, string> = {
  expanded_article: '扩写文章',
  commentary: '观点评论',
  x_share: '分享到 X',
  x_reply: 'X 回复',
  x_quote: 'X 引用',
}

const decisionLabels = {
  pending: '待处理',
  adopted: '已采纳',
  later: '稍后处理',
  rejected: '不值得',
}

export function ResponsesClient({
  initialItems,
  initialTotal,
  accounts,
  initialSelectedId,
  initialSource,
}: {
  initialItems: ResponseItem[]
  initialTotal: number
  accounts: PublishAccount[]
  initialSelectedId: number | null
  initialSource: string
}) {
  const [items, setItems] = useState(initialItems)
  const [total, setTotal] = useState(initialTotal)
  const [selectedId, setSelectedId] = useState<number | null>(
    initialSelectedId ?? initialItems[0]?.id ?? null,
  )
  const [detail, setDetail] = useState<ResponseDetail | null>(null)
  const [source, setSource] = useState(initialSource)
  const [status, setStatus] = useState('pending')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [events, setEvents] = useState<Array<{
    id: number; event_type: string; actor: string; created_at: string
  }>>([])
  const [reason, setReason] = useState('')
  const [accountId, setAccountId] = useState('')
  const [outputTypes, setOutputTypes] = useState<string[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [creationDetail, setCreationDetail] = useState<ResponseDetail | null>(null)

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getResponses({
        source_type: source,
        decision_status: status,
        search,
      })
      setItems(result.items)
      setTotal(result.total)
      setSelectedId(current => (
        current && result.items.some(item => item.id === current)
          ? current
          : result.items[0]?.id ?? null
      ))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '待响应加载失败')
    } finally {
      setLoading(false)
    }
  }, [search, source, status])

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadList() }, 250)
    return () => window.clearTimeout(timer)
  }, [loadList])

  useEffect(() => {
    if (!selectedId) {
      return
    }
    void getResponse(selectedId).then(next => {
      setTranscript(null)
      setEvents([])
      setDetail(next)
      if (creationDetail) return
      setAccountId(
        next.analysis?.recommended_publish_account_id
        ?? next.selected_publish_account_id
        ?? accounts[0]?.id
        ?? '',
      )
      setOutputTypes(
        next.analysis?.recommended_output_types.length
          ? next.analysis.recommended_output_types
          : ['expanded_article'],
      )
    }).catch(error => toast.error(error instanceof Error ? error.message : '详情加载失败'))
  }, [selectedId, accounts, creationDetail])

  const selected = useMemo(
    () => items.find(item => item.id === selectedId)
      ?? (detail?.id === selectedId ? detail : null),
    [detail, items, selectedId],
  )

  async function decide(action: 'adopt' | 'later' | 'not_valuable' | 'reset') {
    if (!selectedId) return
    try {
      await decideResponse(selectedId, action, reason)
      const updated = await getResponse(selectedId)
      setDetail(updated)
      if (action === 'adopt') {
        setCreationDetail(updated)
        setAccountId(
          updated.analysis?.recommended_publish_account_id
          ?? updated.selected_publish_account_id
          ?? accounts[0]?.id
          ?? '',
        )
        setOutputTypes(
          updated.analysis?.recommended_output_types.length
            ? updated.analysis.recommended_output_types
            : ['expanded_article'],
        )
        setShowCreate(true)
      }
      await loadList()
      toast.success('处理状态已保存')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  async function openTranscript() {
    if (!detail || detail.source_type !== 'youtube_video' || transcript) return
    try {
      setTranscript(await getTranscript(detail.source_id))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '字幕加载失败')
    }
  }

  async function openHistory() {
    if (!selectedId || events.length) return
    try {
      setEvents((await getResponseEvents(selectedId)).items)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '历史加载失败')
    }
  }

  async function submitOutputs() {
    if (!creationDetail?.current_analysis_run_id || !outputTypes.length) return
    try {
      await createResponseOutputs(creationDetail.id, {
        analysis_run_id: creationDetail.current_analysis_run_id,
        publish_account_id: accountId || null,
        output_types: outputTypes,
      })
      if (detail?.id === creationDetail.id) setDetail(await getResponse(creationDetail.id))
      setCreationDetail(null)
      setShowCreate(false)
      toast.success('创作任务已创建')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创作任务创建失败')
    }
  }

  return (
    <div className="flex h-screen min-h-0 bg-zinc-50/60 dark:bg-zinc-950">
      <aside className="w-52 shrink-0 border-r bg-white p-4 dark:bg-zinc-950">
        <div className="mb-6">
          <h1 className="text-lg font-semibold">待响应</h1>
          <p className="mt-1 text-xs text-zinc-500">{total} 条内容等待判断与创作</p>
        </div>
        <div className="space-y-5">
          <FilterGroup title="来源">
            {[['', '全部'], ['youtube_video', 'YouTube'], ['x_post', 'X']].map(([value, label]) => (
              <FilterButton key={value} active={source === value} onClick={() => setSource(value)}>
                {label}
              </FilterButton>
            ))}
          </FilterGroup>
          <FilterGroup title="状态">
            {Object.entries({ pending: '待处理', later: '稍后处理', adopted: '已采纳', rejected: '不值得', '': '全部' })
              .map(([value, label]) => (
                <FilterButton key={value} active={status === value} onClick={() => setStatus(value)}>
                  {label}
                </FilterButton>
              ))}
          </FilterGroup>
        </div>
      </aside>

      <section className="w-[370px] shrink-0 border-r bg-white dark:bg-zinc-950">
        <div className="border-b p-4">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 size-4 text-zinc-400" />
            <Input
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="搜索标题或频道"
              className="pl-9"
            />
          </div>
        </div>
        <div className="h-[calc(100vh-73px)] overflow-y-auto">
          {loading && !items.length && <p className="p-8 text-center text-sm text-zinc-400">正在加载…</p>}
          {!loading && !items.length && <p className="p-8 text-center text-sm text-zinc-400">暂无符合条件的内容</p>}
          {items.map(item => (
            <button
              key={item.id}
              onClick={() => setSelectedId(item.id)}
              className={cn(
                'w-full border-b px-4 py-4 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900',
                selectedId === item.id && 'bg-indigo-50/70 dark:bg-indigo-950/30',
              )}
            >
              <div className="mb-2 flex items-center gap-2">
                {item.source_type === 'youtube_video'
                  ? <Video className="size-4 text-red-500" />
                  : <AtSign className="size-4 text-sky-500" />}
                <span className="truncate text-xs text-zinc-500">{item.source_author}</span>
                <Badge variant="outline" className="ml-auto text-[10px]">
                  {decisionLabels[item.decision_status]}
                </Badge>
              </div>
              <p className="line-clamp-2 text-sm font-medium leading-5">{item.source_title}</p>
              <div className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
                <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                  {item.analysis ? `${item.analysis.content_value_score} 分` : '待分析'}
                </span>
                <span>·</span>
                <span className="truncate">{item.analysis?.recommended_action || item.workflow_status}</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {!selected && <div className="grid h-full place-items-center text-sm text-zinc-400">选择一条内容查看分析</div>}
        {selected && !detail && <div className="grid h-full place-items-center text-sm text-zinc-400">正在加载详情…</div>}
        {detail && (
          <div className="mx-auto max-w-4xl p-7">
            <div className="mb-5 flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex items-center gap-2 text-xs text-zinc-500">
                  <span>{detail.source_author}</span>
                  <span>·</span>
                  <span>{detail.source_type === 'youtube_video' ? 'YouTube' : 'X'}</span>
                </div>
                <h2 className="text-xl font-semibold leading-8">{detail.source_title}</h2>
              </div>
              <a
                href={detail.source_url}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                原文 <ExternalLink className="ml-1 size-3.5" />
              </a>
            </div>

            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">概览</TabsTrigger>
                {detail.source_type === 'youtube_video' && (
                  <TabsTrigger value="transcript" onClick={() => void openTranscript()}>字幕</TabsTrigger>
                )}
                <TabsTrigger value="accounts">账号适配</TabsTrigger>
                <TabsTrigger value="history" onClick={() => void openHistory()}>分析历史</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="mt-5 space-y-5">
                <ScoreOverview detail={detail} />
              </TabsContent>
              <TabsContent value="transcript" className="mt-5">
                <div className="rounded-xl border bg-white p-5 dark:bg-zinc-950">
                  {!transcript && <p className="text-sm text-zinc-400">正在加载字幕…</p>}
                  {transcript && (
                    <>
                      <div className="mb-4 flex gap-2 text-xs text-zinc-500">
                        <Badge variant="outline">{transcript.source || transcript.status}</Badge>
                        {transcript.language && <Badge variant="outline">{transcript.language}</Badge>}
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-7">{transcript.text || transcript.error || '暂无字幕'}</p>
                    </>
                  )}
                </div>
              </TabsContent>
              <TabsContent value="accounts" className="mt-5 space-y-3">
                {detail.account_scores.map(score => (
                  <div key={score.publish_account_id} className="rounded-xl border bg-white p-4 dark:bg-zinc-950">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{score.account_snapshot.name || score.publish_account_id}</span>
                      <Badge className="ml-auto">{score.score} 分</Badge>
                    </div>
                    <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{score.audience_value}</p>
                    {!!score.fit_reasons.length && <p className="mt-2 text-xs text-zinc-500">{score.fit_reasons.join(' · ')}</p>}
                    {score.has_hard_conflict && <p className="mt-2 text-xs text-red-500">禁区冲突：{score.taboo_risks.join('、')}</p>}
                  </div>
                ))}
                {!detail.account_scores.length && <p className="text-sm text-zinc-400">暂无启用的发布账号</p>}
              </TabsContent>
              <TabsContent value="history" className="mt-5 space-y-3">
                {events.map(event => (
                  <div key={event.id} className="flex gap-3 rounded-lg border bg-white p-3 text-sm dark:bg-zinc-950">
                    <Clock3 className="mt-0.5 size-4 text-zinc-400" />
                    <div><p>{event.event_type}</p><p className="text-xs text-zinc-400">{new Date(event.created_at).toLocaleString('zh-CN')}</p></div>
                  </div>
                ))}
              </TabsContent>
            </Tabs>

            <div className="sticky bottom-4 mt-8 rounded-2xl border bg-white/95 p-4 shadow-lg backdrop-blur dark:bg-zinc-950/95">
              {showCreate ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2"><Sparkles className="size-4 text-indigo-500" /><span className="font-medium">选择创作形式</span></div>
                  {creationDetail && <p className="text-sm text-zinc-500">将基于：{creationDetail.source_title}</p>}
                  <select value={accountId} onChange={event => setAccountId(event.target.value)} className="h-9 w-full rounded-md border bg-transparent px-3 text-sm">
                    <option value="">不指定账号</option>
                    {accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.platform}</option>)}
                  </select>
                  <div className="flex flex-wrap gap-2">
                    {['expanded_article', 'commentary', 'x_share'].map(type => (
                      <button
                        key={type}
                        onClick={() => setOutputTypes(current => current.includes(type) ? current.filter(value => value !== type) : [...current, type])}
                        className={cn('rounded-full border px-3 py-1.5 text-sm', outputTypes.includes(type) && 'border-indigo-500 bg-indigo-50 text-indigo-700')}
                      >
                        {outputLabels[type]}
                      </button>
                    ))}
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" onClick={() => { setCreationDetail(null); setShowCreate(false) }}>取消</Button>
                    <Button onClick={() => void submitOutputs()} disabled={!outputTypes.length}>创建任务</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-3 flex gap-2">
                    <Button size="sm" onClick={() => void decide('adopt')}><Check className="mr-1 size-4" />采纳创作</Button>
                    <Button size="sm" variant="outline" onClick={() => void decide('later')}><Clock3 className="mr-1 size-4" />稍后处理</Button>
                    <Button size="sm" variant="ghost" onClick={() => void decide('not_valuable')}><XCircle className="mr-1 size-4" />不值得</Button>
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void decide('reset')}><RefreshCw className="size-4" /></Button>
                  </div>
                  <Input value={reason} onChange={event => setReason(event.target.value)} placeholder="可选：记录不值得或稍后处理的原因" />
                </>
              )}
              {!!detail.outputs.length && (
                <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
                  {detail.outputs.map(output => (
                    <Badge key={output.id} variant="outline">
                      {outputLabels[output.output_type] ?? output.output_type} · {output.status}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <div><p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">{title}</p><div className="space-y-1">{children}</div></div>
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return <button onClick={onClick} className={cn('w-full rounded-md px-2.5 py-1.5 text-left text-sm text-zinc-500 hover:bg-zinc-100', active && 'bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100')}>{children}</button>
}

function ScoreOverview({ detail }: { detail: ResponseDetail }) {
  const analysis = detail.analysis
  if (!analysis) return <div className="rounded-xl border bg-white p-6 text-sm text-zinc-400 dark:bg-zinc-950">分析任务状态：{detail.workflow_status}</div>
  return (
    <>
      <div className="grid gap-4 md:grid-cols-[130px_1fr]">
        <div className="rounded-xl border bg-white p-5 text-center dark:bg-zinc-950">
          <p className="text-4xl font-semibold">{analysis.content_value_score}</p>
          <p className="mt-1 text-xs text-zinc-500">内容价值</p>
        </div>
        <div className="rounded-xl border bg-white p-5 dark:bg-zinc-950">
          <p className="text-xs font-medium text-zinc-400">核心思想</p>
          <p className="mt-2 text-base font-medium">{analysis.core_thesis}</p>
          <p className="mt-3 text-sm leading-6 text-zinc-600 dark:text-zinc-400">{analysis.summary_cn}</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Object.entries(analysis.value_dimensions).map(([key, value]) => (
          <div key={key} className="rounded-xl border bg-white p-3 dark:bg-zinc-950">
            <div className="flex items-center"><span className="truncate text-xs text-zinc-500">{key}</span><strong className="ml-auto">{value.score}</strong></div>
            <p className="mt-2 text-xs leading-5 text-zinc-500">{value.reason}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <InfoCard icon={<FileText className="size-4" />} title="价值点" items={analysis.value_points} />
        <InfoCard icon={<MessageCircle className="size-4" />} title="可加入的观点" items={analysis.personal_angles} />
      </div>
      <div className="rounded-xl border bg-indigo-50/50 p-4 dark:bg-indigo-950/20">
        <p className="text-sm font-medium">建议：{analysis.recommended_action}</p>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{analysis.recommendation_reason}</p>
      </div>
    </>
  )
}

function InfoCard({ icon, title, items }: { icon: React.ReactNode; title: string; items: string[] }) {
  return (
    <div className="rounded-xl border bg-white p-5 dark:bg-zinc-950">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">{icon}{title}</div>
      <ul className="space-y-2 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
        {items.map((item, index) => <li key={`${index}-${item}`} className="flex gap-2"><span>•</span><span>{item}</span></li>)}
      </ul>
    </div>
  )
}
