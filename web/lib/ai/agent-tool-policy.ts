import type { ToolSet } from 'ai'

import type {
  AgentApprovalPolicy,
  AgentToolAudit,
  AgentToolDecision,
} from './agent-runtime-types'

const sensitiveToolVerb = /(^|_)(publish|delete|update|save|create|add|attach|upload|record)(_|$)/
const readOnlyToolPrefix = /^(list|get|search|read|fetch|find)_/
const auditValueLimit = 8_000
const auditErrorLimit = 2_000
const auditEvidenceIdLimit = 500

export function requiresToolApproval(name: string) {
  return name !== 'generateImage'
    && name !== 'readSkillReference'
    && !readOnlyToolPrefix.test(name)
    && sensitiveToolVerb.test(name)
}

export type AgentConcurrencyPolicy = 'parallel-safe' | 'serialized' | 'unknown'
export type AgentIdempotencyPolicy = 'replayable' | 'claim-backed' | 'unknown'

export type AgentToolExecutionMetadata = {
  concurrencyPolicy: AgentConcurrencyPolicy
  idempotencyPolicy: AgentIdempotencyPolicy
}

export function toolExecutionMetadata(name: string): AgentToolExecutionMetadata {
  if (name === 'generateImage') {
    return { concurrencyPolicy: 'serialized', idempotencyPolicy: 'unknown' }
  }
  if (name === 'readSkillReference' || readOnlyToolPrefix.test(name)) {
    return { concurrencyPolicy: 'parallel-safe', idempotencyPolicy: 'replayable' }
  }
  if (requiresToolApproval(name)) {
    return { concurrencyPolicy: 'serialized', idempotencyPolicy: 'claim-backed' }
  }
  return { concurrencyPolicy: 'serialized', idempotencyPolicy: 'unknown' }
}

export type AgentToolPolicyProfile = 'chat' | 'scheduled' | 'response-writing'

export type ResolvedAgentToolPolicy = {
  approvalPolicy: AgentApprovalPolicy
  allowedToolNames?: readonly string[]
  blockedToolNames?: readonly string[]
  alwaysAvailableToolNames?: readonly string[]
}

export const RESPONSE_AGENT_TOOL_ALLOWLIST = [
  'web_search',
  'fetch_url',
  'get_content_directions',
  'list_drafts',
  'get_draft',
  'search_creative_assets',
  'get_creative_asset',
  'list_creative_asset_candidates',
  'get_recent_content_usage',
  'list_writing_plans',
  'get_writing_plan',
  'search_writing_plans',
  'list_publish_accounts',
  'get_account_profile',
  'loadSkill',
  'readSkillReference',
  'save_draft',
] as const

const scheduledBlockedToolNames = [
  'upload_image_from_url',
  'upload_image_from_path',
] as const

export const AGENT_TOOL_POLICY_PROFILES: Record<AgentToolPolicyProfile, ResolvedAgentToolPolicy> = {
  chat: {
    approvalPolicy: 'interactive',
    alwaysAvailableToolNames: ['generateImage'],
  },
  scheduled: {
    approvalPolicy: 'automatic',
    blockedToolNames: scheduledBlockedToolNames,
  },
  'response-writing': {
    approvalPolicy: 'automatic',
    allowedToolNames: RESPONSE_AGENT_TOOL_ALLOWLIST,
  },
}

export type AgentToolPolicyOverrides = {
  approvalPolicy?: AgentApprovalPolicy
  allowedToolNames?: readonly string[]
  blockedToolNames?: readonly string[]
  alwaysAvailableToolNames?: readonly string[]
}

export function resolveAgentToolPolicy(
  profile?: AgentToolPolicyProfile,
  overrides: AgentToolPolicyOverrides = {},
): ResolvedAgentToolPolicy {
  const preset = profile ? AGENT_TOOL_POLICY_PROFILES[profile] : undefined
  return {
    approvalPolicy: overrides.approvalPolicy ?? preset?.approvalPolicy ?? 'interactive',
    allowedToolNames: overrides.allowedToolNames ?? preset?.allowedToolNames,
    blockedToolNames: overrides.blockedToolNames ?? preset?.blockedToolNames,
    alwaysAvailableToolNames: overrides.alwaysAvailableToolNames
      ?? preset?.alwaysAvailableToolNames,
  }
}

export type AgentToolPolicyOptions = {
  policy: AgentApprovalPolicy
  beforeToolExecute?: (event: AgentToolAudit) => Promise<AgentToolDecision>
  onAudit?: (event: AgentToolAudit) => void | Promise<void>
}

