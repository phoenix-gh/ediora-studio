'use client'

import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import type { DailyCreationRule, DailyCreationRun } from '@/lib/api/creation-rules'

function formatExecutionTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function formatRunStatus(status: DailyCreationRun['status']) {
  const labels: Record<DailyCreationRun['status'], string> = {
    queued: '排队中',
    running: '执行中',
    failed: '失败',
    partial: '部分完成',
    succeeded: '成功',
    cancelled: '已取消',
  }
  return labels[status]
}

export function CreationRulesPanel({ rules, runs, activeRuleIds, onCreate, onRun, onToggle, onEdit, onDelete }: { rules: DailyCreationRule[]; runs: DailyCreationRun[]; activeRuleIds: Set<number>; onCreate: () => void; onRun: (rule: DailyCreationRule) => void; onToggle: (rule: DailyCreationRule) => void; onEdit: (rule: DailyCreationRule) => void; onDelete: (rule: DailyCreationRule) => void }) {
  const latestRunByRule = new Map<number, DailyCreationRun>()
  for (const run of runs) if (!latestRunByRule.has(run.rule_id)) latestRunByRule.set(run.rule_id, run)

  return <section className="flex flex-col gap-3"><div className="flex items-center"><div><h2 className="font-semibold">创作规则</h2><p className="text-xs text-muted-foreground">一次性或每日执行，Agent 按提示词完成创作。</p></div><Button className="ml-auto" variant="outline" size="sm" onClick={onCreate}>新建规则</Button></div><div className="grid gap-2">{rules.length === 0 ? <Card><CardContent className="py-6 text-center text-muted-foreground">尚未创建规则</CardContent></Card> : null}{rules.map(rule => { const active = activeRuleIds.has(rule.id); const deleted = Boolean(rule.deleted_at); const run = latestRunByRule.get(rule.id); const schedule = rule.execution_mode === 'recurring' ? `每天 ${rule.scheduled_time}` : `${rule.scheduled_date} ${rule.scheduled_time}`; const nextRun = !rule.enabled ? '已停用' : rule.next_run_at ? formatExecutionTime(rule.next_run_at) : '无后续执行'; return <Card key={rule.id}><CardHeader><CardTitle>{rule.name}</CardTitle><CardDescription>{deleted ? '已删除' : rule.enabled ? '已开启' : '已暂停'}</CardDescription><CardAction><Button size="sm" disabled={active || deleted} onClick={() => onRun(rule)}>{active ? '执行中…' : '立即执行'}</Button></CardAction></CardHeader><CardContent className="flex flex-col gap-3"><p className="line-clamp-2 text-sm text-muted-foreground">{rule.prompt}</p><div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"><span>安排：{schedule}</span><span>上次执行：{rule.last_run_at ? formatExecutionTime(rule.last_run_at) : '尚未执行'}</span><span>下次执行：{nextRun}</span><span>最新状态：{run ? formatRunStatus(run.status) : '尚无运行'}</span></div></CardContent><CardFooter className="gap-2"><Button size="sm" variant="ghost" disabled={deleted} onClick={() => onEdit(rule)}>编辑</Button><Button size="sm" variant="ghost" disabled={deleted} onClick={() => onToggle(rule)}>{rule.enabled ? '暂停' : '开启'}</Button><Button size="sm" variant="destructive" disabled={deleted} onClick={() => onDelete(rule)}>删除</Button></CardFooter></Card> })}</div></section>
}
