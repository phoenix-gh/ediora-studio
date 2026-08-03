'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { DailyCreationRule, DailyCreationRuleInput } from '@/lib/api/daily-plan'

type Directory = { id: number; name: string; asset_type: 'article' | 'media' }
type Account = { id: string; name: string }
const defaults: DailyCreationRuleInput = { name: '', asset_type: 'article', directory: '', output_type: 'x_short_post', target_count: 3, execution_mode: 'recurring', scheduled_date: null, scheduled_time: '09:00', timezone: 'Asia/Shanghai', lookback_days: 14, delivery_mode: 'drafts', account_id: null, instructions: '', enabled: true }

export function CreationRuleDialog({ open, directories, accounts, initial, onClose, onSubmit }: { open: boolean; directories: Directory[]; accounts: Account[]; initial?: DailyCreationRule | null; onClose: () => void; onSubmit: (input: DailyCreationRuleInput) => void | Promise<void> }) {
  const [value, setValue] = useState<DailyCreationRuleInput>(() => initial ? { name: initial.name, asset_type: initial.asset_type, directory: initial.directory, output_type: initial.output_type, target_count: initial.target_count, execution_mode: initial.execution_mode, scheduled_date: initial.scheduled_date, scheduled_time: initial.scheduled_time, timezone: initial.timezone, lookback_days: initial.lookback_days, delivery_mode: initial.delivery_mode, account_id: initial.account_id, instructions: initial.instructions, enabled: initial.enabled } : defaults)
  const [error, setError] = useState('')
  if (!open) return null
  const set = <K extends keyof DailyCreationRuleInput>(key: K, next: DailyCreationRuleInput[K]) => setValue(previous => ({ ...previous, [key]: next }))
  return <div role="dialog" aria-modal="true" aria-label={initial ? '编辑创作规则' : '新建创作规则'} className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
    <form noValidate className="w-full max-w-xl space-y-4 rounded-2xl border bg-background p-5 shadow-xl" onSubmit={event => { event.preventDefault(); if (!value.directory) { setError('请选择素材目录'); return } if (!value.name.trim()) { setError('请输入规则名称'); return } if (value.execution_mode === 'once' && !value.scheduled_date) { setError('请选择执行日期'); return } if (value.delivery_mode === 'plan_items' && !value.account_id) { setError('请选择发布账号'); return } setError(''); void onSubmit(value) }}>
      <div><h2 className="text-base font-semibold">{initial ? '编辑创作规则' : '新建创作规则'}</h2><p className="text-xs text-muted-foreground">AI 读取候选素材和全局历史，自主判断语义重复。</p></div>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">规则名称<input aria-label="规则名称" required value={value.name} onChange={e => set('name', e.target.value)} className="w-full rounded-lg border px-3 py-2" /></label>
        <label className="space-y-1 text-sm">素材类型<select aria-label="素材类型" value={value.asset_type} onChange={e => setValue(previous => ({ ...previous, asset_type: e.target.value as 'article' | 'media', directory: '' }))} className="w-full rounded-lg border px-3 py-2"><option value="article">文章</option><option value="media">媒体</option></select></label>
        <label className="space-y-1 text-sm">素材目录<select aria-label="素材目录" value={value.directory} onChange={e => set('directory', e.target.value)} className="w-full rounded-lg border px-3 py-2"><option value="">请选择</option>{directories.filter(item => item.asset_type === value.asset_type).map(item => <option key={item.id} value={item.name}>{item.name}</option>)}</select></label>
        <label className="space-y-1 text-sm">目标数量<input aria-label="目标数量" type="number" min={1} max={50} required value={value.target_count} onChange={e => set('target_count', Number(e.target.value))} className="w-full rounded-lg border px-3 py-2" /></label>
        <label className="space-y-1 text-sm">去重天数<input aria-label="去重天数" type="number" min={1} max={90} required value={value.lookback_days} onChange={e => set('lookback_days', Number(e.target.value))} className="w-full rounded-lg border px-3 py-2" /></label>
        <label className="space-y-1 text-sm">执行方式<select aria-label="执行方式" value={value.execution_mode} onChange={e => set('execution_mode', e.target.value as 'once' | 'recurring')} className="w-full rounded-lg border px-3 py-2"><option value="recurring">每天执行</option><option value="once">仅执行一次</option></select></label>
        {value.execution_mode === 'once' && <label className="space-y-1 text-sm">执行日期<input aria-label="执行日期" type="date" required value={value.scheduled_date ?? ''} onChange={e => set('scheduled_date', e.target.value || null)} className="w-full rounded-lg border px-3 py-2" /></label>}
        <label className="space-y-1 text-sm">执行时间<input aria-label="执行时间" type="time" required value={value.scheduled_time} onChange={e => set('scheduled_time', e.target.value)} className="w-full rounded-lg border px-3 py-2" /></label>
        <label className="space-y-1 text-sm">产出位置<select aria-label="产出位置" value={value.delivery_mode} onChange={e => set('delivery_mode', e.target.value as 'drafts' | 'plan_items')} className="w-full rounded-lg border px-3 py-2"><option value="drafts">保存为草稿</option><option value="plan_items">加入今日计划</option></select></label>
        {value.delivery_mode === 'plan_items' && <label className="space-y-1 text-sm">发布账号<select aria-label="发布账号" required value={value.account_id ?? ''} onChange={e => set('account_id', e.target.value || null)} className="w-full rounded-lg border px-3 py-2"><option value="">请选择</option>{accounts.filter(item => item.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      </div>
      <label className="block space-y-1 text-sm">附加要求<textarea aria-label="附加要求" value={value.instructions} onChange={e => set('instructions', e.target.value)} className="min-h-20 w-full rounded-lg border px-3 py-2" /></label>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>取消</Button><Button type="submit">保存规则</Button></div>
    </form>
  </div>
}