type ToolWithExecution = Record<string, unknown> & {
  execute?: (input: unknown, options: { toolCallId?: string }) => Promise<unknown>
}

function enqueueSerialized<T>(
  queues: Map<string, Promise<void>>,
  toolName: string,
  task: () => Promise<T>,
) {
  const previous = queues.get(toolName) ?? Promise.resolve()
  let release: () => void = () => undefined
  const current = new Promise<void>(resolve => { release = resolve })
  queues.set(toolName, current)
  return previous.then(task).finally(() => {
    release()
    if (queues.get(toolName) === current) queues.delete(toolName)
  })
}

function collectEvidenceIds(value: unknown) {
  const ids = new Set<number>()
  const assetIds = new Set<number>()
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit)
      return
    }
    if (!candidate || typeof candidate !== 'object') return
    for (const [key, nested] of Object.entries(candidate)) {
      if (typeof nested === 'number' && Number.isSafeInteger(nested) && nested > 0) {
        if (key === 'id' && ids.size < auditEvidenceIdLimit) ids.add(nested)
        if (key === 'asset_id' && assetIds.size < auditEvidenceIdLimit) assetIds.add(nested)
      }
      visit(nested)
    }
  }
  visit(value)
  return { evidenceIds: [...ids], evidenceAssetIds: [...assetIds] }
}

function boundedAuditValue(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    const serialized = JSON.stringify(value)
    if (serialized.length <= auditValueLimit) return value
    return {
      truncated: true,
      originalBytes: serialized.length,
      ...collectEvidenceIds(value),
    }
  } catch {
    return { unavailable: true }
  }
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, auditErrorLimit)
}

function mcpErrorMessage(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = value as Record<string, unknown>
  if (result.isError !== true) return undefined
  const content = Array.isArray(result.content) ? result.content : []
  const text = content.find(item => (
    item && typeof item === 'object'
    && (item as Record<string, unknown>).type === 'text'
    && typeof (item as Record<string, unknown>).text === 'string'
  )) as Record<string, unknown> | undefined
  return boundedError(text?.text ?? 'MCP tool returned an error')
}

function completedAudit(started: AgentToolAudit, output: unknown): AgentToolAudit {
  const error = mcpErrorMessage(output)
  return {
    ...started,
    status: error ? 'failed' : 'succeeded',
    output: boundedAuditValue(output),
    ...(error ? { error } : {}),
    occurredAt: new Date().toISOString(),
  }
}

export function applyAgentToolPolicy(
  tools: ToolSet,
  { policy, beforeToolExecute, onAudit }: AgentToolPolicyOptions,
): ToolSet {
  const queues = new Map<string, Promise<void>>()
  return Object.fromEntries(Object.entries(tools).map(([toolName, original]) => {
    const source = original as ToolWithExecution
    const sideEffecting = requiresToolApproval(toolName)
    const metadata = toolExecutionMetadata(toolName)
    const autoApproved = sideEffecting && policy === 'automatic'
    const wrapped: ToolWithExecution = {
      ...source,
      needsApproval: sideEffecting && policy === 'interactive',
    }
    if (!source.execute) return [toolName, wrapped]

    const execute = async (input: unknown, options: { toolCallId?: string }) => {
      const started: AgentToolAudit = {
        toolName,
        toolCallId: options?.toolCallId ?? 'unknown',
        sideEffecting,
        autoApproved,
        status: 'started',
        inputSummary: boundedAuditValue(input),
        occurredAt: new Date().toISOString(),
      }
      const decision = beforeToolExecute
        ? await beforeToolExecute(started)
        : { action: 'execute' as const }
      if (decision.action === 'replay') {
        await onAudit?.(completedAudit(started, decision.output))
        return decision.output
      }
      if (decision.action === 'uncertain') {
        await onAudit?.({
          ...started,
          status: 'uncertain',
          error: decision.error.slice(0, auditErrorLimit),
          occurredAt: new Date().toISOString(),
        })
        throw new Error(decision.error)
      }

      await onAudit?.(started)
      try {
        const output = await source.execute!.call(original, input, options)
        await onAudit?.(completedAudit(started, output))
        return output
      } catch (error) {
        await onAudit?.({
          ...started,
          status: 'failed',
          error: boundedError(error),
          occurredAt: new Date().toISOString(),
        })
        throw error
      }
    }
    wrapped.execute = (input, options) => metadata.concurrencyPolicy === 'serialized'
      ? enqueueSerialized(queues, toolName, () => execute(input, options))
      : execute(input, options)
    return [toolName, wrapped]
  })) as ToolSet
}
