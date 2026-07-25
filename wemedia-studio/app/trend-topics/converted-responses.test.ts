import { expect, it } from 'vitest'

import { mergeConvertedResponses } from './converted-responses'


it('places converted responses first and deduplicates topics by original URL', () => {
  const converted = [{
    id: 1,
    summary_cn: 'OpenAI 发布新 API',
    reason: '适合做快速解读',
    username: 'OpenAI',
    post_content: 'New API',
    post_url: 'https://x.com/OpenAI/status/1',
  }]
  const cached = [{
    title: '旧选题',
    angle: '旧角度',
    type: 'share' as const,
    source_posts: [{
      username: '@OpenAI',
      content: 'New API',
      url: 'https://x.com/OpenAI/status/1',
    }],
  }]

  const merged = mergeConvertedResponses(converted, cached)

  expect(merged).toHaveLength(1)
  expect(merged[0].title).toBe('OpenAI 发布新 API')
  expect(merged[0].type).toBe('share')
})
