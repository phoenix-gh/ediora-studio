import type { ToolSet } from 'ai'

import type {
  AgentApprovalPolicy,
  AgentToolAudit,
  AgentToolDecision,
} from './agent-runtime-types'

const sensitiveToolVerb = /(^|_)(publish|delete|update|save|create|add|upload)(_|$)/
const readOnlyToolPrefix = /^(list|get|search|read|fetch|find)_/
const auditValueLimit = 8_000
const auditErrorLimit = 2_000

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

function boundedAuditValue(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    const serialized = JSON.stringify(value)
    if (serialized.length <= auditValueLimit) return value
    return { truncated: serialized.slice(0, auditValueLimit), originalBytes: serialized.length }
  } catch {
    return { unavailable: true }
  }
}

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, auditErrorLimit)
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
        await onAudit?.({
          ...started,
          status: 'succeeded',
          output: boundedAuditValue(decision.output),
          occurredAt: new Date().toISOString(),
        })
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
        await onAudit?.({
          ...started,
          status: 'succeeded',
          output: boundedAuditValue(output),
          occurredAt: new Date().toISOString(),
        })
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
