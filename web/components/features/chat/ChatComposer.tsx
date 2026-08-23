'use client'

import { useLayoutEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { Loader2, MessageSquarePlus, Send } from 'lucide-react'

import { ChatContextPicker } from '@/components/features/chat/ChatContextPicker'
import { ChatSkillPipelinePicker } from '@/components/features/chat/ChatSkillPipelinePicker'
import { Button } from '@/components/ui/button'
import type { ChatComposerMessagePart, ChatDraft, ChatSkill, SubmittedSkillInvocation } from '@/lib/api/chat'
import { cn } from '@/lib/utils'

import { shouldSubmitChatComposerKey } from '@/app/chat/chat-composer'
import { chatComposerColumn } from '@/app/chat/chat-layout'

function invocationLabel(invocation: SubmittedSkillInvocation) {
  return invocation.parameterDisplayName
    ? `@${invocation.skillDisplayName}:${invocation.parameterDisplayName}`
    : `@${invocation.skillDisplayName}`
}

function createInvocationToken(invocation: SubmittedSkillInvocation) {
  const token = document.createElement('span')
  token.setAttribute('contenteditable', 'false')
  token.dataset.skillInvocationId = invocation.invocationId
  token.className = 'mx-0.5 inline-flex max-w-full select-all items-center rounded-md bg-primary/10 px-1.5 py-0.5 text-primary ring-1 ring-primary/20'
  token.textContent = invocationLabel(invocation)
  return token
}

function isEditorBlock(node: Node) {
  return node instanceof HTMLElement && (node.tagName === 'DIV' || node.tagName === 'P')
}

function objectiveText(editor: HTMLElement) {
  const read = (node: Node): string => {
    if (node instanceof HTMLElement && node.dataset.skillInvocationId) return ''
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (node instanceof HTMLBRElement) return '\n'
    let result = ''
    node.childNodes.forEach(child => {
      const text = read(child)
      if (isEditorBlock(child) && result && !result.endsWith('\n')) result += '\n'
      result += text
    })
    return result
  }
  return read(editor)
}

function composerMessageParts(
  editor: HTMLElement,
  invocations: SubmittedSkillInvocation[],
): ChatComposerMessagePart[] {
  const invocationById = new Map(invocations.map(invocation => [invocation.invocationId, invocation]))
  const parts: ChatComposerMessagePart[] = []
  const appendText = (text: string) => {
    if (!text) return
    const previous = parts.at(-1)
    if (previous?.type === 'text') previous.text += text
    else parts.push({ type: 'text', text })
  }
  const read = (node: Node) => {
    if (node instanceof HTMLElement && node.dataset.skillInvocationId) {
      const invocation = invocationById.get(node.dataset.skillInvocationId)
      if (invocation) parts.push({ type: 'skill-invocation', ...invocation })
      return
    }
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node.textContent ?? '')
      return
    }
    if (node instanceof HTMLBRElement) {
      appendText('\n')
      return
    }
    node.childNodes.forEach(child => {
      const previous = parts.at(-1)
      if (isEditorBlock(child) && parts.length > 0
        && !(previous?.type === 'text' && previous.text.endsWith('\n'))) {
        appendText('\n')
      }
      read(child)
    })
  }
  read(editor)
  return parts
}

function orderedEditorInvocations(
  editor: HTMLElement,
  invocations: SubmittedSkillInvocation[],
) {
  const invocationById = new Map(invocations.map(invocation => [invocation.invocationId, invocation]))
  return Array.from(editor.querySelectorAll<HTMLElement>('[data-skill-invocation-id]'))
    .map(token => invocationById.get(token.dataset.skillInvocationId ?? ''))
    .filter((invocation): invocation is SubmittedSkillInvocation => Boolean(invocation))
}

function setEditorEmptyState(editor: HTMLElement) {
  editor.dataset.empty = editor.textContent ? 'false' : 'true'
}

function currentEditorRange(editor: HTMLElement) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    return range
  }
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.commonAncestorContainer)) {
    const fallback = document.createRange()
    fallback.selectNodeContents(editor)
    fallback.collapse(false)
    return fallback
  }
  return range.cloneRange()
}

