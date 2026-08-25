import { createMCPClient } from '@ai-sdk/mcp'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import { applyAgentToolPolicy } from './agent-tool-policy'
import type { SkillCapabilityInput } from './agent-capabilities'
import type { ToolContractMetadata } from './tool-contract'
import { buildToolRegistry, type ToolRegistry } from './tool-registry'
import type {
  AgentApprovalPolicy,
  AgentToolAudit,
  AgentToolDecision,
} from './agent-runtime-types'

import {
  getEnabledSkill,
  listEnabledSkills,
  listSkillReferences,
  loadSkillManifest,
  loadSkillPreloadContext,
  readSkillReference,
  skillReferenceContextByteLimit,
  SkillRegistryError,
  type SkillReferenceContent,
  type RegisteredSkill,
  type SkillReference,
  type SkillContext,
  type SkillExecutionHints,
  type SkillManifest,
} from '../skills/registry'
import { generateAndSaveImage, type GeneratedImageAsset } from './image-generation'

export { requiresToolApproval } from './agent-tool-policy'

export function mcpUrl(origin: string) {
  return new URL('/mcp', origin).toString()
}

export type ImageGenerationInput = {
  prompt: string
  title?: string
  directory?: string
}

export type ImageGenerator = {
  generate(input: ImageGenerationInput): Promise<GeneratedImageAsset>
}

export type GlobalAgentToolOptions = {
  mcpEndpoint: string
  imageGenerator: ImageGenerator
  sessionId?: number
  draftId?: number
  dailyCreationRunId?: number
  skillName?: string
  restoredSkillName?: string
  approvalPolicy?: AgentApprovalPolicy
  blockedToolNames?: readonly string[]
  beforeToolExecute?: (event: AgentToolAudit) => Promise<AgentToolDecision>
  onToolAudit?: (event: AgentToolAudit) => void | Promise<void>
}

export type GlobalChatToolOptions = GlobalAgentToolOptions

export const imageGenerationInputSchema = z.object({
  prompt: z.string().min(1).max(4_000),
  title: z.string().trim().min(1).max(200).optional(),
  directory: z.string().trim().min(1).max(80).optional(),
}).strict()

export const skillReferenceInputSchema = z.object({
  path: z.string().min(1).max(500),
}).strict()

export const loadSkillInputSchema = z.object({
  name: z.string().min(1).max(200),
}).strict()

export type ChatSkillActivationSource = 'manual' | 'automatic' | 'restored'

export type ChatSkillSnapshot = {
  source?: ChatSkillActivationSource
  activeSkillName?: string
  referenceCount: number
  readReferenceCount: number
}

type ChatSkillRuntimeOptions = {
  selectedSkillName?: string
  restoredSkillName?: string
  baseTools?: ToolSet
  baseToolRegistry?: ToolRegistry
  close?: () => void | Promise<void>
  listEnabled?: () => Promise<RegisteredSkill[]>
  getEnabled?: (name: string) => Promise<RegisteredSkill | null>
  listReferences?: (name: string) => Promise<SkillReference[]>
  readReference?: (name: string, path: string) => Promise<SkillReferenceContent>
  loadPreloadContext?: (name: string) => Promise<SkillContext>
  loadManifest?: (name: string) => Promise<SkillManifest>
}

export type ActiveSkillContext = {
  skill: RegisteredSkill
  references: SkillReference[]
  activation: ChatSkillActivationSource
  execution: SkillExecutionHints
}

export type ChatSkillRuntime = {
  tools: ToolSet
  catalogContext: string
  snapshot(): ChatSkillSnapshot
  activeContext(): ActiveSkillContext | undefined
  capabilityContext?: () => SkillCapabilityInput | undefined
  toolRegistry(): ToolRegistry
  readReferences(paths: string[]): Promise<SkillReferenceContent[]>
  close(): Promise<void>
}

const NATIVE_TOOL_CONTRACTS = {
  generateImage: {
    namespace: 'image_generation',
    version: '1',
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: true,
    approval: 'never',
    concurrency: 'serialized',
    retry: 'unsafe',
  },
  loadSkill: {
    namespace: 'skills',
    version: '1',
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    approval: 'never',
    concurrency: 'serialized',
    retry: 'safe',
  },
  readSkillReference: {
    namespace: 'skills',
    version: '1',
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    approval: 'never',
    concurrency: 'parallel-safe',
    retry: 'safe',
  },
} satisfies Record<string, ToolContractMetadata>

