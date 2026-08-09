import { createMCPClient } from '@ai-sdk/mcp'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

import { applyAgentToolPolicy } from './agent-tool-policy'
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

export { requiresToolApproval } from './agent-tool-policy'

export function mcpUrl(apiBase: string) {
  return new URL('/mcp', apiBase).toString()
}

export type GlobalAgentToolOptions = {
  apiBase: string
  sessionId?: number
  draftId?: number
  dailyCreationRunId?: number
  skillName?: string
  restoredSkillName?: string
  approvalPolicy?: AgentApprovalPolicy
  beforeToolExecute?: (event: AgentToolAudit) => Promise<AgentToolDecision>
  onToolAudit?: (event: AgentToolAudit) => void | Promise<void>
}

export type GlobalChatToolOptions = GlobalAgentToolOptions

export type ImageFlow = 'standalone_image'

type ImageJobSnapshot = {
  id: number
  flow: string
  title?: string
  status: string
  input?: Record<string, unknown>
  steps?: Array<{
    key?: string
    status?: string
    output?: Record<string, unknown>
    error?: string
  }>
}

export type ImageJobResult = {
  jobId: number
  flow: ImageFlow
  status: string
  assetId?: number
  assetUrl?: string
  title?: string
  directory?: string
  error?: string
}

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
  baseTools: ToolSet
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
  readReferences(paths: string[]): Promise<SkillReferenceContent[]>
  close(): Promise<void>
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
  close = () => undefined,
  listEnabled = listEnabledSkills,
  getEnabled = getEnabledSkill,
  listReferences = listSkillReferences,
  readReference = readSkillReference,
  loadPreloadContext = loadSkillPreloadContext,
  loadManifest = loadSkillManifest,
}: ChatSkillRuntimeOptions): Promise<ChatSkillRuntime> {
  const enabledSkills = await listEnabled()
  let activeSkill: RegisteredSkill | undefined
  let source: ChatSkillActivationSource | undefined
  let references: SkillReference[] = []
  let reader: ReturnType<typeof createSkillReferenceReader> | undefined
  let preloadedReferences: SkillReferenceContent[] = []
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

  const tools = { ...baseTools } as ToolSet
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
      return reference
    },
  })

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

export async function createImageJob({
  apiBase,
  prompt,
  title,
  directory,
}: {
  apiBase: string
  prompt: string
  title?: string
  directory?: string
}) {
  const normalizedTitle = title?.trim() || 'Chat 生图'
  const normalizedDirectory = directory?.trim()
  const response = await fetch(`${apiBase.replace(/\/$/, '')}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      flow: 'standalone_image',
      title: normalizedTitle,
      input: {
        prompt,
        ...(normalizedDirectory ? { directory: normalizedDirectory } : {}),
      },
    }),
  })
  if (!response.ok) throw new Error(`Unable to create image job (${response.status})`)
  const job = await response.json() as { id: number; flow: ImageFlow; status: string }
  return { jobId: job.id, flow: job.flow, status: job.status }
}

function imageJobResult(job: ImageJobSnapshot): ImageJobResult {
  const step = [...(job.steps ?? [])]
    .reverse()
    .find(candidate => candidate.key === 'standalone_image' || candidate.status === 'succeeded' || candidate.status === 'failed')
  const output = step?.output ?? {}
  const inputDirectory = typeof job.input?.directory === 'string' ? job.input.directory : undefined
  const directory = typeof output.directory === 'string' ? output.directory : inputDirectory
  const assetId = typeof output.asset_id === 'number' ? output.asset_id : undefined
  const assetUrl = typeof output.asset_url === 'string' ? output.asset_url : undefined
  const title = typeof output.title === 'string' ? output.title : job.title
  const error = typeof step?.error === 'string' && step.error ? step.error : undefined

  return {
    jobId: job.id,
    flow: 'standalone_image',
    status: job.status,
    ...(assetId === undefined ? {} : { assetId }),
    ...(assetUrl === undefined ? {} : { assetUrl }),
    ...(title === undefined ? {} : { title }),
    ...(directory === undefined ? {} : { directory }),
    ...(error === undefined ? {} : { error }),
  }
}

export async function waitForImageJob({
  apiBase,
  jobId,
  timeoutMs = 10 * 60 * 1_000,
  pollIntervalMs = 1_000,
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}: {
  apiBase: string
  jobId: number
  timeoutMs?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<ImageJobResult> {
  const base = apiBase.replace(/\/$/, '')
  const deadline = Date.now() + timeoutMs

  while (true) {
    const response = await fetch(`${base}/jobs/${jobId}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Unable to read image job (${response.status})`)
    const job = await response.json() as ImageJobSnapshot
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
      return imageJobResult(job)
    }
    if (Date.now() >= deadline) throw new Error(`Image job ${jobId} did not finish before the timeout`)
    await sleep(pollIntervalMs)
  }
}

export async function createImageJobAndWait({
  timeoutMs,
  pollIntervalMs,
  sleep,
  ...input
}: Parameters<typeof createImageJob>[0] & {
  timeoutMs?: number
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<ImageJobResult> {
  const created = await createImageJob(input)
  return waitForImageJob({
    apiBase: input.apiBase,
    jobId: created.jobId,
    timeoutMs,
    pollIntervalMs,
    sleep,
  })
}

export async function openGlobalAgentTools({
  apiBase,
  dailyCreationRunId,
  skillName,
  restoredSkillName,
  approvalPolicy = 'interactive',
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
      url: mcpUrl(apiBase),
      ...(dailyCreationRunId === undefined ? {} : {
        headers: { 'X-WMS-Daily-Creation-Run-Id': String(dailyCreationRunId) },
      }),
    },
  })
  const discovered = await client.tools()
  const tools = { ...discovered } as ToolSet
  tools.generateImage = tool({
    description: 'Generate one image from a prompt, wait until the durable image job reaches a terminal status, and return its job ID, status, and saved asset details. Optionally provide a title and an existing media directory for the asset.',
    inputSchema: imageGenerationInputSchema,
    execute: async ({ prompt, title, directory }) => {
      return createImageJobAndWait({ apiBase, prompt, title, directory })
    },
  })
  const runtime = await createChatSkillRuntime({
    selectedSkillName: skillName,
    restoredSkillName,
    baseTools: tools,
    close: () => client.close(),
  })
  return {
    ...runtime,
    tools: applyAgentToolPolicy(runtime.tools, {
      policy: approvalPolicy,
      beforeToolExecute,
      onAudit: onToolAudit,
    }),
  }
}

export const openGlobalChatTools = openGlobalAgentTools
