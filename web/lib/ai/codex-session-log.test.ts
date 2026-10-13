import { describe, expect, it } from 'vitest'

import { codexSessionEvents, createCodexSessionRecorder } from './codex-session-log'

const context = { turn: 1, step: 1 }

describe('codex session log', () => {
  it('keeps assistant text and reasoning and drops token deltas', () => {
    expect(codexSessionEvents({ method: 'item/reasoning/textDelta', params: { delta: 'a' } }, context)).toEqual([])
    expect(codexSessionEvents({
      method: 'item/completed',
      params: { item: { type: 'AgentMessage', content: [{ type: 'Text', text: '图没生成' }] } },
    }, context)[0]).toMatchObject({
      type: 'assistant/message',
      data: { blocks: [{ kind: 'text', text: '图没生成' }] },
    })
    expect(codexSessionEvents({
      method: 'item/completed',
      params: { item: { type: 'Reasoning', raw_content: ['先查提示词'] } },
    }, context)[0]).toMatchObject({
      type: 'assistant/message',
      data: { blocks: [{ kind: 'reasoning', text: '先查提示词' }] },
    })
  })

  it('records a failed image tool with its approval error', () => {
    const events = codexSessionEvents({
      method: 'item/completed',
      params: {
        item: {
          type: 'McpToolCall',
          id: 'call-1',
          server: 'ediora',
          tool: 'generateImage',
          arguments: { prompt: 'red apple' },
          status: 'failed',
          error: { message: 'approval policy is never' },
        },
      },
    }, context)
    expect(events.map(event => event.type)).toEqual(['tool/call', 'tool/result'])
    expect(events[0].data).toMatchObject({ name: 'ediora/generateImage', callId: 'call-1' })
    expect(events[1].data).toMatchObject({ isError: true, error: 'approval policy is never' })
  })

  it('uses the shell command as the visible name and clips long output', () => {
    const events = codexSessionEvents({
      method: 'item/completed',
      params: {
        item: {
          type: 'CommandExecution',
          id: 'call-2',
          command: ['/usr/bin/zsh', '-lc', 'cat SKILL.md'],
          aggregated_output: 'x'.repeat(5_000),
          exit_code: 0,
          status: 'completed',
        },
      },
    }, context)
    expect(events[0].data.name).toBe('cat SKILL.md')
    expect(String(events[1].data.output)).toContain('…')
    expect(String(events[1].data.output).length).toBeLessThan(5_000)
  })

  it('keeps the app-server assistant text, image result, and command output', () => {
    expect(codexSessionEvents({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'm1', text: '先查素材', phase: 'commentary' } },
    }, context)[0]).toMatchObject({
      type: 'assistant/message',
      data: { blocks: [{ kind: 'text', text: '先查素材' }] },
    })

    const image = codexSessionEvents({
      method: 'item/completed',
      params: {
        item: {
          type: 'imageGeneration',
          id: 'img-1',
          status: 'completed',
          revisedPrompt: '街拍',
          savedPath: '/tmp/a.png',
          result: 'a'.repeat(5_000),
        },
      },
    }, context)
    expect(image[0].data).toMatchObject({
      name: 'imagegen',
      arguments: { revisedPrompt: '街拍', savedPath: '/tmp/a.png' },
    })
    expect(JSON.stringify(image)).not.toContain('aaaa')

    const command = codexSessionEvents({
      method: 'item/completed',
      params: {
        item: {
          type: 'commandExecution',
          id: 'call-3',
          command: 'ls',
          aggregatedOutput: 'SKILL.md',
          exitCode: 0,
        },
      },
    }, context)
    expect(command[1].data.output).toBe('SKILL.md')
  })

  it('folds streamed reasoning and command output into one record', () => {
    const record = createCodexSessionRecorder()
    expect(record({ method: 'item/reasoning/textDelta', params: { itemId: 'r1', delta: '先看' } }, context)).toEqual([])
    expect(record({ method: 'item/reasoning/textDelta', params: { itemId: 'r1', delta: '目录' } }, context)).toEqual([])
    expect(record({
      method: 'item/completed',
      params: { item: { type: 'reasoning', id: 'r1', summary: [] } },
    }, context)[0].data.blocks).toEqual([{ kind: 'reasoning', text: '先看目录' }])

    expect(record({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'c1', delta: 'hello' },
    }, context)).toEqual([])
    const command = record({
      method: 'item/completed',
      params: { item: { type: 'commandExecution', id: 'c1', command: 'echo', aggregatedOutput: '' } },
    }, context)
    expect(command[1].data.output).toBe('hello')
  })
})
