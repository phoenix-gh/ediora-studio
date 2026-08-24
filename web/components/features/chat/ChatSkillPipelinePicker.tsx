'use client'

import { useEffect, useMemo, useState, type RefObject } from 'react'
import { ChevronLeft, Loader2, Plus, Search, X } from 'lucide-react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  listPipelineParameterOptions,
  type ChatSkill,
  type PipelineParameterOption,
  type SubmittedSkillInvocation,
} from '@/lib/api/chat'
import { cn } from '@/lib/utils'
import { useMediaQuery } from '@/lib/use-media-query'

type Props = {
  skills: ChatSkill[]
  invocations: SubmittedSkillInvocation[]
  open: boolean
  disabled: boolean
  renderInvocations?: boolean
  showTrigger?: boolean
  anchor?: Element | null | RefObject<Element | null> | (() => Element | null)
  onOpenChange: (open: boolean) => void
  onChange: (invocations: SubmittedSkillInvocation[]) => void
  onInvocationAdded?: (invocation: SubmittedSkillInvocation) => void
}

function invocationLabel(invocation: SubmittedSkillInvocation) {
  return invocation.parameterDisplayName
    ? `@${invocation.skillDisplayName}:${invocation.parameterDisplayName}`
    : `@${invocation.skillDisplayName}`
}

