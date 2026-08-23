'use client'

import { useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react'
import { Loader2, MessageSquarePlus, Send } from 'lucide-react'

import { ChatContextPicker } from '@/components/features/chat/ChatContextPicker'
import { ChatSkillPipelinePicker } from '@/components/features/chat/ChatSkillPipelinePicker'
import { Button } from '@/components/ui/button'
import type { ChatDraft, ChatSkill, SubmittedSkillInvocation } from '@/lib/api/chat'
import { cn } from '@/lib/utils'

import { shouldSubmitChatComposerKey } from '@/app/chat/chat-composer'
import { chatComposerColumn } from '@/app/chat/chat-layout'

export type ChatComposerProps = {
  value: string
  skills: ChatSkill[]
  drafts: ChatDraft[]
  skillName: string
  draftId: number | null
  pipelineInvocations: SubmittedSkillInvocation[]
  disabled: boolean
  variant: 'page' | 'floating'
  onChange: (value: string) => void
  onSkillNameChange: (skillName: string | undefined) => void
  onDraftIdChange: (draftId: number | undefined) => void
  onPipelineInvocationsChange: (invocations: SubmittedSkillInvocation[]) => void
  onSubmit: (value: string) => void | Promise<void>
}

export function ChatComposer({
  value,
  skills,
  drafts,
  skillName,
  draftId,
  pipelineInvocations,
  disabled,
  variant,
  onChange,
  onSkillNameChange,
  onDraftIdChange,
  onPipelineInvocationsChange,
  onSubmit,
}: ChatComposerProps) {
  const isFloating = variant === 'floating'
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !value.trim()) return
    void onSubmit(value)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === '@' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      setSkillPickerOpen(true)
      return
    }
    if (!shouldSubmitChatComposerKey({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    })) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    onChange(event.target.value)
  }

  return (
    <form onSubmit={submit} className={cn('shrink-0 py-4', isFloating ? 'px-3' : undefined)}>
      <div className={isFloating ? 'w-full' : chatComposerColumn}>
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-control p-3 transition-colors focus-within:border-indigo-400">
          <div className="flex">
            <textarea
              value={value}
              onChange={handleChange}
              disabled={disabled}
              rows={2}
              onKeyDown={handleKeyDown}
              placeholder="问问本地信息源里的内容…"
              className="max-h-40 min-h-12 flex-1 resize-none bg-transparent py-1 text-sm leading-6 outline-none placeholder:text-foreground-subtle disabled:cursor-not-allowed"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ChatSkillPipelinePicker
              skills={skills}
              invocations={pipelineInvocations}
              open={skillPickerOpen}
              disabled={disabled}
              onOpenChange={setSkillPickerOpen}
              onChange={onPipelineInvocationsChange}
            />
            <ChatContextPicker
              skills={[]}
              drafts={drafts}
              showSkills={false}
              skillName={skillName || undefined}
              draftId={draftId ?? undefined}
              disabled={disabled}
              footerAction={(
                <Button type="submit" size="icon" disabled={!value.trim() || disabled} title="发送消息" aria-label="发送消息">
                  {disabled ? <Loader2 className="animate-spin" /> : <Send />}
                </Button>
              )}
              onSkillNameChange={onSkillNameChange}
              onDraftIdChange={onDraftIdChange}
            />
          </div>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-foreground-subtle">
          <MessageSquarePlus className="h-3 w-3" />新对话会在发送第一条消息时创建。
        </p>
      </div>
    </form>
  )
}
