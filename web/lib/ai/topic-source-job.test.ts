import { describe, expect, it } from 'vitest'
import type { generateText } from 'ai'

import {
  buildTopicSourceInstructions,
  generateTopicSourceText,
  parseTopicSourceEvaluation,
  parseTopicSourceClassification,
  parseTopicSourceDecision,
} from './topic-source-job'
import type { AgentModelMessageEvent } from './agent-runtime-types'

describe('topic source AI decision contract', () => {
  it('includes a supplemental screening requirement without replacing the output contract', () => {
    const instructions = buildTopicSourceInstructions('只接受有具体案例和可执行方法的内容。')

    expect(instructions).toContain('只接受有具体案例和可执行方法的内容。')
    expect(instructions).toContain('用户配置的筛选要求')
    expect(instructions.lastIndexOf('accepted_tweet_ids')).toBeGreaterThan(
      instructions.indexOf('只接受有具体案例和可执行方法的内容。'),
    )
  })

  it('keeps the baseline screening behavior when no supplemental requirement is configured', () => {
    const instructions = buildTopicSourceInstructions('')

    expect(instructions).toContain('判断每条 X 原始内容是否真正适合主题目录')
    expect(instructions).toContain('宁缺毋滥')
    expect(instructions).toContain('accepted_tweet_ids')
  })

  it('keeps only tweet IDs supplied in the JSON decision', () => {
    expect(parseTopicSourceDecision('```json\n{"accepted_tweet_ids":["a","b"]}\n```')).toEqual({
      accepted_tweet_ids: ['a', 'b'],
    })
  })

  it('rejects malformed decision data', () => {
    expect(() => parseTopicSourceDecision('{"accepted_tweet_ids":"a"}')).toThrow()
  })

  it('describes every candidate folder and requires one final folder or null', () => {
    const instructions = buildTopicSourceInstructions([
      { id: 11, name: 'AI 工具', keywords: ['AI'], prompt: '只接受工具实操。' },
      { id: 12, name: '副业搞钱', keywords: ['副业'], prompt: '只接受副业方法。' },
    ])

    expect(instructions).toContain('AI 工具')
    expect(instructions).toContain('只接受工具实操。')
    expect(instructions).toContain('只能选择一个目录或 null')
    expect(instructions).toContain('directory_id')
    expect(instructions).toContain('prompt_assets')
    expect(instructions).toContain('media_indexes')
  })

  it('parses one-folder classifications and rejects duplicate or invalid directory values', () => {
    expect(parseTopicSourceClassification(
      '```json\n{"classifications":[{"tweet_id":"a","directory_id":11},{"tweet_id":"b","directory_id":null}]}\n```',
    )).toEqual({
      classifications: [
        { tweet_id: 'a', directory_id: 11 },
        { tweet_id: 'b', directory_id: null },
      ],
    })
    expect(() => parseTopicSourceClassification(
      '{"classifications":[{"tweet_id":"a","directory_id":11},{"tweet_id":"a","directory_id":12}]}',
    )).toThrow()
    expect(() => parseTopicSourceClassification(
      '{"classifications":[{"tweet_id":"a","directory_id":"11"}]}',
    )).toThrow()
  })

  it('requires prompt text and validates one prompt folder plus attached media indexes', () => {
    const parsed = parseTopicSourceEvaluation(JSON.stringify({
      classifications: [{ tweet_id: 'a', directory_id: null }],
      prompt_assets: [{
        tweet_id: 'a',
        directory_id: 21,
        prompt_kind: 'image',
        title: '海报提示词',
        content: '电影感未来城市海报',
        media_indexes: [0],
      }],
    }))

    expect(parsed.prompt_assets[0].content).toBe('电影感未来城市海报')
    expect(() => parseTopicSourceEvaluation(JSON.stringify({
      classifications: [],
      prompt_assets: [{
        tweet_id: 'a', directory_id: 21, prompt_kind: 'image', content: ' ', media_indexes: [],
      }],
    }))).toThrow()
  })

  it('persists the model request and response around topic source evaluation', async () => {
    const events: AgentModelMessageEvent[] = []
    const result = await generateTopicSourceText({
      model: {} as Parameters<typeof generateText>[0]['model'],
      instructions: '只判断是否入库。',
      prompt: '{"posts":[{"tweet_id":"a"}]}',
    }, {
      generate: async () => ({
        text: '{"accepted_tweet_ids":["a"]}',
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 2 },
      } as Awaited<ReturnType<typeof generateText>>),
      onMessage: event => { events.push(event) },
    })

    expect(result.text).toContain('accepted_tweet_ids')
    expect(events.map(event => [event.phase, event.direction])).toEqual([
      ['select', 'model_request'],
      ['select', 'model_response'],
    ])
    expect(events[0].callId).toEqual(expect.any(String))
    expect(events[0].callId).toBe(events[1].callId)
    expect(events[0].payload).toMatchObject({
      instructions: '只判断是否入库。',
      prompt: '{"posts":[{"tweet_id":"a"}]}',
    })
    expect(events[1].payload).toMatchObject({
      text: '{"accepted_tweet_ids":["a"]}',
      finishReason: 'stop',
    })
  })
})
