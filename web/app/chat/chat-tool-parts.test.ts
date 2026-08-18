import { describe, expect, it } from 'vitest'

import {
  chatToolStatus,
  generatedImageUrls,
  imageGenerationSummary,
  isChatToolPart,
  legacyImageJobId,
} from './chat-tool-parts'

describe('isChatToolPart', () => {
  it('recognizes persisted AI SDK dynamic tool calls', () => {
    expect(isChatToolPart({ type: 'dynamic-tool' })).toBe(true)
  })

  it.each(['tool-event', 'tool-result', 'tool-fetch_url'])(
    'preserves support for %s',
    type => expect(isChatToolPart({ type })).toBe(true),
  )

  it.each(['text', 'step-start'])(
    'does not classify %s as tool activity',
    type => expect(isChatToolPart({ type })).toBe(false),
  )
})

describe('generatedImageUrls', () => {
  it('reads the saved asset from a direct generateImage result', () => {
    expect(generatedImageUrls({
      type: 'dynamic-tool',
      toolName: 'generateImage',
      output: {
        asset_id: 12,
        asset_url: '/api/uploads/chat.png',
        title: 'Chat 生图',
      },
    })).toEqual(['http://localhost:8000/api/uploads/chat.png'])
  })

  it('ignores non-image tools and empty outputs', () => {
    expect(generatedImageUrls({ type: 'dynamic-tool', toolName: 'search_web', output: { asset_url: '/api/uploads/x.png' } })).toEqual([])
    expect(generatedImageUrls({ type: 'dynamic-tool', toolName: 'generateImage' })).toEqual([])
  })
})

describe('legacyImageJobId', () => {
  it('keeps older job-based generateImage previews working', () => {
    expect(legacyImageJobId({ type: 'dynamic-tool', toolName: 'generateImage', output: { jobId: 44 } })).toBe(44)
    expect(legacyImageJobId({ type: 'dynamic-tool', toolName: 'generateImage', output: { asset_url: '/api/uploads/chat.png' } })).toBeNull()
  })
})

describe('imageGenerationSummary', () => {
  it('counts successful images and failed attempts separately', () => {
    expect(imageGenerationSummary([
      {
        type: 'dynamic-tool',
        toolName: 'generateImage',
        state: 'output-error',
        output: { errorText: '多媒体目录不存在' },
      },
      {
        type: 'dynamic-tool',
        toolName: 'generateImage',
        state: 'output-available',
        output: { asset_url: '/api/uploads/chat.png' },
      },
    ])).toBe('已生成 1 张图片（失败 1 次）')
  })

  it('reports image failure when no image was saved', () => {
    expect(imageGenerationSummary([
      { type: 'dynamic-tool', toolName: 'generateImage', state: 'output-error' },
    ])).toBe('图片生成失败 1 次')
  })
})

describe('chatToolStatus', () => {
  it('renders output errors as failures instead of completed', () => {
    expect(chatToolStatus({ type: 'dynamic-tool', toolName: 'generateImage', state: 'output-error' })).toBe('失败')
    expect(chatToolStatus({ type: 'dynamic-tool', toolName: 'generateImage', state: 'output-available' })).toBe('已完成')
  })
})
