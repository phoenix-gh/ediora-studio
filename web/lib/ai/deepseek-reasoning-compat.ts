import type { LanguageModelMiddleware } from 'ai'

type JsonRecord = Record<string, unknown>

const reasoningOpeningTag = '<think>'
const reasoningClosingTag = '</think>'

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
  let changed = false
  const choices = payload && Array.isArray(payload.choices) ? payload.choices : []
  for (const value of choices) {
    const message = record(record(value)?.message)
    observeMessage(message, remember)
    if (typeof message?.reasoning_content !== 'string') continue
    message.content = `${reasoningOpeningTag}${message.reasoning_content}${reasoningClosingTag}${typeof message.content === 'string' ? message.content : ''}`
    delete message.reasoning_content
    changed = true
  }
  return changed
}

function taggedReasoning(content: string) {
  const regexp = /<think>([\s\S]*?)<\/think>/g
  const matches = Array.from(content.matchAll(regexp))
  if (!matches.length) return undefined
  return {
    reasoning: matches.map(match => match[1]).join('\n'),
    content: content.replace(regexp, ''),
  }
}

/** Keep persisted AI SDK reasoning parts available to the DeepSeek HTTP adapter. */
export function deepSeekReasoningPersistenceMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => ({
      ...params,
      prompt: params.prompt.map(message => message.role !== 'assistant'
        ? message
        : {
            ...message,
            content: message.content.flatMap(part => part.type === 'reasoning'
              ? [{
                  type: 'text' as const,
                  text: `${reasoningOpeningTag}${part.text}${reasoningClosingTag}`,
                  providerOptions: part.providerOptions,
                }]
              : [part]),
          }),
    }),
  }
}

function observedEventStream(
  response: Response,
  remember: (id: string, reasoning: string) => void,
): Response {
  if (!response.body) return response
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let reasoning = ''
  const toolCallIdsByIndex = new Map<number, string>()
  const reasoningOpenByChoice = new Set<number>()

  const transformLine = (line: string) => {
    if (!line.startsWith('data:')) return line
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') return line
    try {
      const payload = record(JSON.parse(data))
      const choices = payload && Array.isArray(payload.choices) ? payload.choices : []
      for (const value of choices) {
        const choice = record(value)
        const delta = record(choice?.delta)
        if (!delta) continue
        const choiceIndex = typeof choice?.index === 'number' ? choice.index : 0
        const nativeReasoning = delta.reasoning_content
        if (typeof nativeReasoning === 'string') {
          reasoning += nativeReasoning
          delta.content = `${reasoningOpenByChoice.has(choiceIndex) ? '' : reasoningOpeningTag}${nativeReasoning}${typeof delta.content === 'string' ? delta.content : ''}`
          delete delta.reasoning_content
          reasoningOpenByChoice.add(choiceIndex)
        } else if (reasoningOpenByChoice.has(choiceIndex) && (
          typeof delta.content === 'string'
          || Array.isArray(delta.tool_calls)
          || choice?.finish_reason != null
        )) {
          delta.content = `${reasoningClosingTag}${typeof delta.content === 'string' ? delta.content : ''}`
          reasoningOpenByChoice.delete(choiceIndex)
        }
        if (!Array.isArray(delta.tool_calls)) continue
        for (const callValue of delta.tool_calls) {
          const call = record(callValue)
          if (typeof call?.index !== 'number' || typeof call.id !== 'string') continue
          toolCallIdsByIndex.set(call.index, `${toolCallIdsByIndex.get(call.index) ?? ''}${call.id}`)
        }
      }
      return `data: ${JSON.stringify(payload)}`
    } catch {
      // The provider owns validation of malformed SSE data.
      return line
    }
  }

  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        controller.enqueue(encoder.encode(`${transformLine(line)}\n`))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer) controller.enqueue(encoder.encode(transformLine(buffer.replace(/\r$/, ''))))
      if (reasoning) {
        toolCallIdsByIndex.forEach(id => {
          if (id) remember(id, reasoning)
        })
      }
    },
  }))
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
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
          if (message?.role !== 'assistant') continue
          const ids = toolCallIds(message)
          if (typeof message.content === 'string') {
            const tagged = taggedReasoning(message.content)
            if (tagged) {
              message.reasoning_content = tagged.reasoning
              message.content = tagged.content || (ids.length ? null : '')
              changed = true
              continue
            }
          }
          if (typeof message.reasoning_content === 'string') continue
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
    try {
      const payload = record(await response.clone().json())
      if (observeJsonResponse(payload, (id, reasoning) => reasoningByToolCall.set(id, reasoning))) {
        const headers = new Headers(response.headers)
        headers.delete('content-length')
        return new Response(JSON.stringify(payload), {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      }
    } catch {
      // The provider owns validation of malformed successful responses.
    }
    return response
  }
}
