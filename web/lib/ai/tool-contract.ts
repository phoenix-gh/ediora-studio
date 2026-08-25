import { createHash } from 'node:crypto'

import type { ListToolsResult } from '@ai-sdk/mcp'
import type { ToolSet } from 'ai'
import { toJSONSchema } from 'zod'


export const TOOL_NAMESPACES = [
  'information_sources',
  'web_research',
  'writing_plans',
  'drafts',
  'creative_assets',
  'image_generation',
  'accounts',
  'publishing',
  'skills',
  'system',
] as const

export type ToolNamespace = typeof TOOL_NAMESPACES[number]
export type ToolApproval = 'never' | 'writes' | 'always'
export type ToolConcurrency = 'parallel-safe' | 'serialized'
export type ToolRetry = 'safe' | 'claim-backed' | 'unsafe'

export type ToolContract = {
  name: string
  namespace: ToolNamespace
  version: string
  description: string
  inputSchema: unknown
  outputSchema?: unknown
  annotations: {
    readOnly: boolean
    destructive: boolean
    idempotent: boolean
    openWorld: boolean
    approval: ToolApproval
  }
  execution: {
    concurrency: ToolConcurrency
    retry: ToolRetry
  }
  availability: 'available' | 'unavailable'
  contractDigest: string
  source: 'mcp' | 'native' | 'legacy'
}

export type ToolContractMetadata = {
  namespace: ToolNamespace
  version: string
  readOnly: boolean
  destructive: boolean
  idempotent: boolean
  openWorld: boolean
  approval: ToolApproval
  concurrency: ToolConcurrency
  retry: ToolRetry
}

export type ToolContractDiagnostic = {
  toolName: string
  severity: 'warning' | 'error'
  code: 'legacy-contract' | 'invalid-contract' | 'missing-executable' | 'duplicate-tool'
  message: string
}

export type ToolContractNormalization = {
  contract?: ToolContract
  diagnostics: ToolContractDiagnostic[]
}

type JsonObject = { [key: string]: JsonValue }
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject

