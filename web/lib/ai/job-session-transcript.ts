import type { AgentSessionEvent } from './agent-trajectory'

export type JobSessionEntry = {
  id: string
  kind: 'user' | 'assistant' | 'tool'
  title: string
  text: string
  reasoning: string
  argumentsText: string
  outputText: string
  error: string
  failed: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

export function sessionText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(part => {
      if (typeof part === 'string') return part
      const item = record(part)
      return textValue(item?.text ?? item?.content)
    }).filter(Boolean).join('\n')
  }
  return ''
}

function pretty(value: unknown) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
}

function assistantParts(data: Record<string, unknown>) {
  const blocks = Array.isArray(data.blocks) ? data.blocks : []
  const text: string[] = []
  const reasoning: string[] = []
  for (const block of blocks) {
    const item = record(block)
    if (!item) continue
    const kind = textValue(item.kind || item.type).toLowerCase()
    const body = textValue(item.text ?? item.content)
    if (!body) continue
    if (kind === 'reasoning' || kind === 'thinking') reasoning.push(body)
    else text.push(body)
  }
  return { text: text.join('\n\n'), reasoning: reasoning.join('\n\n') }
}

function emptyTool(id: string, name: string): JobSessionEntry {
  return {
    id,
    kind: 'tool',
    title: name || '工具',
    text: '',
    reasoning: '',
    argumentsText: '',
    outputText: '',
    error: '',
    failed: false,
  }
}

export function buildJobSession(events: readonly AgentSessionEvent[]): JobSessionEntry[] {
  const entries: JobSessionEntry[] = []
  const tools = new Map<string, JobSessionEntry>()
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = sessionText(event.data.content).trim()
      if (!text) continue
      entries.push({
        id: `user:${event.seq}`,
        kind: 'user',
        title: '任务要求',
        text,
        reasoning: '',
        argumentsText: '',
        outputText: '',
        error: '',
        failed: false,
      })
      continue
    }
    if (event.type === 'assistant/message') {
      const parts = assistantParts(event.data)
      if (!parts.text && !parts.reasoning) continue
      entries.push({
        id: `assistant:${event.seq}`,
        kind: 'assistant',
        title: parts.text ? '助手' : '思考',
        text: parts.text,
        reasoning: parts.reasoning,
        argumentsText: '',
        outputText: '',
        error: '',
        failed: false,
      })
      continue
    }
    if (event.type === 'tool/call') {
      const callId = textValue(event.data.callId) || `call:${event.seq}`
      const entry = emptyTool(`tool:${callId}`, textValue(event.data.name) || '工具')
      entry.argumentsText = pretty(event.data.arguments ?? event.data.input ?? event.data.argsRaw)
      tools.set(callId, entry)
      entries.push(entry)
      continue
    }
    if (event.type === 'tool/result') {
      const callId = textValue(event.data.callId) || `result:${event.seq}`
      const entry = tools.get(callId) ?? emptyTool(`tool:${callId}`, '工具')
      if (!tools.has(callId)) entries.push(entry)
      tools.set(callId, entry)
      entry.outputText = pretty(event.data.output ?? event.data.result ?? event.data.content)
      entry.error = textValue(event.data.error)
      entry.failed = event.data.isError === true || entry.error.length > 0
    }
  }
  return entries
}
