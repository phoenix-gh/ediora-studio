'use client'

import { type ReactNode, useMemo, useState } from 'react'
import { Check, FileText, Plus, Search, Sparkles, X } from 'lucide-react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ChatDraft, ChatSkill } from '@/lib/api/chat'
import { cn } from '@/lib/utils'

type Props = {
  skills: ChatSkill[]
  drafts: ChatDraft[]
  showSkills?: boolean
  skillName?: string
  draftId?: number
  disabled: boolean
  footerAction?: ReactNode
  onSkillNameChange: (skillName: string | undefined) => void
  onDraftIdChange: (draftId: number | undefined) => void
}

export function ChatContextPicker({
  skills,
  drafts,
  showSkills = true,
  skillName,
  draftId,
  disabled,
  footerAction,
  onSkillNameChange,
  onDraftIdChange,
}: Props) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [draftDialogOpen, setDraftDialogOpen] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [draftQuery, setDraftQuery] = useState('')
  const selectedSkill = skills.find(skill => skill.name === skillName)
  const selectedDraft = drafts.find(draft => draft.id === draftId)
  const visibleSkills = useMemo(
    () => skills.filter(skill => skill.name.toLocaleLowerCase().includes(skillQuery.toLocaleLowerCase())),
    [skillQuery, skills],
  )
  const visibleDrafts = useMemo(
    () => drafts.filter(draft => draft.title.toLocaleLowerCase().includes(draftQuery.toLocaleLowerCase())),
    [draftQuery, drafts],
  )

  function chooseSkill(nextSkillName: string) {
    onSkillNameChange(nextSkillName)
    setPopoverOpen(false)
    setSkillQuery('')
  }

  function openDraftDialog() {
    setPopoverOpen(false)
    setDraftQuery('')
    setDraftDialogOpen(true)
  }

  function chooseDraft(nextDraftId: number) {
    onDraftIdChange(nextDraftId)
    setDraftDialogOpen(false)
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {selectedSkill && (
          <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-md bg-violet-50 px-2 text-xs text-violet-800 dark:bg-violet-950/50 dark:text-violet-200">
            <Sparkles className="h-3 w-3 shrink-0" />
            <span className="truncate">{selectedSkill.name}</span>
            <button type="button" onClick={() => onSkillNameChange(undefined)} disabled={disabled} aria-label={`移除技能：${selectedSkill.name}`} className="rounded p-0.5 hover:bg-violet-100 disabled:pointer-events-none dark:hover:bg-violet-900"><X className="h-3 w-3" /></button>
          </span>
        )}
        {selectedDraft && (
          <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-md bg-sky-50 px-2 text-xs text-sky-800 dark:bg-sky-950/50 dark:text-sky-200">
            <FileText className="h-3 w-3 shrink-0" />
            <span className="max-w-44 truncate">{selectedDraft.title || `草稿 #${selectedDraft.id}`}</span>
            <button type="button" onClick={() => onDraftIdChange(undefined)} disabled={disabled} aria-label={`移除草稿：${selectedDraft.title || selectedDraft.id}`} className="rounded p-0.5 hover:bg-sky-100 disabled:pointer-events-none dark:hover:bg-sky-900"><X className="h-3 w-3" /></button>
          </span>
        )}
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger
            disabled={disabled}
            render={<button type="button" className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50" />}
          >
            <Plus className="h-3.5 w-3.5" />添加上下文
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-2">
            {showSkills && <>
              <div className="px-1 pb-2 pt-1 text-xs font-medium text-muted-foreground">技能</div>
              <div className="relative mb-1.5">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle" />
                <Input value={skillQuery} onChange={event => setSkillQuery(event.target.value)} placeholder="搜索技能…" className="h-8 pl-7 text-xs" />
              </div>
              <div className="max-h-40 overflow-y-auto">
                {visibleSkills.map(skill => (
                  <button key={skill.name} type="button" onClick={() => chooseSkill(skill.name)} className={cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted', selectedSkill?.name === skill.name && 'bg-violet-50 text-violet-800 dark:bg-violet-950/50 dark:text-violet-200')}>
                    <Check className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', selectedSkill?.name === skill.name ? 'opacity-100' : 'opacity-0')} />
                    <span className="min-w-0"><span className="block truncate font-medium">{skill.name}</span>{skill.description && <span className="mt-0.5 block line-clamp-2 text-muted-foreground">{skill.description}</span>}</span>
                  </button>
                ))}
                {visibleSkills.length === 0 && <div className="px-2 py-3 text-center text-xs text-foreground-subtle">没有匹配的技能</div>}
              </div>
              <div className="my-2 border-t border-border" />
            </>}
            <button type="button" onClick={openDraftDialog} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs font-medium text-foreground hover:bg-muted">
              <FileText className="h-3.5 w-3.5 text-sky-600" />选择草稿…
            </button>
          </PopoverContent>
        </Popover>
        {footerAction && <span className="ml-auto">{footerAction}</span>}
      </div>

      <Dialog open={draftDialogOpen} onOpenChange={setDraftDialogOpen}>
        <DialogContent className="sm:max-w-lg" showCloseButton={!disabled}>
          <DialogHeader>
            <DialogTitle>选择草稿</DialogTitle>
            <DialogDescription>草稿正文只会在发送时由服务端读取。</DialogDescription>
          </DialogHeader>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle" />
            <Input autoFocus value={draftQuery} onChange={event => setDraftQuery(event.target.value)} placeholder="搜索草稿" className="pl-9" />
          </div>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-border p-1">
            {visibleDrafts.map(draft => (
              <button key={draft.id} type="button" disabled={disabled} onClick={() => chooseDraft(draft.id)} className={cn('flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted disabled:pointer-events-none disabled:opacity-50', selectedDraft?.id === draft.id && 'bg-sky-50 text-sky-900 dark:bg-sky-950/50 dark:text-sky-100')}>
                <FileText className="h-4 w-4 shrink-0 text-sky-600" />
                <span className="truncate">{draft.title || `草稿 #${draft.id}`}</span>
                {selectedDraft?.id === draft.id && <Check className="ml-auto h-4 w-4 shrink-0" />}
              </button>
            ))}
            {visibleDrafts.length === 0 && <div className="px-3 py-8 text-center text-sm text-foreground-subtle">没有匹配的草稿</div>}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
