import { createMCPClient } from '@ai-sdk/mcp'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

const sensitiveToolVerb = /(^|_)(publish|delete|update|save|create|add|upload)(_|$)/

export function requiresToolApproval(name: string) {
  return name !== 'generateImage' && sensitiveToolVerb.test(name)
}

export function mcpUrl(apiBase: string) {
  return new URL('/mcp', apiBase).toString()
}

export type GlobalChatToolOptions = {
  apiBase: string
  sessionId: number
  draftId?: number
  skillName?: string
}

export type ImageFlow = 'cover' | 'illustrations'

export const imageGenerationInputSchema = z.object({
  kind: z.enum(['cover', 'illustrations']).default('cover'),
  note: z.string().max(4_000).optional(),
})

export async function createImageJob({
  apiBase,
  draftId,
  flow,
  note,
}: {
  apiBase: string
  draftId: number
  flow: ImageFlow
  note?: string
}) {
  const response = await fetch(`${apiBase.replace(/\/$/, '')}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      flow,
      title: flow === 'cover' ? `Chat 封面 · 草稿 #${draftId}` : `Chat 插图 · 草稿 #${draftId}`,
      input: { draft_id: draftId, note: note ?? '' },
    }),
  })
  if (!response.ok) throw new Error(`Unable to create ${flow} image job (${response.status})`)
  const job = await response.json() as { id: number; flow: ImageFlow; status: string }
  return { jobId: job.id, flow: job.flow, draftId, status: job.status }
}

export async function openGlobalChatTools({ apiBase, draftId }: GlobalChatToolOptions) {
  const client = await createMCPClient({
    transport: { type: 'http', url: mcpUrl(apiBase) },
  })
  const discovered = await client.tools()
  const tools = Object.fromEntries(
    Object.entries(discovered).map(([name, tool]) => [name, {
      ...tool,
      needsApproval: requiresToolApproval(name),
    }]),
  ) as ToolSet
  tools.generateImage = tool({
    description: 'Create a durable cover or illustration generation job for the selected draft. The job runs in the content worker and saves its images to that draft.',
    inputSchema: imageGenerationInputSchema,
    execute: async ({ kind, note }) => {
      if (!draftId) return { error: 'Select a draft before generating an image.' }
      return createImageJob({ apiBase, draftId, flow: kind, note })
    },
  })

  return { tools, close: () => client.close() }
}
