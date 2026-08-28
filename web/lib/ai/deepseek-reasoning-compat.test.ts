import { generateText, stepCountIs, streamText, tool } from 'ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { textModelFromConfig } from './runtime-config'

function eventStream(chunks: unknown[]) {
  return new Response(
    `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

describe('DeepSeek reasoning compatibility over the OpenAI adapter', () => {
  it('passes reasoning_content back after a DeepSeek tool call', async () => {
    const requests: Record<string, unknown>[] = []
    const fakeFetch: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      const first = requests.length === 1
      const body = first
        ? {
            id: 'first',
            object: 'chat.completion',
            created: 1,
            model: 'deepseek-v4-flash',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                reasoning_content: 'private reasoning',
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'lookup', arguments: '{"value":"x"}' },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          }
        : {
            id: 'second',
            object: 'chat.completion',
            created: 2,
            model: 'deepseek-v4-flash',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'done' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const model = textModelFromConfig({
      apiKey: 'test-key',
      baseURL: 'https://provider.example/v1',
      headers: {},
      modelName: 'deepseek-v4-flash',
      protocol: 'openai',
    }, { fetch: fakeFetch })

    await generateText({
      model,
      prompt: 'Use the lookup tool.',
      tools: {
        lookup: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => ({ value }),
        }),
      },
      stopWhen: stepCountIs(2),
    })

    const secondMessages = requests[1]?.messages as Record<string, unknown>[]
    const assistant = secondMessages.find(message => message.role === 'assistant')
    expect(assistant?.reasoning_content).toBe('private reasoning')
  })

  it('passes streamed reasoning_content back after a DeepSeek tool call', async () => {
    const requests: Record<string, unknown>[] = []
    const fakeFetch: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return requests.length === 1
        ? eventStream([
            {
              id: 'first', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash',
              choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'private reasoning' }, finish_reason: null }],
            },
            {
              id: 'first', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash',
              choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"value":"x"}' } }] }, finish_reason: null }],
            },
            {
              id: 'first', object: 'chat.completion.chunk', created: 1, model: 'deepseek-v4-flash',
              choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            },
          ])
        : eventStream([
            {
              id: 'second', object: 'chat.completion.chunk', created: 2, model: 'deepseek-v4-flash',
              choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: null }],
            },
            {
              id: 'second', object: 'chat.completion.chunk', created: 2, model: 'deepseek-v4-flash',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            },
          ])
    }
    const model = textModelFromConfig({
      apiKey: 'test-key',
      baseURL: 'https://provider.example/v1',
      headers: {},
      modelName: 'deepseek-v4-flash',
      protocol: 'openai',
    }, { fetch: fakeFetch })
    const result = streamText({
      model,
      prompt: 'Use the lookup tool.',
      tools: {
        lookup: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: async ({ value }) => ({ value }),
        }),
      },
      stopWhen: stepCountIs(2),
    })

    await result.text

    const secondMessages = requests[1]?.messages as Record<string, unknown>[]
    const assistant = secondMessages.find(message => message.role === 'assistant')
    expect(assistant?.reasoning_content).toBe('private reasoning')
  })
})
