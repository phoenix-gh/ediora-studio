'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { CalendarCheck, ExternalLink, Loader2, RefreshCw, Send, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  DailyPlan, DailyPlanItem, enqueuePlanItems, generatePlan, getTodayPlan, toggleSkipItem,
} from '@/lib/api/daily-plan'

const TYPE_LABEL: Record<string, string> = {
  long: '长文', short: '短文', story: '微故事', share: '发现',
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  planning: { label: '总编策划中…', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
  ready:    { label: '已就绪',      cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
  failed:   { label: '生成失败',    cls: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300' },
}

export function DailyPlanClient({ initialPlan }: { initialPlan: DailyPlan | null }) {
  const [plan, setPlan] = useState<DailyPlan | null>(initialPlan)
  const [selected, setSelected] = useState<Set<number>>(
    new Set((initialPlan?.items ?? []).filter(i => i.status === 'suggested').map(i => i.id)),
  )
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const { plan: p } = await getTodayPlan()
      setPlan(p)
      if (p) {
        setSelected(prev => {
          const valid = new Set(p.items.filter(i => i.status === 'suggested').map(i => i.id))
          const kept = new Set([...prev].filter(id => valid.has(id)))
          return prev.size === 0 ? valid : kept
        })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载失败')
    }
  }, [])

  // 策划中每 10s 轮询
  useEffect(() => {
    if (plan?.status !== 'planning') return
    const t = setInterval(refresh, 10_000)
    return () => clearInterval(t)
  }, [plan?.status, refresh])

  const byAccount = useMemo(() => {
    const m = new Map<string, DailyPlanItem[]>()
    for (const it of plan?.items ?? []) {
      const k = it.account_name || it.account_id
      m.set(k, [...(m.get(k) ?? []), it])
    }
    return [...m.entries()]
  }, [plan])

  async function handleGenerate() {
    setBusy(true)
    try {
      await generatePlan()
      toast.success('已发起重新生成，总编策划中…')
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '生成失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleEnqueue() {
    if (!plan || selected.size === 0) return
    setBusy(true)
    try {
      const r = await enqueuePlanItems(plan.id, [...selected])
      toast.success(`已入队 ${r.enqueued_items} 条（${r.chains} 条创作链）`)
      setSelected(new Set())
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '入队失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleSkip(item: DailyPlanItem) {
    try {
      await toggleSkipItem(item.id)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '操作失败')
    }
  }

  const badge = plan ? STATUS_BADGE[plan.status] : null

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <header className="flex items-center gap-3">
        <CalendarCheck className="w-5 h-5 text-indigo-600" />
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          今日计划{plan ? ` · ${plan.plan_date}` : ''}
        </h1>
        {badge && (
          <span className={cn('px-2 py-0.5 rounded-full text-xs font-medium', badge.cls)}>
            {plan?.status === 'planning' && <Loader2 className="inline w-3 h-3 mr-1 animate-spin" />}
            {badge.label}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleGenerate}
                  disabled={busy || plan?.status === 'planning'} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" /> 重新生成
          </Button>
          <Button size="sm" onClick={handleEnqueue}
                  disabled={busy || selected.size === 0} className="gap-1.5">
            <Send className="w-3.5 h-3.5" /> 入队所选（{selected.size}）
          </Button>
        </div>
      </header>

      {plan?.planner_note && (
        <p className="text-sm text-zinc-500 bg-zinc-100 dark:bg-zinc-900 rounded-lg px-3 py-2">
          总编留言：{plan.planner_note}
        </p>
      )}

      {!plan && (
        <div className="text-center py-20 text-zinc-400 text-sm space-y-3">
          <p>今天还没有计划。每天 8:00 自动生成，也可以现在手动生成。</p>
          <Button onClick={handleGenerate} disabled={busy}>立即生成今日计划</Button>
        </div>
      )}

      {plan?.status === 'planning' && plan.items.length === 0 && (
        <div className="text-center py-20 text-zinc-400 text-sm">
          总编正在拉取候选池、分配选题……（自动刷新中）
        </div>
      )}

      {byAccount.map(([accountName, items]) => (
        <section key={accountName} className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            <Users className="w-4 h-4" /> {accountName}
          </h2>
          <div className="space-y-2">
            {items.map(item => (
              <div key={item.id}
                   className={cn(
                     'rounded-lg border p-3 flex gap-3 bg-white dark:bg-zinc-900',
                     'border-zinc-200 dark:border-zinc-800',
                     item.status === 'skipped' && 'opacity-50',
                   )}>
                <input
                  type="checkbox"
                  className="mt-1 w-4 h-4 accent-indigo-600"
                  disabled={item.status !== 'suggested'}
                  checked={selected.has(item.id)}
                  onChange={e => setSelected(prev => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(item.id)
                    else next.delete(item.id)
                    return next
                  })}
                />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-zinc-900 dark:text-zinc-100">
                      {item.title}
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {TYPE_LABEL[item.content_type] ?? item.content_type}
                    </span>
                    {item.group_key && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                        共享一稿{item.is_primary ? ' · 主笔' : ''}
                      </span>
                    )}
                    {item.status === 'enqueued' && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                        已入队
                      </span>
                    )}
                  </div>
                  {item.angle && <p className="text-xs text-zinc-500">角度：{item.angle}</p>}
                  {item.reason && <p className="text-xs text-zinc-400">{item.reason}</p>}
                  {item.sources.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {item.sources.map((s, i) => (
                        <a key={i} href={s.url || undefined} target="_blank" rel="noreferrer"
                           className="inline-flex items-center gap-0.5 text-[11px] text-indigo-500 hover:underline">
                          <ExternalLink className="w-3 h-3" />
                          [{s.platform}] {s.title || s.url}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 text-xs shrink-0">
                  {item.status !== 'enqueued' && (
                    <button onClick={() => handleSkip(item)}
                            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                      {item.status === 'skipped' ? '恢复' : '跳过'}
                    </button>
                  )}
                  {item.draft_id && (
                    <Link href="/drafts" className="text-indigo-500 hover:underline">
                      草稿 #{item.draft_id}
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
