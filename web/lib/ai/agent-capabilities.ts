import type { ToolSet } from 'ai'

import { requiresToolApproval, toolExecutionMetadata } from './agent-tool-policy'
import {
  sha256Text,
  stableJson,
  type ToolContract,
  type ToolNamespace,
} from './tool-contract'
import type { AgentApprovalPolicy } from './agent-runtime-types'
import type {
  RegisteredSkill,
  SkillReference,
  SkillReferenceContent,
} from '../skills/registry'

export type AgentRuntimeMode = 'chat' | 'job'

export type SkillCapabilityInput = {
  skill: RegisteredSkill
  activation: 'manual' | 'automatic' | 'restored'
  references: SkillReference[]
  loadedReferences: SkillReferenceContent[]
}

export type SkillCapabilitySnapshot = {
  name: string
  version: string
  source: 'builtin' | 'uploaded'
  activation: SkillCapabilityInput['activation']
  instructionsDigest: string
  references: Array<{
    path: string
    bytes: number
    loaded: boolean
    contentDigest: string | null
  }>
}

export type ToolCapabilityDescriptor = {
  name: string
  description: string
  inputSchemaDigest: string | null
  outputSchemaDigest?: string | null
  namespace?: ToolNamespace
  version?: string
  contractDigest?: string
  availability?: 'available' | 'unavailable'
  sideEffecting: boolean
  needsApproval: boolean
  replayPolicy: 'replayable' | 'uncertain-on-interruption'
  concurrencyPolicy: 'parallel-safe' | 'serialized' | 'unknown'
  idempotencyPolicy: 'replayable' | 'claim-backed' | 'unknown'
}

export type AgentCapabilityPolicySnapshot = {
  approvalPolicy: AgentApprovalPolicy
  allowedToolNames: string[] | null
}

export type AgentCapabilitySnapshot = {
  schemaVersion: 1
  mode: AgentRuntimeMode
  skill: SkillCapabilitySnapshot | null
  tools: ToolCapabilityDescriptor[]
  policy: AgentCapabilityPolicySnapshot
}

export function isAgentCapabilitySnapshot(value: unknown): value is AgentCapabilitySnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return candidate.schemaVersion === 1
    && (candidate.mode === 'chat' || candidate.mode === 'job')
    && (candidate.skill === null || typeof candidate.skill === 'object')
    && Array.isArray(candidate.tools)
    && Boolean(candidate.policy && typeof candidate.policy === 'object')
}

export { sha256Text, stableJson } from './tool-contract'

function digestJson(value: unknown) {
  const serialized = stableJson(value)
  return serialized === null ? null : sha256Text(serialized)
}

function skillSnapshot(input: SkillCapabilityInput): SkillCapabilitySnapshot {
  const loaded = new Map(input.loadedReferences.map(reference => [reference.path, reference]))
  return {
    name: input.skill.name,
    version: input.skill.version,
    source: input.skill.source,
    activation: input.activation,
    instructionsDigest: sha256Text(input.skill.instructions),
    references: [...input.references]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(reference => {
        const loadedReference = loaded.get(reference.path)
        return {
          path: reference.path,
          bytes: reference.bytes,
          loaded: Boolean(loadedReference),
          contentDigest: loadedReference ? sha256Text(loadedReference.content) : null,
        }
      }),
  }
}

type ToolWithCapabilityFields = {
  description?: unknown
  inputSchema?: unknown
  outputSchema?: unknown
  needsApproval?: unknown
}

export function buildToolCapabilityDescriptors(
  tools: ToolSet,
  contracts?: ReadonlyMap<string, ToolContract>,
): ToolCapabilityDescriptor[] {
  return Object.entries(tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const source = value as ToolWithCapabilityFields
      const contract = contracts?.get(name)
      const sideEffecting = contract ? !contract.annotations.readOnly : requiresToolApproval(name)
      const metadata = toolExecutionMetadata(name, contract)
      return {
        name,
        description: contract?.description
          ?? (typeof source.description === 'string' ? source.description : ''),
        inputSchemaDigest: digestJson(contract?.inputSchema ?? source.inputSchema),
        ...(contract ? {
          outputSchemaDigest: digestJson(contract.outputSchema),
          namespace: contract.namespace,
          version: contract.version,
          contractDigest: contract.contractDigest,
          availability: contract.availability,
        } : {}),
        sideEffecting,
        needsApproval: source.needsApproval === true,
        replayPolicy: contract
          ? contract.execution.retry === 'safe'
            ? 'replayable'
            : 'uncertain-on-interruption'
          : sideEffecting ? 'uncertain-on-interruption' : 'replayable',
        ...metadata,
      }
    })
}

