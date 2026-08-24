import type {
  ChatPart,
  ChatRole,
  UIChatMessage,
  UIMessageStreamEvent,
} from '@/lib/api/chat'

import type { DisplayMessage, ToolEventPart } from './chat-workspace-types'

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

export function applyChatStreamEvent(
  messages: DisplayMessage[],
  assistantMessageId: string,
  event: UIMessageStreamEvent,
): DisplayMessage[] {
  if (event.type === 'reasoning-start') {
    const partId = typeof event.id === 'string' ? event.id : 'reasoning'
    return updateAssistantMessage(messages, assistantMessageId, parts => (
      updateReasoningPart(parts, partId, current => ({
        type: 'reasoning', id: partId,
        text: String(current?.text ?? ''), state: 'streaming',
      }))
    ))
  }

  if (event.type === 'reasoning-delta') {
    const partId = typeof event.id === 'string' ? event.id : 'reasoning'
    const delta = typeof event.delta === 'string' ? event.delta : ''
    return updateAssistantMessage(messages, assistantMessageId, parts => (
      updateReasoningPart(parts, partId, current => ({
        type: 'reasoning', id: partId,
        text: String(current?.text ?? '') + delta, state: 'streaming',
      }))
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
    return updateAssistantMessage(messages, assistantMessageId, parts => updateTextPart(parts, partId, delta))
  }

  if (
    event.type === 'tool-input-start'
    || event.type === 'tool-input-available'
    || event.type === 'tool-output-available'
  ) {
    return updateAssistantMessage(messages, assistantMessageId, parts => updateToolPart(parts, event))
  }

  if (event.type === 'error') {
    const detail = typeof event.errorText === 'string' ? event.errorText : '聊天响应失败'
    return updateAssistantMessage(messages, assistantMessageId, parts => [
      ...parts,
      { type: 'text', text: '\n' + detail },
    ])
  }

  return messages
}