function normalizeJson(value: unknown, seen: Set<object>): JsonValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number')
    return value
  }
  if (typeof value !== 'object') throw new Error('unsupported JSON value')
  if (seen.has(value)) throw new Error('circular JSON value')
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => normalizeJson(item, seen))
    const result: JsonObject = {}
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeJson((value as Record<string, unknown>)[key], seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

export function stableJson(value: unknown): string | null {
  try {
    return JSON.stringify(normalizeJson(value, new Set()))
  } catch {
    return null
  }
}

export function sha256Text(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function invalid(toolName: string, message: string): ToolContractNormalization {
  return {
    diagnostics: [{
      toolName,
      severity: 'error',
      code: 'invalid-contract',
      message,
    }],
  }
}

const namespaces = new Set<string>(TOOL_NAMESPACES)
const approvals = new Set<string>(['never', 'writes', 'always'])
const concurrencyModes = new Set<string>(['parallel-safe', 'serialized'])
const retryModes = new Set<string>(['safe', 'claim-backed', 'unsafe'])

function validateMetadata(
  toolName: string,
  candidate: Record<string, unknown>,
): ToolContractMetadata | ToolContractNormalization {
  if (!namespaces.has(String(candidate.namespace ?? ''))) {
    return invalid(toolName, `Tool ${toolName} has an unknown namespace`)
  }
  if (typeof candidate.version !== 'string' || !candidate.version.trim()) {
    return invalid(toolName, `Tool ${toolName} contract version is required`)
  }
  for (const field of ['readOnly', 'destructive', 'idempotent', 'openWorld'] as const) {
    if (typeof candidate[field] !== 'boolean') {
      return invalid(toolName, `Tool ${toolName} has incomplete annotations: ${field}`)
    }
  }
  if (!approvals.has(String(candidate.approval ?? ''))) {
    return invalid(toolName, `Tool ${toolName} has an invalid approval mode`)
  }
  if (!concurrencyModes.has(String(candidate.concurrency ?? ''))) {
    return invalid(toolName, `Tool ${toolName} has an invalid concurrency mode`)
  }
  if (!retryModes.has(String(candidate.retry ?? ''))) {
    return invalid(toolName, `Tool ${toolName} has an invalid retry mode`)
  }
  if (candidate.readOnly === true && candidate.approval !== 'never') {
    return invalid(toolName, `Tool ${toolName} is read-only and cannot require write approval`)
  }
  if (candidate.destructive === true && candidate.readOnly === true) {
    return invalid(toolName, `Tool ${toolName} cannot be destructive and read-only`)
  }
  if (candidate.readOnly === false && candidate.concurrency === 'parallel-safe') {
    return invalid(toolName, `Tool ${toolName} writes must be serialized`)
  }
  return candidate as ToolContractMetadata
}

function buildContract(input: Omit<ToolContract, 'contractDigest'>): ToolContractNormalization {
  const canonicalSchema = (schema: unknown) => {
    if (stableJson(schema) !== null) return schema
    try {
      return toJSONSchema(schema as Parameters<typeof toJSONSchema>[0])
    } catch {
      return undefined
    }
  }
  const inputSchema = canonicalSchema(input.inputSchema)
  const outputSchema = input.outputSchema === undefined
    ? undefined
    : canonicalSchema(input.outputSchema)
  if (inputSchema === undefined || (input.outputSchema !== undefined && outputSchema === undefined)) {
    return invalid(input.name, `Tool ${input.name} contract schemas are not serializable`)
  }
  const semanticContract = {
    name: input.name,
    namespace: input.namespace,
    version: input.version,
    description: input.description,
    inputSchema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    annotations: input.annotations,
    execution: input.execution,
    source: input.source,
  }
  const serialized = stableJson(semanticContract)
  if (serialized === null) {
    return invalid(input.name, `Tool ${input.name} contract schemas are not serializable`)
  }
  return {
    contract: { ...input, contractDigest: sha256Text(serialized) },
    diagnostics: [],
  }
}

export function normalizeMcpToolContract(
  definition: ListToolsResult['tools'][number],
): ToolContractNormalization {
  const name = definition.name
  if (typeof definition.description !== 'string' || !definition.description.trim()) {
    return invalid(name, `Tool ${name} description is required`)
  }
  const annotations = definition.annotations as Record<string, unknown> | undefined
  if (!annotations) return invalid(name, `Tool ${name} has incomplete annotations`)
  const ediora = (definition._meta as Record<string, unknown> | undefined)?.['dev.ediora/tool']
  if (!ediora || typeof ediora !== 'object' || Array.isArray(ediora)) {
    return invalid(name, `Tool ${name} is missing dev.ediora/tool metadata`)
  }
  const metadata = validateMetadata(name, {
    ...(ediora as Record<string, unknown>),
    readOnly: annotations.readOnlyHint,
    destructive: annotations.destructiveHint,
    idempotent: annotations.idempotentHint,
    openWorld: annotations.openWorldHint,
  })
  if ('diagnostics' in metadata) return metadata

  return buildContract({
    name,
    namespace: metadata.namespace,
    version: metadata.version,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    annotations: {
      readOnly: metadata.readOnly,
      destructive: metadata.destructive,
      idempotent: metadata.idempotent,
      openWorld: metadata.openWorld,
      approval: metadata.approval,
    },
    execution: {
      concurrency: metadata.concurrency,
      retry: metadata.retry,
    },
    availability: 'available',
    source: 'mcp',
  })
}

type ToolWithContractFields = {
  description?: unknown
  inputSchema?: unknown
  outputSchema?: unknown
}

export function normalizeNativeToolContract(
  name: string,
  value: ToolSet[string],
  metadata: ToolContractMetadata,
): ToolContractNormalization {
  const source = value as ToolWithContractFields
  if (typeof source.description !== 'string' || !source.description.trim()) {
    return invalid(name, `Tool ${name} description is required`)
  }
  if (source.inputSchema === undefined) {
    return invalid(name, `Tool ${name} input schema is required`)
  }
  const checked = validateMetadata(name, metadata as unknown as Record<string, unknown>)
  if ('diagnostics' in checked) return checked

  return buildContract({
    name,
    namespace: checked.namespace,
    version: checked.version,
    description: source.description,
    inputSchema: source.inputSchema,
    ...(source.outputSchema === undefined ? {} : { outputSchema: source.outputSchema }),
    annotations: {
      readOnly: checked.readOnly,
      destructive: checked.destructive,
      idempotent: checked.idempotent,
      openWorld: checked.openWorld,
      approval: checked.approval,
    },
    execution: { concurrency: checked.concurrency, retry: checked.retry },
    availability: 'available',
    source: 'native',
  })
}

const legacySensitiveVerb = /(^|_)(publish|delete|update|save|create|add|attach|upload|record)(_|$)/
const legacyReadPrefix = /^(list|get|search|read|fetch|find)_/

export function legacyToolContract(
  name: string,
  value: ToolSet[string],
): ToolContractNormalization {
  const source = value as ToolWithContractFields
  const recognizedRead = name === 'readSkillReference' || legacyReadPrefix.test(name)
  const recognizedWrite = name !== 'generateImage'
    && name !== 'readSkillReference'
    && !recognizedRead
    && legacySensitiveVerb.test(name)
  const readOnly = !recognizedWrite
  const result = buildContract({
    name,
    namespace: 'system',
    version: 'legacy-1',
    description: typeof source.description === 'string' ? source.description : '',
    inputSchema: source.inputSchema ?? {},
    ...(source.outputSchema === undefined ? {} : { outputSchema: source.outputSchema }),
    annotations: {
      readOnly,
      destructive: false,
      idempotent: readOnly,
      openWorld: name === 'generateImage',
      approval: recognizedWrite ? 'writes' : 'never',
    },
    execution: {
      concurrency: readOnly ? 'parallel-safe' : 'serialized',
      retry: readOnly ? 'safe' : 'claim-backed',
    },
    availability: 'available',
    source: 'legacy',
  })
  if (!result.contract) return result
  return {
    contract: result.contract,
    diagnostics: [{
      toolName: name,
      severity: 'warning',
      code: 'legacy-contract',
      message: `Tool ${name} uses a name-inferred legacy contract`,
    }],
  }
}
