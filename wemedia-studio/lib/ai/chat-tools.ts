import { tool } from 'ai'
import { z } from 'zod'

export const chatToolNames = [
  'searchInformationSources',
  'readInformationSource',
] as const

export const searchInformationSourcesSchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(20).default(10),
})

export const readInformationSourceSchema = z.object({
  source: z.enum(['writing_plan', 'reference_material']),
  id: z.number().int().positive(),
})

type ChatToolOptions = {
  apiBase: string
  sessionId: number
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
      parts: [{ type: 'tool-result', toolName: audit.toolName, input: audit.input, output: audit.output }],
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
      description: 'Search the locally collected writing plans and reference materials. This tool is read-only.',
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
      description: 'Read one locally collected writing plan or reference material by source and id. This tool is read-only.',
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