function combineToolRegistries(
  tools: ToolSet,
  base: ToolRegistry,
  extension: ToolRegistry,
): ToolRegistry {
  const contracts = new Map(
    [...base.contracts, ...extension.contracts]
      .sort(([left], [right]) => left.localeCompare(right)),
  )
  const diagnostics = [...base.diagnostics, ...extension.diagnostics]
    .sort((left, right) => left.toolName.localeCompare(right.toolName))
  return {
    tools,
    contracts,
    diagnostics,
    get(name) {
      const value = tools[name]
      const contract = contracts.get(name)
      return value && contract ? { tool: value, contract } : undefined
    },
  }
}

function referenceCatalog(references: SkillReference[]) {
  return references.length
    ? references.map(reference => `- ${reference.path} (${reference.bytes} bytes)`).join('\n')
    : '- No readable references'
}

export async function createChatSkillRuntime({
  selectedSkillName,
  restoredSkillName,
  baseTools,
  baseToolRegistry,
  close = () => undefined,
  listEnabled = listEnabledSkills,
  getEnabled = getEnabledSkill,
  listReferences = listSkillReferences,
  readReference = readSkillReference,
  loadPreloadContext = loadSkillPreloadContext,
  loadManifest = loadSkillManifest,
}: ChatSkillRuntimeOptions): Promise<ChatSkillRuntime> {
  const resolvedBaseRegistry = baseToolRegistry ?? buildToolRegistry({
    tools: baseTools ?? {},
    compatibilityMode: true,
  })
  const enabledSkills = await listEnabled()
  let activeSkill: RegisteredSkill | undefined
  let source: ChatSkillActivationSource | undefined
  let references: SkillReference[] = []
  let reader: ReturnType<typeof createSkillReferenceReader> | undefined
  let preloadedReferences: SkillReferenceContent[] = []
  const loadedReferences = new Map<string, SkillReferenceContent>()
  let execution: SkillExecutionHints | undefined
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
    execution = (await loadManifest(name)).execution
    preloadedReferences = (await loadPreloadContext(name)).references
    for (const reference of preloadedReferences) loadedReferences.set(reference.path, reference)
    reader = createSkillReferenceReader({ skillName: name, readReference })
    return skill
  }

  if (selectedSkillName) await activate(selectedSkillName, 'manual')
  else if (restoredSkillName) {
    try {
      await activate(restoredSkillName, 'restored')
    } catch (error) {
      if (!(error instanceof SkillRegistryError) || error.code !== 'not_found') throw error
    }
  }

  const tools = { ...resolvedBaseRegistry.tools } as ToolSet
  if (!activeSkill) {
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
      loadedReferences.set(reference.path, reference)
      return reference
    },
  })

  const addedNativeTools = Object.fromEntries(
    Object.entries(tools).filter(([name]) => !resolvedBaseRegistry.contracts.has(name)),
  ) as ToolSet
  const addedNativeContracts = Object.fromEntries(
    Object.entries(NATIVE_TOOL_CONTRACTS).filter(([name]) => name in addedNativeTools),
  )
  const extensionRegistry = buildToolRegistry({
    tools: addedNativeTools,
    nativeContracts: addedNativeContracts,
  })
  const registry = combineToolRegistries(tools, resolvedBaseRegistry, extensionRegistry)

  const automaticCatalog = enabledSkills.length
    ? enabledSkills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n')
    : '- No enabled Skills'
  const activeSkillLabel = source === 'restored'
    ? `Active skill restored from this conversation: ${activeSkill?.name}`
    : `Selected skill: ${activeSkill?.name}`
  const catalogContext = activeSkill
    ? `${activeSkillLabel}\n\n${activeSkill.instructions}\n\nAvailable Skill references:\n${referenceCatalog(references)}${preloadedReferences.length ? `\n\nPreloaded Skill references (already loaded; follow these rules):\n${preloadedReferences.map(reference => `## ${reference.path}\n\n${reference.content}`).join('\n\n')}` : ''}\n\nThe active Skill and every preloaded reference above are available in this turn. Apply all relevant rules to the answer. Do not claim that this Skill or these references were not loaded. Call readSkillReference only for a listed reference whose content is not preloaded above.`
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
    activeContext: () => activeSkill && source && execution
      ? { skill: activeSkill, references: [...references], activation: source, execution }
      : undefined,
    capabilityContext: () => activeSkill && source
      ? {
          skill: activeSkill,
          references: [...references],
          activation: source,
          loadedReferences: [...loadedReferences.values()],
        }
      : undefined,
    toolRegistry: () => registry,
    readReferences: async paths => {
      if (!activeSkill || !reader) throw new SkillRegistryError('not_found', 'No Skill is active')
      const listedPaths = new Set(references.map(reference => reference.path))
      const uniquePaths = [...new Set(paths)]
      if (uniquePaths.some(path => !listedPaths.has(path))) {
        throw new SkillRegistryError('invalid_reference', 'Skill reference is not listed for the active Skill')
      }
      const loaded: SkillReferenceContent[] = []
      for (const path of uniquePaths) {
        const reference = await reader({ path })
        readPaths.add(reference.path)
        loadedReferences.set(reference.path, reference)
        loaded.push(reference)
      }
      return loaded
    },
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

