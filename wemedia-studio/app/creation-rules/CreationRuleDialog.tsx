'use client'

import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ChatSkill } from '@/lib/api/chat'
import type { DailyCreationRule, DailyCreationRuleInput } from '@/lib/api/creation-rules'
import { buildCreationRulePrompt } from './creation-rule-prompt'

type Directory = { id: number; name: string; asset_type: 'article' | 'media' }

const defaults: DailyCreationRuleInput = {
  name: '',
  prompt: '',
  asset_type: 'article',
  directory: '',
  directories: [],
  output_type: 'x_short_post',
  target_count: 3,
  execution_mode: 'recurring',
  scheduled_date: null,
  scheduled_time: '09:00',
  timezone: 'Asia/Shanghai',
  lookback_days: 14,
  delivery_mode: 'drafts',
  account_id: null,
  instructions: '',
  skill_mode: 'auto',
  skill_name: null,
  enabled: true,
}

function ruleInput(initial: DailyCreationRule | null | undefined): DailyCreationRuleInput {
  if (!initial) return defaults
  const directories = initial.directories?.length
    ? initial.directories
    : initial.directory ? [initial.directory] : []
  return {
    name: initial.name,
    prompt: initial.prompt,
    asset_type: initial.asset_type,
    directory: directories[0] ?? '',
    directories,
    output_type: initial.output_type,
    target_count: initial.target_count,
    execution_mode: initial.execution_mode,
    scheduled_date: initial.scheduled_date,
    scheduled_time: initial.scheduled_time,
    timezone: initial.timezone,
    lookback_days: initial.lookback_days,
    delivery_mode: initial.delivery_mode,
    account_id: initial.account_id,
    instructions: initial.instructions,
    skill_mode: initial.skill_mode ?? 'auto',
    skill_name: initial.skill_name ?? null,
    enabled: initial.enabled,
  }
}

function isValidTimeZone(value: string) {
  const normalized = value.trim()
  if (!normalized) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format()
    return true
  } catch {
    return false
  }
}