export function buildAgentCapabilitySnapshot(input: {
  mode: AgentRuntimeMode
  skill?: SkillCapabilityInput
  tools: ToolSet
  contracts?: ReadonlyMap<string, ToolContract>
  approvalPolicy: AgentApprovalPolicy
  allowedToolNames?: readonly string[]
}): AgentCapabilitySnapshot {
  return {
    schemaVersion: 1,
    mode: input.mode,
    skill: input.skill ? skillSnapshot(input.skill) : null,
    tools: buildToolCapabilityDescriptors(input.tools, input.contracts),
    policy: {
      approvalPolicy: input.approvalPolicy,
      allowedToolNames: input.allowedToolNames
        ? [...new Set(input.allowedToolNames)].sort((left, right) => left.localeCompare(right))
        : null,
    },
  }
}

export type AgentCapabilityDriftField = 'schemaVersion' | 'mode' | 'tools' | 'policy' | 'skill'

const toolMetadataKeys = [
  'concurrencyPolicy',
  'idempotencyPolicy',
  'outputSchemaDigest',
  'namespace',
  'version',
  'contractDigest',
  'availability',
] as const

function comparableTools(
  tools: ToolCapabilityDescriptor[],
) {
  return tools.map(tool => {
    const record = tool as unknown as Record<string, unknown>
    const comparable: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      if (!toolMetadataKeys.includes(key as typeof toolMetadataKeys[number])) {
        comparable[key] = record[key]
      }
    }
    return comparable
  })
}

function toolMetadataDrift(
  expected: ToolCapabilityDescriptor[],
  actual: ToolCapabilityDescriptor[],
) {
  return expected.some((expectedTool, index) => {
    const actualTool = actual[index] as ToolCapabilityDescriptor | undefined
    if (!actualTool) return false
    const expectedRecord = expectedTool as unknown as Record<string, unknown>
    const actualRecord = actualTool as unknown as Record<string, unknown>
    return toolMetadataKeys.some(key => (
      expectedRecord[key] !== undefined
      && actualRecord[key] !== undefined
      && expectedRecord[key] !== actualRecord[key]
    ))
  })
}

function comparableSkill(skill: SkillCapabilitySnapshot | null) {
  if (!skill) return null
  return {
    name: skill.name,
    version: skill.version,
    source: skill.source,
    instructionsDigest: skill.instructionsDigest,
    references: skill.references.map(reference => ({
      path: reference.path,
      bytes: reference.bytes,
    })),
  }
}

function skillContentDrift(
  expected: SkillCapabilitySnapshot,
  actual: SkillCapabilitySnapshot,
) {
  const actualReferences = new Map(actual.references.map(reference => [reference.path, reference]))
  return expected.references.some(reference => {
    if (!reference.contentDigest) return false
    const current = actualReferences.get(reference.path)
    return Boolean(current?.contentDigest && current.contentDigest !== reference.contentDigest)
  })
}

export function capabilitySnapshotDrift(
  expected: AgentCapabilitySnapshot,
  actual: AgentCapabilitySnapshot,
): AgentCapabilityDriftField | undefined {
  if (expected.schemaVersion !== actual.schemaVersion) return 'schemaVersion'
  if (expected.mode !== actual.mode) return 'mode'
  if (stableJson(comparableTools(expected.tools)) !== stableJson(comparableTools(actual.tools))) {
    return 'tools'
  }
  if (toolMetadataDrift(expected.tools, actual.tools)) return 'tools'
  if (stableJson(expected.policy) !== stableJson(actual.policy)) return 'policy'
  if (stableJson(comparableSkill(expected.skill)) !== stableJson(comparableSkill(actual.skill))) {
    return 'skill'
  }
  if (expected.skill && actual.skill && skillContentDrift(expected.skill, actual.skill)) {
    return 'skill'
  }
  return undefined
}

export function pinCapabilitySnapshot(
  existing: AgentCapabilitySnapshot | undefined,
  current: AgentCapabilitySnapshot,
  options: { allowSkillBootstrap?: boolean } = {},
): AgentCapabilitySnapshot {
  if (!existing) return current
  const drift = capabilitySnapshotDrift(existing, current)
  if (!drift) return existing
  if (
    drift === 'skill'
    && options.allowSkillBootstrap
    && existing.skill === null
    && current.skill !== null
  ) {
    return { ...existing, skill: current.skill }
  }
  throw new Error(`Agent capability drift detected: ${drift}`)
}
