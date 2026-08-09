'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { type ChatSkill, listChatSkills } from '@/lib/api/chat'
import { listCreativeAssetDirectories } from '@/lib/api/assets'
import { createCreationRule, deleteCreationRule, getCreationDashboard, type CreationDashboard, type DailyCreationRule, type DailyCreationRuleInput, runCreationRule, updateCreationRule } from '@/lib/api/creation-rules'
import { cancelJob, retryJobStep } from '@/lib/api/jobs'
import { CreationDashboard as CreationDashboardCards } from './CreationDashboard'
import { CreationRuleDialog } from './CreationRuleDialog'
import { CreationRulesPanel } from './CreationRulesPanel'
import { TaskLogList } from './TaskLogList'

export function CreationRulesClient() {
  const [dashboard, setDashboard] = useState<CreationDashboard | null>(null)
  const [directories, setDirectories] = useState<Array<{ id: number; name: string; asset_type: 'article' | 'media' }>>([])
  const [skills, setSkills] = useState<ChatSkill[]>([])
  const [taskRefreshToken, setTaskRefreshToken] = useState(0)
  const [editingRule, setEditingRule] = useState<DailyCreationRule | null | undefined>(undefined)

  const refreshDashboard = useCallback(async () => {
    setDashboard(await getCreationDashboard())
  }, [])

  const refresh = useCallback(async () => {
    const [nextDashboard, article, media, nextSkills] = await Promise.all([
      getCreationDashboard(),
      listCreativeAssetDirectories('article'),
      listCreativeAssetDirectories('media'),
      listChatSkills(),
    ])
    setDashboard(nextDashboard)
    setDirectories([...article, ...media]
      .filter(directory => directory.asset_type !== 'prompt')
      .map(({ id, name, asset_type }) => ({
        id,
        name,
        asset_type: asset_type as 'article' | 'media',
      })))
    setSkills(nextSkills)
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh().catch(error => toast.error(error instanceof Error ? error.message : '任务看板加载失败'))
    }, 0)
    const interval = window.setInterval(() => {
      void refreshDashboard().catch(error => toast.error(error instanceof Error ? error.message : '任务看板刷新失败'))
    }, 60_000)
    return () => { clearTimeout(timer); window.clearInterval(interval) }
  }, [refresh, refreshDashboard])

  async function saveRule(input: DailyCreationRuleInput) {
    try {
      if (editingRule) await updateCreationRule(editingRule.id, input)
      else await createCreationRule(input)
      setEditingRule(undefined)
      await refresh()
      setTaskRefreshToken(token => token + 1)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    }
  }

  async function mutate(action: () => Promise<unknown>) {
    try {
      await action()
      await refresh()
      setTaskRefreshToken(token => token + 1)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    }
  }

  async function mutateJob(action: () => Promise<unknown>) {
    try {
      await action()
      await refreshDashboard()
      setTaskRefreshToken(token => token + 1)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '任务操作失败')
    }
  }

  const rules = dashboard?.rules ?? []
  const runs = dashboard?.runs ?? []
  const activeRuleIds = new Set(runs.filter(run => run.status === 'queued' || run.status === 'running').map(run => run.rule_id))

  return <div className="mx-auto max-w-7xl space-y-6 p-6">
    <header><h1 className="text-2xl font-semibold">任务看板</h1><p className="mt-1 text-sm text-muted-foreground">统一查看规则安排、定时 Job 运行状态和实际创作产出。</p></header>
    {dashboard ? <>
      <CreationDashboardCards summary={dashboard.summary} date={dashboard.date} />
      <CreationRulesPanel rules={rules} runs={runs} activeRuleIds={activeRuleIds} onCreate={() => setEditingRule(null)} onEdit={setEditingRule} onRun={rule => void mutate(() => runCreationRule(rule.id))} onToggle={rule => void mutate(() => updateCreationRule(rule.id, { enabled: !rule.enabled }))} onDelete={rule => { if (window.confirm('删除该规则？历史运行和产出会保留。')) void mutate(() => deleteCreationRule(rule.id)) }} />
      <TaskLogList refreshToken={taskRefreshToken} onRetry={(jobId, stepKey) => void mutateJob(() => retryJobStep(jobId, stepKey))} onCancel={jobId => void mutateJob(() => cancelJob(jobId))} />
    </> : <div className="rounded-xl border bg-card p-8 text-sm text-muted-foreground">任务看板加载中…</div>}
    {editingRule !== undefined && <CreationRuleDialog open initial={editingRule} directories={directories} skills={skills} onClose={() => setEditingRule(undefined)} onSubmit={saveRule} />}
  </div>
}