function newInvocationId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `invocation-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function ChatSkillPipelinePicker({
  skills,
  invocations,
  open,
  disabled,
  renderInvocations = true,
  showTrigger = true,
  anchor,
  onOpenChange,
  onChange,
  onInvocationAdded,
}: Props) {
  const [query, setQuery] = useState('')
  const [parameterSkill, setParameterSkill] = useState<ChatSkill | null>(null)
  const [parameterOpen, setParameterOpen] = useState(false)
  const [parameterQuery, setParameterQuery] = useState('')
  const [parameterOptions, setParameterOptions] = useState<PipelineParameterOption[]>([])
  const [parameterLoading, setParameterLoading] = useState(false)
  const isNarrowScreen = useMediaQuery('(max-width: 639px)')
  const visibleSkills = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return skills.filter(skill => `${skill.displayName ?? skill.name} ${skill.name} ${skill.description}`.toLocaleLowerCase().includes(normalized))
  }, [query, skills])

  useEffect(() => {
    if (!parameterOpen || !parameterSkill?.parameterKind) return
    let active = true
    void listPipelineParameterOptions(parameterSkill.parameterKind, parameterQuery)
      .then(response => {
        if (active) setParameterOptions(response.options)
      })
      .catch(() => {
        if (active) setParameterOptions([])
      })
      .finally(() => {
        if (active) setParameterLoading(false)
      })
    return () => { active = false }
  }, [parameterOpen, parameterQuery, parameterSkill])

  function appendSkill(skill: ChatSkill) {
    if (skill.parameterKind && skill.parameterRequired !== false) {
      setParameterSkill(skill)
      setParameterQuery('')
      setParameterOptions([])
      setParameterLoading(true)
      setParameterOpen(true)
      onOpenChange(false)
      return
    }
    const invocation: SubmittedSkillInvocation = {
      invocationId: newInvocationId(),
      skillName: skill.name,
      skillDisplayName: skill.displayName ?? skill.name,
    }
    if (onInvocationAdded) onInvocationAdded(invocation)
    else onChange([...invocations, invocation])
    setQuery('')
    onOpenChange(false)
  }

  function chooseParameter(option: PipelineParameterOption) {
    if (!parameterSkill || !parameterSkill.parameterKind) return
    const invocation: SubmittedSkillInvocation = {
      invocationId: newInvocationId(),
      skillName: parameterSkill.name,
      skillDisplayName: parameterSkill.displayName ?? parameterSkill.name,
      parameterKind: parameterSkill.parameterKind,
      parameterId: option.id,
      parameterDisplayName: option.displayName,
    }
    if (onInvocationAdded) onInvocationAdded(invocation)
    else onChange([...invocations, invocation])
    setParameterOpen(false)
    setParameterSkill(null)
    setParameterQuery('')
    setParameterOptions([])
  }

  function removeInvocation(invocationId: string) {
    onChange(invocations.filter(invocation => invocation.invocationId !== invocationId))
  }

  function handlePickerOpenChange(value: boolean) {
    onOpenChange(value)
    if (!value) setQuery('')
  }

  const skillList = (
    <>
      <div className="relative mb-1.5">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle" />
        <Input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索技能" className="h-8 pl-7 text-xs" />
      </div>
      <div className="max-h-56 overflow-y-auto">
        {visibleSkills.map(skill => {
          const displayName = skill.displayName ?? skill.name
          return (
            <button key={skill.name} type="button" onClick={() => appendSkill(skill)} className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border text-[10px] text-violet-600">@</span>
              <span className="min-w-0"><span className="block truncate font-medium">{displayName}</span><span className="mt-0.5 block truncate text-muted-foreground">{skill.description || skill.name}</span></span>
              {skill.parameterKind && <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">需选择参数</span>}
            </button>
          )
        })}
        {visibleSkills.length === 0 && <div className="px-2 py-4 text-center text-xs text-foreground-subtle">没有匹配的技能</div>}
      </div>
    </>
  )

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {renderInvocations && invocations.map(invocation => {
          const label = invocationLabel(invocation)
          return (
            <span key={invocation.invocationId} className="inline-flex h-7 max-w-full items-center gap-1 rounded-md bg-violet-50 px-2 text-xs text-violet-800 dark:bg-violet-950/50 dark:text-violet-200">
              <span className="truncate">{label}</span>
              <button type="button" disabled={disabled} aria-label={`移除技能：${label}`} onClick={() => removeInvocation(invocation.invocationId)} className="rounded p-0.5 hover:bg-violet-100 disabled:pointer-events-none dark:hover:bg-violet-900">
                <X className="h-3 w-3" />
              </button>
            </span>
          )
        })}
        {isNarrowScreen ? (
          <Sheet open={open} onOpenChange={handlePickerOpenChange}>
            <SheetContent side="bottom" className="max-h-[75vh] rounded-t-xl p-0">
              <SheetHeader className="pb-2">
                <SheetTitle>选择技能</SheetTitle>
                <SheetDescription>选择后会作为一个整体插入消息正文。</SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-4">{skillList}</div>
            </SheetContent>
          </Sheet>
        ) : (
          <Popover open={open} onOpenChange={handlePickerOpenChange}>
            {showTrigger && <PopoverTrigger
              disabled={disabled}
              render={<button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50" />}
            >
              <Plus className="h-3.5 w-3.5" />@ 添加技能
            </PopoverTrigger>}
            <PopoverContent anchor={anchor ?? undefined} align="start" className="w-80 p-2">
              {skillList}
            </PopoverContent>
          </Popover>
        )}
      </div>

      <Dialog open={parameterOpen} onOpenChange={value => { setParameterOpen(value); if (!value) setParameterSkill(null) }}>
        <DialogContent size="md" className="sm:max-w-lg" showCloseButton={!parameterLoading}>
          <DialogHeader>
            <DialogTitle>选择{parameterSkill?.parameterKind === 'publish_account' ? '发布账号' : '写作方案'}</DialogTitle>
            <DialogDescription>只显示当前可用的实体；选定后会在创建 Pipeline 时由服务端冻结快照。</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
            <Input autoFocus value={parameterQuery} onChange={event => { setParameterLoading(true); setParameterQuery(event.target.value) }} placeholder="搜索名称、策略或标签" className="pl-9" />
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-border p-1">
            {parameterLoading ? <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />加载中…</div> : parameterOptions.map(option => (
              <button key={option.id} type="button" onClick={() => chooseParameter(option)} className={cn('flex w-full items-start gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted', 'focus-visible:bg-muted')}>
                <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-violet-200 dark:border-violet-800" />
                <span className="min-w-0"><span className="block truncate font-medium">{option.displayName}</span><span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">{option.summary}</span></span>
              </button>
            ))}
            {!parameterLoading && parameterOptions.length === 0 && <div className="px-3 py-8 text-center text-sm text-foreground-subtle">没有匹配的可用选项</div>}
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><ChevronLeft className="h-3.5 w-3.5" />可以关闭窗口返回技能列表</div>
        </DialogContent>
      </Dialog>
    </>
  )
}
