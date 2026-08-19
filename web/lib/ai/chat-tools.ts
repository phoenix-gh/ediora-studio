import { tool } from 'ai'
import { z } from 'zod'

import type { AgentCapabilitySnapshot } from './agent-capabilities'

export const chatToolNames = [
  'searchInformationSources',
  'readInformationSource',
] as const

export const searchInformationSourcesSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(10),
})

export const readInformationSourceSchema = z.object({
  source: z.literal('writing_plan'),
  id: z.number().int().positive(),
})

type ChatToolOptions = {
  apiBase: string
  sessionId: number
}

type PersistedChatMessage = {
  id: number
  role: 'user' | 'assistant' | 'tool'
  parts: unknown[]
}

type PersistedChatPart = { type?: unknown; state?: unknown }

export function buildChatMessagePersistencePayload(input: {
  role: 'user' | 'assistant' | 'tool'
  parts: unknown[]
  text?: string
  skillRun?: Record<string, unknown>
  capabilitySnapshot?: AgentCapabilitySnapshot
}) {
  return {
    role: input.role,
    parts: input.parts,
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.skillRun === undefined ? {} : { skill_run: input.skillRun }),
    ...(input.capabilitySnapshot === undefined
      ? {}
      : { capability_snapshot: input.capabilitySnapshot }),
  }
}

export function latestClientTurn(messages: unknown[]) {
  return messages.at(-1)
}

export function latestActivatedSkillName(messages: PersistedChatMessage[]) {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue
    for (const part of [...message.parts].reverse()) {
      if (!part || typeof part !== 'object') continue
      const record = part as Record<string, unknown>
      if (record.type !== 'tool-loadSkill' || record.state !== 'output-available') continue
      const output = record.output
      const input = record.input
      if (!output || typeof output !== 'object' || !input || typeof input !== 'object') continue
      const outputName = (output as Record<string, unknown>).name
      const inputName = (input as Record<string, unknown>).name
      if (typeof outputName === 'string' && outputName === inputName) return outputName
    }
  }
  return undefined
}

function isTextPart(part: unknown): part is { type: 'text'; text: string } {
  return Boolean(part)
    && typeof part === 'object'
    && (part as PersistedChatPart).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string'
}

function isPendingApprovalPart(part: unknown): part is Record<string, unknown> {
  if (!part || typeof part !== 'object') return false
  const record = part as PersistedChatPart
  return record.type === 'dynamic-tool'
    && (record.state === 'approval-requested' || record.state === 'approval-responded')
}

export function modelHistoryCandidates(
  messages: PersistedChatMessage[],
  { includeToolApprovals = false }: { includeToolApprovals?: boolean } = {},
) {
  return messages
    .filter((message): message is PersistedChatMessage & { role: 'user' | 'assistant' } => message.role !== 'tool')
    .map(message => ({
      id: String(message.id),
      role: message.role,
      parts: [
        ...message.parts.filter(isTextPart),
        ...(includeToolApprovals && message.role === 'assistant' ? message.parts.filter(isPendingApprovalPart) : []),
      ],
    }))
    .filter(message => message.parts.length > 0)
}

type ToolAudit = {
  toolName: (typeof chatToolNames)[number]
  input: Record<string, unknown>
  output: unknown
}

function apiUrl(apiBase: string, path: string) {
  return `${apiBase.replace(/\/$/, '')}${path}`
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function toolSummary({ toolName, input, output }: ToolAudit) {
  const serialized = JSON.stringify({ input, output })
  return `${toolName}: ${serialized.slice(0, 1_500)}`
}

async function persistToolAudit({ apiBase, sessionId, audit }: ChatToolOptions & { audit: ToolAudit }) {
  const response = await fetch(apiUrl(apiBase, `/chat/sessions/${sessionId}/messages`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role: 'tool',
      parts: [{ type: 'tool-audit', toolName: audit.toolName, input: audit.input, output: audit.output }],
      text: toolSummary(audit),
    }),
  })
  if (!response.ok) throw new Error(`Unable to persist ${audit.toolName} audit (${response.status})`)
}

async function fetchToolResult(apiBase: string, path: string) {
  const response = await fetch(apiUrl(apiBase, path), { cache: 'no-store' })
  if (!response.ok) throw new Error(`Information source request failed (${response.status})`)
  return response.json() as Promise<unknown>
}

export function makeChatTools({ apiBase, sessionId }: ChatToolOptions) {
  return {
    searchInformationSources: tool({
      description: 'Search locally stored writing plans. This tool is read-only.',
      inputSchema: searchInformationSourcesSchema,
      execute: async ({ q, limit }) => {
        const input = { q, limit }
        let output: unknown
        try {
          output = await fetchToolResult(apiBase, `/chat/sources/search?${new URLSearchParams({ q, limit: String(limit) })}`)
        } catch (error) {
          output = { error: toErrorMessage(error) }
        }
        await persistToolAudit({ apiBase, sessionId, audit: { toolName: 'searchInformationSources', input, output } })
        return output
      },
    }),
    readInformationSource: tool({
      description: 'Read one locally stored writing plan. This tool is read-only.',
      inputSchema: readInformationSourceSchema,
      execute: async ({ source, id }) => {
        const input = { source, id }
        let output: unknown
        try {
          output = await fetchToolResult(apiBase, `/chat/sources/${encodeURIComponent(source)}/${id}`)
        } catch (error) {
          output = { error: toErrorMessage(error) }
        }
        await persistToolAudit({ apiBase, sessionId, audit: { toolName: 'readInformationSource', input, output } })
        return output
      },
    }),
  }
}
