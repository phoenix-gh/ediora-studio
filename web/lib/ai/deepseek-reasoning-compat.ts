type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function toolCallIds(message: JsonRecord): string[] {
  return Array.isArray(message.tool_calls)
    ? message.tool_calls.flatMap(call => {
        const id = record(call)?.id
        return typeof id === 'string' && id ? [id] : []
      })
    : []
}

function observeMessage(
  message: JsonRecord | undefined,
  remember: (id: string, reasoning: string) => void,
) {
  const reasoning = message?.reasoning_content
  if (typeof reasoning !== 'string' || !reasoning) return
  toolCallIds(message).forEach(id => remember(id, reasoning))
}

function observeJsonResponse(
  payload: JsonRecord | undefined,
  remember: (id: string, reasoning: string) => void,
) {
  const choices = payload && Array.isArray(payload.choices) ? payload.choices : []
  for (const value of choices) observeMessage(record(record(value)?.message), remember)
}

function observedEventStream(
  response: Response,
  remember: (id: string, reasoning: string) => void,
): Response {
  if (!response.body) return response
  const decoder = new TextDecoder()
  let buffer = ''
  let reasoning = ''
  const toolCallIdsByIndex = new Map<number, string>()

  const observeLine = (line: string) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return
    try {
      const payload = record(JSON.parse(data))
      const choices = payload && Array.isArray(payload.choices) ? payload.choices : []
      for (const value of choices) {
        const delta = record(record(value)?.delta)
        if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content
        if (!Array.isArray(delta?.tool_calls)) continue
        for (const callValue of delta.tool_calls) {
          const call = record(callValue)
          if (typeof call?.index !== 'number' || typeof call.id !== 'string') continue
          toolCallIdsByIndex.set(call.index, `${toolCallIdsByIndex.get(call.index) ?? ''}${call.id}`)
        }
      }
    } catch {
      // The provider owns validation of malformed SSE data.
    }
  }

  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        observeLine(buffer.slice(0, newline).replace(/\r$/, ''))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
      controller.enqueue(chunk)
    },
    flush() {
      buffer += decoder.decode()
      if (buffer) observeLine(buffer.replace(/\r$/, ''))
      if (reasoning) {
        toolCallIdsByIndex.forEach(id => {
          if (id) remember(id, reasoning)
        })
      }
    },
  }))
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** Preserve DeepSeek thinking across OpenAI-compatible multi-step tool calls. */
export function createDeepSeekReasoningFetch(baseFetch: typeof fetch): typeof fetch {
  const reasoningByToolCall = new Map<string, string>()

  return async (input, init) => {
    let requestInit = init
    if (typeof init?.body === 'string') {
      try {
        const payload = record(JSON.parse(init.body))
        const messages = payload && Array.isArray(payload.messages) ? payload.messages : []
        let changed = false
        for (const value of messages) {
          const message = record(value)
          if (message?.role !== 'assistant' || typeof message.reasoning_content === 'string') continue
          const ids = toolCallIds(message)
          const reasoning = ids.map(id => reasoningByToolCall.get(id)).find(Boolean)
          if (!reasoning) continue
          message.reasoning_content = reasoning
          changed = true
        }
        if (changed) requestInit = { ...init, body: JSON.stringify(payload) }
      } catch {
        // Leave non-JSON request bodies untouched.
      }
    }

    const response = await baseFetch(input, requestInit)
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      return observedEventStream(response, (id, reasoning) => reasoningByToolCall.set(id, reasoning))
    }
    {
      try {
        const payload = record(await response.clone().json())
        observeJsonResponse(payload, (id, reasoning) => reasoningByToolCall.set(id, reasoning))
      } catch {
        // The provider owns validation of malformed successful responses.
      }
    }
    return response
  }
}