export function createDirectImageGenerator(apiBase: string, jobId?: number): ImageGenerator {
  return {
    generate: input => generateAndSaveImage({ apiBase, jobId, ...input }),
  }
}

export async function openGlobalAgentTools({
  mcpEndpoint,
  imageGenerator,
  dailyCreationRunId,
  skillName,
  restoredSkillName,
  approvalPolicy = 'interactive',
  blockedToolNames,
  beforeToolExecute,
  onToolAudit,
}: GlobalAgentToolOptions) {
  if (
    dailyCreationRunId !== undefined
    && (!Number.isSafeInteger(dailyCreationRunId) || dailyCreationRunId <= 0)
  ) {
    throw new Error('daily creation run identity must be a positive integer')
  }
  const client = await createMCPClient({
    transport: {
      type: 'http',
      url: mcpEndpoint,
      ...(dailyCreationRunId === undefined ? {} : {
        headers: { 'X-Daily-Creation-Run-Id': String(dailyCreationRunId) },
      }),
    },
  })
  const definitions = await client.listTools()
  const discovered = client.toolsFromDefinitions(definitions)
  const dailyOnlyBlockedTools = new Set(blockedToolNames ?? (
    dailyCreationRunId === undefined
      ? []
      : ['upload_image_from_url', 'upload_image_from_path']
  ))
  const visibleDiscovered = Object.fromEntries(
    Object.entries(discovered).filter(([name]) => !dailyOnlyBlockedTools.has(name)),
  )
  const visibleDefinitions = definitions.tools.filter(
    definition => !dailyOnlyBlockedTools.has(definition.name),
  )
  const tools = { ...visibleDiscovered } as ToolSet
  tools.generateImage = tool({
    description: 'Synchronously generate one image and save it as a CreativeAsset before returning asset_id and asset_url. The returned image is already stored locally; never upload it again with upload_image_from_url or upload_image_from_path. The directory parameter is optional: only provide it when the user explicitly requests an existing media directory; otherwise omit it and save the image in the default media directory 临时文件. Do not reuse a prompt or source directory as a media directory.',
    inputSchema: imageGenerationInputSchema,
    execute: async ({ prompt, title, directory }) => {
      return imageGenerator.generate({ prompt, title, directory })
    },
  })
  const baseToolRegistry = buildToolRegistry({
    tools,
    mcpDefinitions: visibleDefinitions,
    nativeContracts: { generateImage: NATIVE_TOOL_CONTRACTS.generateImage },
  })
  const runtime = await createChatSkillRuntime({
    selectedSkillName: skillName,
    restoredSkillName,
    baseToolRegistry,
    close: () => client.close(),
  })
  return {
    ...runtime,
    tools: applyAgentToolPolicy(runtime.tools, {
      policy: approvalPolicy,
      contracts: runtime.toolRegistry().contracts,
      beforeToolExecute,
      onAudit: onToolAudit,
    }),
  }
}

export const openGlobalChatTools = openGlobalAgentTools