export function CreationRuleDialog({
  open,
  directories,
  skills,
  initial,
  onClose,
  onSubmit,
}: {
  open: boolean
  directories: Directory[]
  skills: ChatSkill[]
  initial?: DailyCreationRule | null
  onClose: () => void
  onSubmit: (input: DailyCreationRuleInput) => void | Promise<void>
}) {
  const [value, setValue] = useState<DailyCreationRuleInput>(() => ruleInput(initial))
  const [error, setError] = useState('')

  const set = <K extends keyof DailyCreationRuleInput>(key: K, next: DailyCreationRuleInput[K]) => {
    setValue(previous => ({ ...previous, [key]: next }))
  }

  function generatePrompt() {
    if (value.prompt.trim() && !window.confirm('重新生成会替换当前提示词，是否继续？')) return
    set('prompt', buildCreationRulePrompt({
      assetType: value.asset_type,
      directories: value.directories,
      targetCount: value.target_count,
      lookbackDays: value.lookback_days,
      accountId: value.account_id,
      skillMode: value.skill_mode,
      skillName: value.skill_name,
      instructions: value.instructions,
    }))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!value.name.trim()) return setError('请输入任务名称')
    if (!value.prompt.trim()) return setError('请输入 Agent 提示词')
    if (value.execution_mode === 'once' && !value.scheduled_date) {
      return setError('请选择执行日期')
    }
    if (!isValidTimeZone(value.timezone)) return setError('请输入有效时区')
    setError('')
    void onSubmit({
      ...value,
      name: value.name.trim(),
      prompt: value.prompt.trim(),
      scheduled_date: value.execution_mode === 'recurring'
        ? null
        : value.scheduled_date,
      timezone: value.timezone.trim(),
      directory: value.directories[0] ?? '',
      delivery_mode: 'drafts',
      skill_name: value.skill_mode === 'manual' ? value.skill_name : null,
    })
  }

  const availableDirectories = directories.filter(item => item.asset_type === value.asset_type)

  return (
    <Dialog open={open} onOpenChange={nextOpen => !nextOpen && onClose()}>
      <DialogContent size="md" className="max-h-[calc(100vh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? '编辑创作任务' : '新建创作任务'}</DialogTitle>
          <DialogDescription>先写清 Agent 要完成什么；快速生成器只会在你明确操作时填充提示词。</DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={submit} className="flex flex-col gap-5">
          <FieldGroup>
            <Field data-invalid={Boolean(error && !value.name.trim()) || undefined}>
              <FieldLabel htmlFor="creation-rule-name">任务名称</FieldLabel>
              <Input id="creation-rule-name" value={value.name} onChange={event => set('name', event.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="creation-rule-execution-mode">执行方式</FieldLabel>
                <select id="creation-rule-execution-mode" aria-label="执行方式" value={value.execution_mode} onChange={event => {
                  const executionMode = event.target.value as 'once' | 'recurring'
                  setValue(previous => ({
                    ...previous,
                    execution_mode: executionMode,
                    scheduled_date: executionMode === 'recurring'
                      ? null
                      : previous.scheduled_date,
                  }))
                }} className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                  <option value="recurring">每天执行</option>
                  <option value="once">仅执行一次</option>
                </select>
              </Field>
              {value.execution_mode === 'once' ? <Field>
                <FieldLabel htmlFor="creation-rule-date">执行日期</FieldLabel>
                <Input id="creation-rule-date" aria-label="执行日期" type="date" value={value.scheduled_date ?? ''} onChange={event => set('scheduled_date', event.target.value || null)} />
              </Field> : null}
              <Field>
                <FieldLabel htmlFor="creation-rule-time">执行时间</FieldLabel>
                <Input id="creation-rule-time" aria-label="执行时间" type="time" value={value.scheduled_time} onChange={event => set('scheduled_time', event.target.value)} />
              </Field>
              <Field data-invalid={error === '请输入有效时区' || undefined}>
                <FieldLabel htmlFor="creation-rule-timezone">时区</FieldLabel>
                <Input id="creation-rule-timezone" aria-label="时区" value={value.timezone} onChange={event => set('timezone', event.target.value)} aria-invalid={error === '请输入有效时区' || undefined} />
              </Field>
            </div>
            <Field data-invalid={Boolean(error && !value.prompt.trim()) || undefined}>
              <FieldLabel htmlFor="creation-rule-prompt">Agent 提示词</FieldLabel>
              <Textarea id="creation-rule-prompt" value={value.prompt} onChange={event => set('prompt', event.target.value)} placeholder="描述 Agent 应完成的创作任务、约束和验收要求。" />
              <FieldDescription>提示词可直接编辑；调整下方生成器字段不会改动这里的内容。</FieldDescription>
            </Field>
          </FieldGroup>

          <details className="rounded-lg border border-border p-4">
            <summary className="cursor-pointer font-medium">快速生成提示词</summary>
            <div className="mt-4 flex flex-col gap-5">
              <FieldGroup>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="creation-rule-asset-type">素材类型</FieldLabel>
                    <select id="creation-rule-asset-type" aria-label="素材类型" value={value.asset_type} onChange={event => setValue(previous => ({ ...previous, asset_type: event.target.value as 'article' | 'media', directory: '', directories: [] }))} className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                      <option value="article">文章</option>
                      <option value="media">媒体</option>
                    </select>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="creation-rule-account">发布账号 ID（可选）</FieldLabel>
                    <Input id="creation-rule-account" value={value.account_id ?? ''} onChange={event => set('account_id', event.target.value || null)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="creation-rule-target-count">目标数量</FieldLabel>
                    <Input id="creation-rule-target-count" aria-label="目标数量" type="number" min={1} max={50} value={value.target_count} onChange={event => set('target_count', Number(event.target.value))} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="creation-rule-lookback">去重天数</FieldLabel>
                    <Input id="creation-rule-lookback" aria-label="去重天数" type="number" min={1} max={90} value={value.lookback_days} onChange={event => set('lookback_days', Number(event.target.value))} />
                  </Field>
                </div>
                <Field>
                  <FieldLabel>素材目录</FieldLabel>
                  <FieldDescription>可不选目录，让 Agent 依据提示词和可用上下文完成任务。</FieldDescription>
                  <div className="grid max-h-40 gap-2 overflow-y-auto rounded-lg border border-border p-3 sm:grid-cols-2">
                    {availableDirectories.map(item => <label key={item.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={value.directories.includes(item.name)} onChange={event => {
                        const selected = new Set(value.directories)
                        if (event.target.checked) selected.add(item.name)
                        else selected.delete(item.name)
                        const ordered = availableDirectories.filter(directory => selected.has(directory.name)).map(directory => directory.name)
                        setValue(previous => ({ ...previous, directories: ordered, directory: ordered[0] ?? '' }))
                      }} />
                      {item.name}
                    </label>)}
                    {availableDirectories.length === 0 ? <p className="text-sm text-muted-foreground">暂无可选目录</p> : null}
                  </div>
                </Field>
                <Field>
                  <FieldLabel>创作 Skill</FieldLabel>
                  <div className="flex flex-wrap gap-4 rounded-lg border border-border p-3 text-sm">
                    <label className="flex items-center gap-2"><input type="radio" name="skill-mode" checked={value.skill_mode === 'auto'} onChange={() => setValue(previous => ({ ...previous, skill_mode: 'auto', skill_name: null }))} />自动匹配</label>
                    <label className="flex items-center gap-2"><input type="radio" name="skill-mode" checked={value.skill_mode === 'manual'} onChange={() => set('skill_mode', 'manual')} />手动指定</label>
                  </div>
                </Field>
                {value.skill_mode === 'manual' ? <Field>
                  <FieldLabel htmlFor="creation-rule-skill">指定 Skill</FieldLabel>
                  <select id="creation-rule-skill" aria-label="指定 Skill" value={value.skill_name ?? ''} onChange={event => set('skill_name', event.target.value || null)} className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                    <option value="">请选择</option>
                    {value.skill_name && !skills.some(skill => skill.name === value.skill_name) ? <option value={value.skill_name}>{value.skill_name}（不可用）</option> : null}
                    {skills.map(skill => <option key={skill.name} value={skill.name}>{skill.name} · {skill.description}</option>)}
                  </select>
                </Field> : null}
                <Field>
                  <FieldLabel htmlFor="creation-rule-instructions">附加要求</FieldLabel>
                  <Textarea id="creation-rule-instructions" aria-label="附加要求" value={value.instructions} onChange={event => set('instructions', event.target.value)} />
                </Field>
              </FieldGroup>
              <Button type="button" variant="outline" onClick={generatePrompt}>生成提示词</Button>
            </div>
          </details>

          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>取消</Button>
            <Button type="submit">保存规则</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
