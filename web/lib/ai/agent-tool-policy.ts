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

export type AgentToolPolicyOptions = {
  policy: AgentApprovalPolicy
  beforeToolExecute?: (event: AgentToolAudit) => Promise<AgentToolDecision>
  onAudit?: (event: AgentToolAudit) => void | Promise<void>
}

type ToolWithExecution = Record<string, unknown> & {
  execute?: (input: unknown, options: { toolCallId?: string }) => Promise<unknown>
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
  return Object.fromEntries(Object.entries(tools).map(([toolName, original]) => {
    const source = original as ToolWithExecution
    const sideEffecting = requiresToolApproval(toolName)
    const autoApproved = sideEffecting && policy === 'automatic'
    const wrapped: ToolWithExecution = {
      ...source,
      needsApproval: sideEffecting && policy === 'interactive',
    }
    if (!source.execute) return [toolName, wrapped]

    wrapped.execute = async (input, options) => {
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
    return [toolName, wrapped]
  })) as ToolSet
}
