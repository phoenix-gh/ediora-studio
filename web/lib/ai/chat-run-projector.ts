import type {
  ChatRunCheckpoint,
  ChatRunToolCallCheckpoint,
  PersistedArtifact,
} from './chat-run-types'

export type ChatRunProjection = {
  runId: string
  status: ChatRunCheckpoint['run']['status']
  text: string
  parts: Array<Record<string, unknown>>
}

function draftArtifact(call: ChatRunToolCallCheckpoint): PersistedArtifact | undefined {
  if (call.status !== 'succeeded' || call.tool_name !== 'save_draft') return undefined
  const output = call.output_data
  if (!output || typeof output !== 'object') return undefined
  const record = output as Record<string, unknown>
  if (record.saved !== true || typeof record.id !== 'number') return undefined
  return {
    kind: 'draft',
    id: record.id,
    ...(typeof record.title === 'string' && record.title ? { title: record.title } : {}),
    url: `/drafts?draft=${record.id}`,
  }
}

function errorMessage(errorData: Record<string, unknown> | null) {
  if (typeof errorData?.message === 'string' && errorData.message) return errorData.message
  if (typeof errorData?.detail === 'string' && errorData.detail) return errorData.detail
  return 'Chat Run 执行失败'
}

export function projectChatRun(checkpoint: ChatRunCheckpoint): ChatRunProjection {
  const parts: Array<Record<string, unknown>> = [{
    type: 'data-chat-run',
    data: { runId: checkpoint.run.id, status: checkpoint.run.status },
  }]
  const calls = new Map(checkpoint.tool_calls.map(call => [call.tool_call_id, call]))
  const text: string[] = []
  for (const step of [...checkpoint.steps].sort((a, b) => a.ordinal - b.ordinal)) {
    for (const content of step.assistant_content) {
      if (content.type === 'text' && typeof content.text === 'string') {
        text.push(content.text)
        parts.push(content)
        continue
      }
      if (content.type === 'reasoning') {
        parts.push(content)
        continue
      }
      if (content.type !== 'tool-call' || typeof content.toolCallId !== 'string') continue
      const call = calls.get(content.toolCallId)
      if (!call) continue
      if (call.status === 'pending_approval') {
        parts.push({
          type: 'dynamic-tool', toolCallId: call.tool_call_id, toolName: call.tool_name,
          state: 'approval-requested', input: call.input_data,
          approval: { id: call.approval_id }, runId: checkpoint.run.id,
        })
      } else {
        parts.push({
          type: 'dynamic-tool', toolCallId: call.tool_call_id, toolName: call.tool_name,
          state: call.status === 'failed' || call.status === 'outcome_unknown'
            ? 'output-error' : 'output-available',
          input: call.input_data,
          output: call.output_data,
          approval: call.approval_id ? { id: call.approval_id } : undefined,
          approvalDecision: call.approval_decision,
          runId: checkpoint.run.id,
        })
      }
    }
  }
  const artifactIds = new Set<string>()
  for (const call of checkpoint.tool_calls) {
    const artifact = draftArtifact(call)
    if (!artifact || artifactIds.has(`${artifact.kind}:${artifact.id}`)) continue
    artifactIds.add(`${artifact.kind}:${artifact.id}`)
    parts.push({ type: 'data-artifact', data: artifact })
  }
  if (checkpoint.run.status === 'failed' || checkpoint.run.status === 'needs_reconciliation') {
    parts.push({
      type: 'data-chat-run-error',
      data: { message: errorMessage(checkpoint.run.error_data) },
    })
  }
  return { runId: checkpoint.run.id, status: checkpoint.run.status, text: text.join('\n'), parts }
}
