import type {
  ChatPart,
  ChatRole,
  ChatStreamStatus,
  UIChatMessage,
  UIMessageStreamEvent,
} from '@/lib/api/chat'

import type { ChatStatusPart, DisplayMessage, ToolEventPart } from './chat-workspace-types'

export const CHAT_STATUS_PART_ID = 'chat-activity'

function localId(prefix: string) {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid
    ? prefix + '-' + uuid
    : prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2)
}

export function makeLocalMessage(
  role: Exclude<ChatRole, 'tool'>,
  parts: ChatPart[],
): DisplayMessage {
  return {
    id: localId('local'),
    role,
    parts,
    text: parts
      .filter(part => part.type === 'text')
      .map(part => String(part.text ?? ''))
      .join(''),
    created_at: new Date().toISOString(),
  }
}

export function toModelMessages(messages: DisplayMessage[]): UIChatMessage[] {
  return messages
    .filter((message): message is DisplayMessage & { role: Exclude<ChatRole, 'tool'> } => message.role !== 'tool')
    .map(message => ({
      id: String(message.id),
      role: message.role,
      parts: message.parts.filter(part => part.type === 'text'),
    }))
    .filter(message => message.parts.length > 0)
}

function updateAssistantMessage(
  messages: DisplayMessage[],
  assistantMessageId: string,
  update: (parts: ChatPart[]) => ChatPart[],
) {
  return messages.map(message => message.id === assistantMessageId
    ? { ...message, parts: update(message.parts) }
    : message)
}

function updateTextPart(parts: ChatPart[], partId: string, delta: string) {
  const index = parts.findIndex(part => part.type === 'text' && part.id === partId)
  if (index < 0) return [...parts, { type: 'text', id: partId, text: delta }]
  return parts.map((part, currentIndex) => currentIndex === index
    ? { ...part, text: String(part.text ?? '') + delta }
    : part)
}

function updateReasoningPart(
  parts: ChatPart[],
  partId: string,
  update: (current: ChatPart | undefined) => ChatPart,
) {
  const index = parts.findIndex(part => part.type === 'reasoning' && part.id === partId)
  const current = index < 0 ? undefined : parts[index]
  const next = update(current)
  return index < 0
    ? [...parts, next]
    : parts.map((part, currentIndex) => currentIndex === index ? next : part)
}

function updateToolPart(parts: ChatPart[], event: UIMessageStreamEvent) {
  const toolCallId = typeof event.toolCallId === 'string'
    ? event.toolCallId
    : typeof event.id === 'string'
      ? event.id
      : 'unknown-tool'
  const current = parts.find(part => part.type === 'tool-event' && part.toolCallId === toolCallId) as ToolEventPart | undefined
  const next: ToolEventPart = {
    ...(current ?? { type: 'tool-event', toolCallId }),
    toolName: typeof event.toolName === 'string' ? event.toolName : current?.toolName,
    input: event.type === 'tool-input-available' ? event.input : current?.input,
    output: event.type === 'tool-output-available' ? event.output : current?.output,
    state: event.type === 'tool-output-available' ? 'completed' : 'running',
  }
  return current
    ? parts.map(part => part === current ? next : part)
    : [...parts, next]
}

function updateStatusPart(parts: ChatPart[], status: ChatStreamStatus) {
  const index = parts.findIndex(part => part.type === 'chat-status' && part.id === CHAT_STATUS_PART_ID)
  const current = index < 0 ? undefined : parts[index]
  const next: ChatStatusPart = {
    ...(current ?? {}),
    ...status,
    type: 'chat-status',
    id: CHAT_STATUS_PART_ID,
  }
  return index < 0
    ? [next, ...parts]
    : parts.map((part, currentIndex) => currentIndex === index ? next : part)
}

function statusFromEvent(event: UIMessageStreamEvent): ChatStreamStatus | null {
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return null
  const data = event.data as Record<string, unknown>
  if (
    (data.phase !== 'thinking' && data.phase !== 'skill' && data.phase !== 'answer')
    || (data.state !== 'streaming' && data.state !== 'complete' && data.state !== 'error')
    || typeof data.label !== 'string'
  ) return null
  return {
    phase: data.phase,
    state: data.state,
    label: data.label,
    ...(typeof data.detail === 'string' ? { detail: data.detail } : {}),
    ...(typeof data.skillName === 'string' ? { skillName: data.skillName } : {}),
    ...(typeof data.skillDisplayName === 'string' ? { skillDisplayName: data.skillDisplayName } : {}),
  }
}