function adjacentInvocationToken(editor: HTMLElement, range: Range, direction: 'backward' | 'forward') {
  if (!range.collapsed) return null
  const container = range.startContainer
  const edgeToken = (node: ChildNode | null): HTMLElement | null => {
    let current = node
    while (current) {
      if (current instanceof HTMLElement && current.dataset.skillInvocationId) return current
      current = direction === 'backward' ? current.lastChild : current.firstChild
    }
    return null
  }
  const adjacentSiblingToken = (node: Node): HTMLElement | null => {
    let current: Node | null = node
    while (current && current !== editor) {
      const sibling = direction === 'backward' ? current.previousSibling : current.nextSibling
      if (sibling) return edgeToken(sibling)
      current = current.parentNode
    }
    return null
  }

  if (container.nodeType === Node.TEXT_NODE) {
    const text = container.textContent ?? ''
    if (direction === 'backward' && range.startOffset !== 0) return null
    if (direction === 'forward' && range.startOffset !== text.length) return null
    return adjacentSiblingToken(container)
  }
  if (container instanceof HTMLElement) {
    const index = direction === 'backward' ? range.startOffset - 1 : range.startOffset
    const child = container.childNodes[index] ?? null
    return child ? edgeToken(child) : adjacentSiblingToken(container)
  }
  return null
}

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
  onSubmit: (value: string, messageParts: ChatComposerMessagePart[]) => boolean | Promise<boolean>
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
  const editorRef = useRef<HTMLDivElement>(null)
  const insertionRangeRef = useRef<Range | null>(null)

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const tokens = Array.from(editor.querySelectorAll<HTMLElement>('[data-skill-invocation-id]'))
    if (tokens.length > 0 && pipelineInvocations.length === 0) {
      editor.textContent = value
      setEditorEmptyState(editor)
      return
    }
    const invocationIds = new Set(pipelineInvocations.map(invocation => invocation.invocationId))
    tokens.forEach(token => {
      if (!invocationIds.has(token.dataset.skillInvocationId ?? '')) token.remove()
    })
    const currentText = objectiveText(editor)
    if (currentText === value) return
    if (pipelineInvocations.length === 0) editor.textContent = value
    setEditorEmptyState(editor)
  }, [pipelineInvocations, value])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || !value.trim()) return
    const editor = editorRef.current
    if (!editor) return
    const messageParts = composerMessageParts(editor, pipelineInvocations)
    const submittedNodes = Array.from(editor.childNodes, node => node.cloneNode(true))
    editor.replaceChildren()
    insertionRangeRef.current = null
    setEditorEmptyState(editor)
    onChange('')

    const submitted = await onSubmit(value, messageParts)
    if (submitted) {
      onPipelineInvocationsChange([])
      return
    }

    editor.replaceChildren(...submittedNodes)
    setEditorEmptyState(editor)
    onChange(value)
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    insertionRangeRef.current = range.cloneRange()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.nativeEvent.isComposing) {
      const range = currentEditorRange(event.currentTarget)
      const token = adjacentInvocationToken(
        event.currentTarget,
        range,
        event.key === 'Backspace' ? 'backward' : 'forward',
      )
      if (token) {
        event.preventDefault()
        const invocationId = token.dataset.skillInvocationId
        const parent = token.parentNode
        const index = parent ? Array.from(parent.childNodes).indexOf(token) : -1
        token.remove()
        if (parent && index >= 0) {
          const nextRange = document.createRange()
          nextRange.setStart(parent, Math.min(index, parent.childNodes.length))
          nextRange.collapse(true)
          const selection = window.getSelection()
          selection?.removeAllRanges()
          selection?.addRange(nextRange)
          insertionRangeRef.current = nextRange.cloneRange()
        }
        setEditorEmptyState(event.currentTarget)
        onPipelineInvocationsChange(pipelineInvocations.filter(invocation => invocation.invocationId !== invocationId))
        onChange(objectiveText(event.currentTarget))
        return
      }
    }
    if (event.key === '@'
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && !event.nativeEvent.isComposing) {
      event.preventDefault()
      const range = currentEditorRange(event.currentTarget)
      range.deleteContents()
      const atNode = document.createTextNode('@')
      range.insertNode(atNode)
      const insertionRange = document.createRange()
      insertionRange.selectNode(atNode)
      insertionRangeRef.current = insertionRange
      const caretRange = document.createRange()
      caretRange.setStartAfter(atNode)
      caretRange.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(caretRange)
      setEditorEmptyState(event.currentTarget)
      onChange(objectiveText(event.currentTarget))
      setSkillPickerOpen(true)
      return
    }
    if (!shouldSubmitChatComposerKey({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    })) return
    event.preventDefault()
    event.currentTarget.closest('form')?.requestSubmit()
  }

  function handleInput() {
    const editor = editorRef.current
    if (!editor) return
    setEditorEmptyState(editor)
    onChange(objectiveText(editor))
    const nextInvocations = orderedEditorInvocations(editor, pipelineInvocations)
    if (nextInvocations.length !== pipelineInvocations.length
      || nextInvocations.some((invocation, index) => invocation.invocationId !== pipelineInvocations[index]?.invocationId)) {
      onPipelineInvocationsChange(nextInvocations)
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    const range = currentEditorRange(event.currentTarget)
    range.deleteContents()
    const textNode = document.createTextNode(text)
    range.insertNode(textNode)
    const nextRange = document.createRange()
    nextRange.setStartAfter(textNode)
    nextRange.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(nextRange)
    insertionRangeRef.current = nextRange.cloneRange()
    setEditorEmptyState(event.currentTarget)
    onChange(objectiveText(event.currentTarget))
    onPipelineInvocationsChange(orderedEditorInvocations(event.currentTarget, pipelineInvocations))
  }

  function handleInvocationAdded(invocation: SubmittedSkillInvocation) {
    const editor = editorRef.current
    if (!editor) return
    const token = createInvocationToken(invocation)
    const range = insertionRangeRef.current
    if (range && editor.contains(range.commonAncestorContainer)) {
      range.deleteContents()
      range.insertNode(token)
    } else {
      editor.append(token)
    }
    const nextRange = document.createRange()
    nextRange.setStartAfter(token)
    nextRange.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(nextRange)
    insertionRangeRef.current = nextRange.cloneRange()
    setEditorEmptyState(editor)
    onPipelineInvocationsChange(orderedEditorInvocations(editor, [...pipelineInvocations, invocation]))
    onChange(objectiveText(editor))
    editor.focus()
  }

  function handleSkillPickerOpenChange(open: boolean) {
    setSkillPickerOpen(open)
    if (open) return
    const editor = editorRef.current
    const range = insertionRangeRef.current
    if (!editor || !range || !editor.contains(range.commonAncestorContainer)) return
    editor.focus()
    const caretRange = range.cloneRange()
    caretRange.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(caretRange)
  }

  return (
    <form onSubmit={submit} className={cn('shrink-0 py-4', isFloating ? 'px-3' : undefined)}>
      <div className={isFloating ? 'w-full' : chatComposerColumn}>
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-control p-3 transition-colors focus-within:border-indigo-400">
          <div className="flex min-w-0">
            <div
              ref={editorRef}
              role="textbox"
              aria-label="消息内容"
              aria-multiline="true"
              contentEditable={!disabled}
              data-empty="true"
              onInput={handleInput}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              suppressContentEditableWarning
              className="max-h-40 min-h-12 flex-1 overflow-y-auto whitespace-pre-wrap break-words bg-transparent py-1 text-sm leading-6 outline-none before:pointer-events-none before:text-foreground-subtle before:content-[attr(data-placeholder)] data-[empty=false]:before:content-none data-[disabled=true]:cursor-not-allowed"
              data-placeholder="问问本地信息源里的内容…"
              data-disabled={disabled}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ChatSkillPipelinePicker
              skills={skills}
              invocations={pipelineInvocations}
              open={skillPickerOpen}
              disabled={disabled}
              renderInvocations={false}
              showTrigger={false}
              anchor={() => editorRef.current}
              onOpenChange={handleSkillPickerOpenChange}
              onChange={onPipelineInvocationsChange}
              onInvocationAdded={handleInvocationAdded}
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
