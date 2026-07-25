import { createMCPClient } from '@ai-sdk/mcp'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

const sensitiveToolVerb = /(^|_)(publish|delete|update|save|create|add|upload)(_|$)/
const readOnlyToolPrefix = /^(list|get|search|read|fetch|find)_/

export function requiresToolApproval(name: string) {
  return name !== 'generateImage' && !readOnlyToolPrefix.test(name) && sensitiveToolVerb.test(name)
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

export type ImageFlow = 'standalone_image'

export const imageGenerationInputSchema = z.object({
  prompt: z.string().min(1).max(4_000),
}).strict()

export async function createImageJob({
  apiBase,
  prompt,
}: {
  apiBase: string
  prompt: string
}) {
  const response = await fetch(`${apiBase.replace(/\/$/, '')}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      flow: 'standalone_image',
      title: 'Chat 生图',
      input: { prompt },
    }),
  })
  if (!response.ok) throw new Error(`Unable to create image job (${response.status})`)
  const job = await response.json() as { id: number; flow: ImageFlow; status: string }
  return { jobId: job.id, flow: job.flow, status: job.status }
}

export async function openGlobalChatTools({ apiBase }: GlobalChatToolOptions) {
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
    description: 'Generate one image from a free-form prompt and save it to Creative Assets.',
    inputSchema: imageGenerationInputSchema,
    execute: async ({ prompt }) => {
      return createImageJob({ apiBase, prompt })
    },
  })

  return { tools, close: () => client.close() }
}