export function initialChatStatusPart(): ChatStatusPart {
  return {
    type: 'chat-status',
    id: CHAT_STATUS_PART_ID,
    phase: 'thinking',
    state: 'streaming',
    label: '正在思考',
    detail: '正在分析你的请求',
  }
}

export function approvalResumeMessage() {
  return makeLocalMessage('assistant', [initialChatStatusPart()])
}

export function applyApprovalDecision(
  messages: DisplayMessage[],
  decision: { messageId: number; toolCallId: string; approvalId: string; approved: boolean },
) {
  return messages.map(message => message.id !== decision.messageId
    ? message
    : {
        ...message,
        parts: message.parts.map(part => {
          const approval = part.approval && typeof part.approval === 'object'
            ? part.approval as Record<string, unknown>
            : undefined
          if (
            part.toolCallId !== decision.toolCallId
            || approval?.id !== decision.approvalId
          ) return part
          return {
            ...part,
            state: 'approval-responded',
            approval: { ...approval, approved: decision.approved },
          }
        }),
      })
}

export function applyChatStreamEvent(
  messages: DisplayMessage[],
  assistantMessageId: string,
  event: UIMessageStreamEvent,
): DisplayMessage[] {
  if (event.type === 'data-chat-status') {
    const status = statusFromEvent(event)
    return status
      ? updateAssistantMessage(messages, assistantMessageId, parts => updateStatusPart(parts, status))
      : messages
  }

  if (event.type === 'start-step') {
    return updateAssistantMessage(messages, assistantMessageId, parts => updateStatusPart(parts, {
      phase: 'thinking',
      state: 'streaming',
      label: '正在思考',
      detail: '正在处理下一步',
    }))
  }

  if (event.type === 'reasoning-start') {
    const partId = typeof event.id === 'string' ? event.id : 'reasoning'
    return updateAssistantMessage(messages, assistantMessageId, parts => updateStatusPart(
      updateReasoningPart(parts, partId, current => ({
        type: 'reasoning', id: partId,
        text: String(current?.text ?? ''), state: 'streaming',
      })),
      {
        phase: 'thinking',
        state: 'streaming',
        label: '正在思考',
        detail: '模型正在整理思路',
      },
    ))
  }

  if (event.type === 'reasoning-delta') {
    const partId = typeof event.id === 'string' ? event.id : 'reasoning'
    const delta = typeof event.delta === 'string' ? event.delta : ''
    return updateAssistantMessage(messages, assistantMessageId, parts => updateStatusPart(
      updateReasoningPart(parts, partId, current => ({
        type: 'reasoning', id: partId,
        text: String(current?.text ?? '') + delta, state: 'streaming',
      })),
      {
        phase: 'thinking',
        state: 'streaming',
        label: '正在思考',
        detail: '模型正在整理思路',
      },
    ))
  }

  if (event.type === 'reasoning-end') {
    const partId = typeof event.id === 'string' ? event.id : 'reasoning'
    return updateAssistantMessage(messages, assistantMessageId, parts => (
      updateReasoningPart(parts, partId, current => ({
        type: 'reasoning', id: partId,
        text: String(current?.text ?? ''), state: 'complete',
      }))
    ))
  }

  if (event.type === 'text-delta') {
    const partId = typeof event.id === 'string' ? event.id : 'text'
    const delta = typeof event.delta === 'string' ? event.delta : ''
    return updateAssistantMessage(messages, assistantMessageId, parts => updateStatusPart(
      updateTextPart(parts, partId, delta),
      {
        phase: 'answer',
        state: 'streaming',
        label: '正在生成回答',
        detail: '回答正在实时生成',
      },
    ))
  }

  if (
    event.type === 'tool-input-start'
    || event.type === 'tool-input-available'
    || event.type === 'tool-output-available'
  ) {
    return updateAssistantMessage(messages, assistantMessageId, parts => updateToolPart(parts, event))
  }

  if (event.type === 'finish') {
    return updateAssistantMessage(messages, assistantMessageId, parts => updateStatusPart(parts, {
      phase: 'answer',
      state: 'complete',
      label: '已完成',
      detail: '回答生成完成',
    }))
  }

  if (event.type === 'error') {
    const detail = typeof event.errorText === 'string' ? event.errorText : '聊天响应失败'
    return updateAssistantMessage(messages, assistantMessageId, parts => updateStatusPart([
      ...parts,
      { type: 'text', text: '\n' + detail },
    ], {
      phase: 'thinking',
      state: 'error',
      label: '处理失败',
      detail,
    }))
  }

  return messages
}
