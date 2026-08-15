import { describe, expect, it } from 'vitest'

import { titleFromFirstMessage } from './chat-title'

describe('titleFromFirstMessage', () => {
  it('normalizes whitespace and truncates a first message', () => {
    expect(titleFromFirstMessage('  帮我   分析\n一下 AI 产品趋势  ')).toBe('帮我 分析 一下 AI 产品趋势')
    expect(titleFromFirstMessage('这是一个用于测试自动会话标题截断能力的超长首条消息内容并且还会继续追加更多文字')).toBe('这是一个用于测试自动会话标题截断能力的超长首条消息内容并且还…')
  })
})
