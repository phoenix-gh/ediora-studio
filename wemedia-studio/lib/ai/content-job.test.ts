import { describe, expect, it } from 'vitest'

import { textModelForProvider, toolsForContentStep } from './content-job'

describe('content job tool allowlist', () => {
  it('limits draft orchestration to declared tools', () => {
    expect(toolsForContentStep('draft')).toEqual([
      'getBrief',
      'loadWritingContext',
      'saveDraft',
    ])
  })
})

describe('compatible OpenAI providers', () => {
  it('uses Chat Completions models for text generation', () => {
    const provider = { chat: (modelName: string) => ({ endpoint: 'chat', modelName }) }

    expect(textModelForProvider(provider, 'deepseek-v4-flash')).toEqual({
      endpoint: 'chat',
      modelName: 'deepseek-v4-flash',
    })
  })
})
