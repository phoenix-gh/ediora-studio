import type { ModelMessage } from 'ai'

import type {
  ChatRunCheckpoint,
  ChatRunToolCallCheckpoint,
} from './chat-run-types'

export type ChatRunHistoryErrorCode =
  | 'duplicate_tool_call'
  | 'orphan_result'
  | 'missing_result'
  | 'invalid_pending_call'

export class ChatRunHistoryError extends Error {
  constructor(readonly code: ChatRunHistoryErrorCode, message: string) {
    super(message)
    this.name = 'ChatRunHistoryError'
  }
}

function assistantToolCalls(content: Array<Record<string, unknown>>) {
  return content.flatMap(part => {
    if (part.type !== 'tool-call' || typeof part.toolCallId !== 'string') return []
    return [{
      toolCallId: part.toolCallId,
      toolName: typeof part.toolName === 'string' ? part.toolName : '',
    }]
  })
}

function resultOutput(call: ChatRunToolCallCheckpoint) {
  if (call.status === 'failed' && call.output_data == null) {
    return { error: call.error_data ?? { code: 'tool_execution_failed' } }
  }
  return call.output_data
}

export function validateCanonicalToolHistory(checkpoint: ChatRunCheckpoint): void {
  const assistantCalls = new Map<string, { toolName: string; stepId: number }>()
  for (const step of [...checkpoint.steps].sort((a, b) => a.ordinal - b.ordinal)) {
    for (const call of assistantToolCalls(step.assistant_content)) {
      if (assistantCalls.has(call.toolCallId)) {
        throw new ChatRunHistoryError(
          'duplicate_tool_call', `Duplicate assistant tool call ${call.toolCallId}`,
        )
      }
      assistantCalls.set(call.toolCallId, { toolName: call.toolName, stepId: step.id })
    }
  }

  const rows = new Map<string, ChatRunToolCallCheckpoint>()
  for (const call of checkpoint.tool_calls) {
    if (rows.has(call.tool_call_id)) {
      throw new ChatRunHistoryError(
        'duplicate_tool_call', `Duplicate checkpoint tool call ${call.tool_call_id}`,
      )
    }
    rows.set(call.tool_call_id, call)
    const assistant = assistantCalls.get(call.tool_call_id)
    if (!assistant || assistant.stepId !== call.step_id || assistant.toolName !== call.tool_name) {
      throw new ChatRunHistoryError(
        'orphan_result', `Tool result ${call.tool_call_id} has no matching assistant call`,
      )
    }
  }

  for (const toolCallId of assistantCalls.keys()) {
    const row = rows.get(toolCallId)
    if (!row) {
      throw new ChatRunHistoryError(
        'missing_result', `Tool call ${toolCallId} has no checkpoint row`,
      )
    }
    if (row.status === 'pending_approval') {
      if (checkpoint.run.status !== 'waiting_approval' || row.output_data != null) {
        throw new ChatRunHistoryError(
          'invalid_pending_call', `Tool call ${toolCallId} is not the current pending approval`,
        )
      }
      continue
    }
    if (row.status === 'approved' || row.status === 'executing') {
      throw new ChatRunHistoryError(
        'missing_result', `Tool call ${toolCallId} has no terminal result`,
      )
    }
    if (row.status === 'outcome_unknown') {
      throw new ChatRunHistoryError(
        'missing_result', `Tool call ${toolCallId} has an unknown outcome`,
      )
    }
  }
}

export function buildCanonicalModelMessages(checkpoint: ChatRunCheckpoint): ModelMessage[] {
  validateCanonicalToolHistory(checkpoint)
  const callsByStep = new Map<number, ChatRunToolCallCheckpoint[]>()
  for (const call of checkpoint.tool_calls) {
    const calls = callsByStep.get(call.step_id) ?? []
    calls.push(call)
    callsByStep.set(call.step_id, calls)
  }

  const messages: ModelMessage[] = [{ role: 'user', content: checkpoint.run.objective }]
  for (const step of [...checkpoint.steps].sort((a, b) => a.ordinal - b.ordinal)) {
    messages.push({
      role: 'assistant',
      content: step.assistant_content,
    } as ModelMessage)
    const results = (callsByStep.get(step.id) ?? []).filter(call => (
      call.status === 'succeeded' || call.status === 'failed' || call.status === 'rejected'
    ))
    if (results.length > 0) {
      messages.push({
        role: 'tool',
        content: results.map(call => ({
          type: 'tool-result' as const,
          toolCallId: call.tool_call_id,
          toolName: call.tool_name,
          output: resultOutput(call),
        })),
      } as ModelMessage)
    }
  }
  return messages
}
