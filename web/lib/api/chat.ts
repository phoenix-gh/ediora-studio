import { apiFetch } from './client'

export type ChatRole = 'user' | 'assistant' | 'tool'

export type ChatPart = {
  type: string
  [key: string]: unknown
}

export type ChatMessage = {
  id: number
  role: ChatRole
  parts: ChatPart[]
  text: string
  created_at: string
}

export type ChatSession = {
  id: number
  title: string
  created_at: string
  updated_at: string
}

export type ChatSessionDetail = ChatSession & {
  messages: ChatMessage[]
  is_running: boolean
}

export type ChatSkill = { name: string; description: string; version: string }
export type ChatDraft = { id: number; title: string; status: string; updated_at: string }
export type ChatToolApproval = { messageId: number; toolCallId: string; approvalId: string; approved: boolean }

export type UIChatMessage = {
  id: string
  role: Exclude<ChatRole, 'tool'>
  parts: ChatPart[]
}

export type UIMessageStreamEvent = Record<string, unknown> & {
  type: string
}

export async function listChatSessions(): Promise<ChatSession[]> {
  return apiFetch<ChatSession[]>('/chat/sessions')
}

export async function createChatSession(title = '新对话'): Promise<ChatSession> {
  return apiFetch<ChatSession>('/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export async function renameChatSession(sessionId: number, title: string): Promise<ChatSession> {
  return apiFetch<ChatSession>(`/chat/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export async function getChatSession(sessionId: number): Promise<ChatSessionDetail> {
  return apiFetch<ChatSessionDetail>(`/chat/sessions/${sessionId}`)
}

export async function deleteChatSession(sessionId: number) {
  await apiFetch<void>(`/chat/sessions/${sessionId}`, { method: 'DELETE' })
}

export async function listChatSkills(): Promise<ChatSkill[]> {
  const response = await fetch('/api/chat/skills', { cache: 'no-store' })
  if (!response.ok) throw new Error('Unable to load local skills')
  return response.json()
}

export async function listChatDrafts(): Promise<ChatDraft[]> {
  return apiFetch<ChatDraft[]>('/write/drafts')
}

export function toUIChatMessages(messages: ChatMessage[]): UIChatMessage[] {
  return messages
    .filter((message): message is ChatMessage & { role: Exclude<ChatRole, 'tool'> } => message.role !== 'tool')
    .map(message => ({
      id: `persisted-${message.id}`,
      role: message.role,
      parts: message.parts.length > 0 ? message.parts : message.text ? [{ type: 'text', text: message.text }] : [],
    }))
}

function parseSseBlock(block: string): UIMessageStreamEvent | null {
  const data = block
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return null
  try {
    const event = JSON.parse(data) as unknown
    return event && typeof event === 'object' && 'type' in event && typeof event.type === 'string'
      ? event as UIMessageStreamEvent
      : null
  } catch {
    return null
  }
}

export async function consumeUIMessageStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: UIMessageStreamEvent) => void,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const consumeBuffer = (flush = false) => {
    const chunks = buffer.split(/\r?\n\r?\n/)
    buffer = flush ? '' : (chunks.pop() ?? '')
    for (const block of flush ? chunks : chunks) {
      const event = parseSseBlock(block)
      if (event) onEvent(event)
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (value) {
        buffer += decoder.decode(value, { stream: !done })
        consumeBuffer(done)
      }
      if (done) break
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeBuffer(true)
  } finally {
    reader.releaseLock()
  }
}

export async function streamChatReply({
  sessionId,
  messages,
  skillName,
  draftId,
  approval,
  signal,
  onEvent,
}: {
  sessionId: number
  messages: UIChatMessage[]
  skillName?: string
  draftId?: number
  approval?: ChatToolApproval
  signal?: AbortSignal
  onEvent: (event: UIMessageStreamEvent) => void
}) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, messages, skillName, draftId, approval }),
    signal,
  })
  if (!response.ok) {
    let detail = ''
    try { detail = (await response.json() as { error?: string }).error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `Chat request failed (${response.status})`)
  }
  if (!response.body) throw new Error('Chat response did not include a stream')
  await consumeUIMessageStream(response.body, onEvent)
}
