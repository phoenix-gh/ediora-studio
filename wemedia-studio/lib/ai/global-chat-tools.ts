import { createMCPClient } from '@ai-sdk/mcp'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import {
  getEnabledSkill,
  listEnabledSkills,
  listSkillReferences,
  loadSkillPreloadContext,
  readSkillReference,
  skillReferenceContextByteLimit,
  SkillRegistryError,
  type SkillReferenceContent,
  type RegisteredSkill,
  type SkillReference,
  type SkillContext,
} from '../skills/registry'

const sensitiveToolVerb = /(^|_)(publish|delete|update|save|create|add|upload)(_|$)/
const readOnlyToolPrefix = /^(list|get|search|read|fetch|find)_/

export function requiresToolApproval(name: string) {
  return name !== 'generateImage' && name !== 'readSkillReference' && !readOnlyToolPrefix.test(name) && sensitiveToolVerb.test(name)
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

export const skillReferenceInputSchema = z.object({
  path: z.string().min(1).max(500),
}).strict()

export const loadSkillInputSchema = z.object({
  name: z.string().min(1).max(200),
}).strict()

export type ChatSkillActivationSource = 'manual' | 'automatic'

export type ChatSkillSnapshot = {
  source?: ChatSkillActivationSource
  activeSkillName?: string
  referenceCount: number
  readReferenceCount: number
}

type ChatSkillRuntimeOptions = {
  selectedSkillName?: string
  baseTools: ToolSet
  close?: () => void | Promise<void>
  listEnabled?: () => Promise<RegisteredSkill[]>
  getEnabled?: (name: string) => Promise<RegisteredSkill | null>
  listReferences?: (name: string) => Promise<SkillReference[]>
  readReference?: (name: string, path: string) => Promise<SkillReferenceContent>
  loadPreloadContext?: (name: string) => Promise<SkillContext>
}

export type ChatSkillRuntime = {
  tools: ToolSet
  catalogContext: string
  snapshot(): ChatSkillSnapshot
  close(): Promise<void>
}

function referenceCatalog(references: SkillReference[]) {
  return references.length
    ? references.map(reference => `- ${reference.path} (${reference.bytes} bytes)`).join('\n')
    : '- No readable references'
}

export async function createChatSkillRuntime({
  selectedSkillName,
  baseTools,
  close = () => undefined,
  listEnabled = listEnabledSkills,
  getEnabled = getEnabledSkill,
  listReferences = listSkillReferences,
  readReference = readSkillReference,
  loadPreloadContext = loadSkillPreloadContext,
}: ChatSkillRuntimeOptions): Promise<ChatSkillRuntime> {
  const enabledSkills = await listEnabled()
  let activeSkill: RegisteredSkill | undefined
  let source: ChatSkillActivationSource | undefined
  let references: SkillReference[] = []
  let reader: ReturnType<typeof createSkillReferenceReader> | undefined
  let preloadedReferences: SkillReferenceContent[] = []
  const readPaths = new Set<string>()

  async function activate(name: string, activationSource: ChatSkillActivationSource) {
    if (activeSkill) {
      if (activeSkill.name !== name) throw new SkillRegistryError('conflict', `Skill already active: ${activeSkill.name}`)
      return activeSkill
    }
    const skill = await getEnabled(name)
    if (!skill) throw new SkillRegistryError('not_found', `Skill unavailable: ${name}`)
    activeSkill = skill
    source = activationSource
    references = await listReferences(name)
    preloadedReferences = (await loadPreloadContext(name)).references
    for (const reference of preloadedReferences) readPaths.add(reference.path)
    reader = createSkillReferenceReader({ skillName: name, readReference })
    return skill
  }

  if (selectedSkillName) await activate(selectedSkillName, 'manual')

  const tools = { ...baseTools } as ToolSet
  if (!selectedSkillName) {
    tools.loadSkill = tool({
      description: 'Load the one best matching enabled Skill before performing a task that needs its specialized workflow. Activate at most one Skill.',
      inputSchema: loadSkillInputSchema,
      execute: async ({ name }) => {
        const skill = await activate(name, 'automatic')
        return {
          name: skill.name,
          description: skill.description,
          version: skill.version,
          instructions: skill.instructions,
          references,
          preloadedReferences,
        }
      },
    })
  }
  tools.readSkillReference = tool({
    description: 'Read one listed reference from the active Skill. Read every reference required by the Skill instructions before producing task output.',
    inputSchema: skillReferenceInputSchema,
    execute: async ({ path }) => {
      if (!activeSkill || !reader) throw new SkillRegistryError('not_found', 'No Skill is active')
      const reference = await reader({ path })
      readPaths.add(reference.path)
      return reference
    },
  })

  const automaticCatalog = enabledSkills.length
    ? enabledSkills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n')
    : '- No enabled Skills'
  const catalogContext = activeSkill
    ? `Selected skill: ${activeSkill.name}\n\n${activeSkill.instructions}\n\nAvailable Skill references:\n${referenceCatalog(references)}${preloadedReferences.length ? `\n\nPreloaded Skill references:\n${preloadedReferences.map(reference => `## ${reference.path}\n\n${reference.content}`).join('\n\n')}` : ''}`
    : `Enabled Skills available for automatic activation:\n${automaticCatalog}\n\nCall loadSkill only when exactly one Skill clearly matches the user's task.`

  return {
    tools,
    catalogContext,
    snapshot: () => ({
      source,
      activeSkillName: activeSkill?.name,
      referenceCount: references.length,
      readReferenceCount: readPaths.size,
    }),
    close: async () => { await close() },
  }
}

export function createSkillReferenceReader({
  skillName,
  readReference = readSkillReference,
  maxBytes = skillReferenceContextByteLimit(),
}: {
  skillName: string
  readReference?: (skillName: string, path: string) => Promise<SkillReferenceContent>
  maxBytes?: number
}) {
  const cache = new Map<string, SkillReferenceContent>()
  let consumedBytes = 0
  return async ({ path }: { path: string }) => {
    const cached = cache.get(path)
    if (cached) return cached
    let reference: SkillReferenceContent
    try {
      reference = await readReference(skillName, path)
    } catch (error) {
      if (error instanceof SkillRegistryError) throw error
      throw new SkillRegistryError('invalid_reference', 'Unable to read Skill reference')
    }
    if (consumedBytes + reference.bytes > maxBytes) {
      throw new SkillRegistryError('too_large', `Skill reference context exceeds ${maxBytes} bytes`)
    }
    consumedBytes += reference.bytes
    cache.set(path, reference)
    return reference
  }
}

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

export async function openGlobalChatTools({ apiBase, skillName }: GlobalChatToolOptions) {
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
  return createChatSkillRuntime({
    selectedSkillName: skillName,
    baseTools: tools,
    close: () => client.close(),
  })
}
