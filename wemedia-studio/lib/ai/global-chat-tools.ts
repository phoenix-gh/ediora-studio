import { createMCPClient } from '@ai-sdk/mcp'
import type { ToolSet } from 'ai'

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

  return { tools, close: () => client.close() }
}
