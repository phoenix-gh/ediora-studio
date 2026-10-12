const COMMAND_OUTPUT_LIMIT = 4_000
const REASONING_LIMIT = 12_000

export type CodexSessionEventDraft = {
  type: 'assistant/message' | 'tool/call' | 'tool/result'
  turn: number
  step: number
  data: Record<string, unknown>
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function clip(value: string, limit: number) {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n…`
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function looseText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(part => looseText(part)).filter(Boolean).join('\n')
  }
  const item = record(value)
  if (!item) return ''
  return textValue(item.text ?? item.content)
}

function itemText(item: Record<string, unknown>) {
  for (const key of ['text', 'content', 'summary', 'summary_text', 'summaryText', 'raw_content', 'rawContent']) {
    const text = looseText(item[key]).trim()
    if (text) return text
  }
  return ''
}

function errorMessage(value: unknown) {
  if (typeof value === 'string') return value
  return textValue(record(value)?.message)
}

function shellName(command: unknown) {
  if (Array.isArray(command)) {
    const scriptIndex = command.findIndex(part => part === '-lc' || part === '-c')
    const script = scriptIndex >= 0 ? command[scriptIndex + 1] : undefined
    const shown = textValue(script) || command.filter(part => typeof part === 'string').join(' ')
    return shown.replace(/\s+/g, ' ').trim().slice(0, 180) || 'shell'
  }
  const shown = textValue(command).replace(/\s+/g, ' ').trim()
  return shown.slice(0, 180) || 'shell'
}

function boundedOutput(value: unknown) {
  if (typeof value === 'string') return clip(value, COMMAND_OUTPUT_LIMIT)
  try {
    const text = JSON.stringify(value)
    if (!text || text.length <= COMMAND_OUTPUT_LIMIT) return value
    return clip(text, COMMAND_OUTPUT_LIMIT)
  } catch {
    return String(value).slice(0, COMMAND_OUTPUT_LIMIT)
  }
}

function assistantMessage(
  context: { turn: number; step: number },
  kind: 'text' | 'reasoning',
  text: string,
): CodexSessionEventDraft[] {
  const body = clip(text.trim(), kind === 'reasoning' ? REASONING_LIMIT : 20_000)
  if (!body) return []
  return [{
    type: 'assistant/message',
    turn: context.turn,
    step: context.step,
    data: {
      turn: context.turn,
      step: context.step,
      blocks: [{ kind, text: body }],
    },
  }]
}

function isReasoningItem(item: Record<string, unknown>) {
  const itemType = textValue(item.type)
  return itemType === 'Reasoning' || itemType === 'reasoning'
}

function isImageGenerationItem(item: Record<string, unknown>) {
  const itemType = textValue(item.type)
  const kind = textValue(item.kind)
  return itemType === 'imageGeneration'
    || itemType === 'ImageGeneration'
    || ((itemType === 'extension' || itemType === 'Extension') && kind === 'image_gen.generation')
}

function toolEvents(
  context: { turn: number; step: number },
  call: {
    callId: string
    name: string
    arguments: unknown
    output: unknown
    error: string
    failed: boolean
  },
): CodexSessionEventDraft[] {
  if (!call.callId || !call.name) return []
  const result: Record<string, unknown> = {
    turn: context.turn,
    step: context.step,
    callId: call.callId,
    isError: call.failed,
  }
  if (call.error) result.error = clip(call.error, 20_000)
  if (call.output !== null && call.output !== undefined) result.output = boundedOutput(call.output)
  else if (!call.error) result.output = { status: 'completed' }
  return [
    {
      type: 'tool/call',
      turn: context.turn,
      step: context.step,
      data: {
        turn: context.turn,
        step: context.step,
        callId: call.callId,
        name: call.name.slice(0, 300),
        arguments: call.arguments ?? {},
      },
    },
    {
      type: 'tool/result',
      turn: context.turn,
      step: context.step,
      data: result,
    },
  ]
}

export function codexSessionEvents(
  notification: { method: string; params?: Record<string, unknown> },
  context: { turn: number; step: number },
): CodexSessionEventDraft[] {
  if (notification.method !== 'item/completed') return []
  const item = record(notification.params?.item)
  if (!item) return []
  const itemType = textValue(item.type)
  if (itemType === 'AgentMessage' || itemType === 'agentMessage') {
    return assistantMessage(context, 'text', itemText(item))
  }
  if (isReasoningItem(item)) {
    return assistantMessage(context, 'reasoning', itemText(item))
  }
  if (isImageGenerationItem(item)) {
    const revised = clip(looseText(item.revisedPrompt ?? item.revised_prompt).trim(), 4_000)
    const saved = textValue(item.savedPath) || textValue(item.saved_path)
    const failure = errorMessage(item.failure)
    const status = textValue(item.status)
    return toolEvents(context, {
      callId: textValue(item.id),
      name: 'imagegen',
      arguments: {
        ...(revised ? { revisedPrompt: revised } : {}),
        ...(saved ? { savedPath: saved } : {}),
        ...(typeof item.transparentBackground === 'boolean'
          ? { transparentBackground: item.transparentBackground }
          : {}),
      },
      output: status ? { status } : null,
      error: failure,
      failed: status === 'failed' || failure.length > 0,
    })
  }
  if (itemType === 'ImageView' || itemType === 'imageView') {
    const imagePath = textValue(item.path)
    if (!imagePath) return []
    return toolEvents(context, {
      callId: textValue(item.id),
      name: '查看图片',
      arguments: { path: imagePath },
      output: { path: imagePath },
      error: '',
      failed: false,
    })
  }
  if (itemType === 'McpToolCall' || itemType === 'mcpToolCall') {
    const tool = textValue(item.tool)
    const server = textValue(item.server)
    const error = errorMessage(item.error)
    return toolEvents(context, {
      callId: textValue(item.id),
      name: server && tool ? `${server}/${tool}` : tool,
      arguments: item.arguments ?? {},
      output: item.result ?? null,
      error,
      failed: item.status === 'failed' || error.length > 0,
    })
  }
  if (itemType === 'CommandExecution' || itemType === 'commandExecution') {
    const exitCode = typeof item.exit_code === 'number'
      ? item.exit_code
      : typeof item.exitCode === 'number'
        ? item.exitCode
        : null
    const error = exitCode !== null && exitCode !== 0 ? `exit ${exitCode}` : ''
    const command = item.command
    const output = textValue(item.aggregated_output)
      || textValue(item.aggregatedOutput)
      || [textValue(item.stdout), textValue(item.stderr)].filter(Boolean).join('\n')
    return toolEvents(context, {
      callId: textValue(item.id),
      name: shellName(command),
      arguments: {
        command,
        ...(textValue(item.cwd) ? { cwd: textValue(item.cwd) } : {}),
      },
      output,
      error,
      failed: error.length > 0,
    })
  }
  return []
}

function reasoningDelta(params: Record<string, unknown> | undefined) {
  return textValue(params?.delta)
}

function streamKey(params: Record<string, unknown> | undefined) {
  return textValue(params?.itemId) || textValue(params?.item_id) || '_'
}

function takeBuffer(buffers: Map<string, string>, id: string) {
  const key = id || '_'
  const text = buffers.get(key) ?? ''
  buffers.delete(key)
  return text
}

function withBufferedCommandOutput(
  events: CodexSessionEventDraft[],
  buffered: string,
) {
  const output = clip(buffered.trim(), COMMAND_OUTPUT_LIMIT)
  if (!output) return events
  return events.map(event => {
    if (event.type !== 'tool/result') return event
    if (typeof event.data.output === 'string' && event.data.output.trim()) return event
    return { ...event, data: { ...event.data, output } }
  })
}

function turnItems(params: Record<string, unknown> | undefined) {
  const turn = record(params?.turn)
  return Array.isArray(turn?.items) ? turn.items : []
}

export function createCodexSessionRecorder() {
  const reasoning = new Map<string, string>()
  const commands = new Map<string, string>()
  const seen = new Set<string>()
  return (
    notification: { method: string; params?: Record<string, unknown> },
    context: { turn: number; step: number },
  ): CodexSessionEventDraft[] => {
    const completeItem = (item: Record<string, unknown>) => {
      const id = textValue(item.id)
      if (id && seen.has(id)) return []
      if (id) seen.add(id)
      const completed = { method: 'item/completed', params: { item } }
      if (isReasoningItem(item)) {
        const buffered = takeBuffer(reasoning, id)
        const events = codexSessionEvents(completed, context)
        if (events.length > 0) return events
        return assistantMessage(context, 'reasoning', buffered)
      }
      const itemType = textValue(item.type)
      if (itemType === 'CommandExecution' || itemType === 'commandExecution') {
        const buffered = takeBuffer(commands, id)
        return withBufferedCommandOutput(codexSessionEvents(completed, context), buffered)
      }
      return codexSessionEvents(completed, context)
    }

    if (
      notification.method === 'item/reasoning/textDelta'
      || notification.method === 'item/commandExecution/outputDelta'
    ) {
      const delta = reasoningDelta(notification.params)
      if (!delta) return []
      const buffers = notification.method === 'item/reasoning/textDelta' ? reasoning : commands
      const limit = notification.method === 'item/reasoning/textDelta'
        ? REASONING_LIMIT
        : COMMAND_OUTPUT_LIMIT
      const id = streamKey(notification.params)
      buffers.set(id, clip(`${buffers.get(id) ?? ''}${delta}`, limit))
      return []
    }
    if (notification.method === 'item/completed') {
      const item = record(notification.params?.item)
      return item ? completeItem(item) : []
    }
    if (
      notification.method === 'turn/completed'
      || notification.method === 'turn/failed'
      || notification.method === 'turn/cancelled'
    ) {
      return turnItems(notification.params).flatMap(item => {
        const recordItem = record(item)
        return recordItem ? completeItem(recordItem) : []
      })
    }
    return codexSessionEvents(notification, context)
  }
}
