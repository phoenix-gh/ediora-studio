import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  workerHeaders: vi.fn(() => ({ 'X-Worker-Token': 'server-worker-token' })),
}))

vi.mock('@/lib/ai/job-client', () => api)

import { GET } from './route'

describe('pipeline parameter options route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.workerHeaders.mockReturnValue({ 'X-Worker-Token': 'server-worker-token' })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('returns active writing plans without exposing server-only fields', async () => {
    api.apiGet.mockResolvedValueOnce([
      {
        id: 9,
        title: 'AI 产品观察',
        strategy: '从真实用户反馈切入',
        description: '写给产品经理',
        status: 'active',
        genre: '观点',
        tags: [{ id: 1, name: 'AI', color: '#6366f1' }],
        sources: [{ id: 3, title: '一手报告', url: 'https://example.com', content: 'source body' }],
      },
      { id: 10, title: '已停用', strategy: '', description: '', status: 'archived' },
    ])

    const response = await GET(new Request('http://localhost/api/chat/pipeline-options?kind=writing_plan&query=AI'))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      options: [{
        id: '9',
        displayName: 'AI 产品观察',
        kind: 'writing_plan',
        summary: '从真实用户反馈切入',
        metadata: {
          genre: '观点',
          tags: ['AI'],
          sourceCount: 1,
        },
      }],
    })
    expect(JSON.stringify(body)).not.toContain('source body')
    expect(api.apiGet).toHaveBeenCalledWith('/writing-plans', { headers: { 'X-Worker-Token': 'server-worker-token' } })
  })

  it('sanitizes publish account options before returning them to the browser', async () => {
    api.apiGet.mockResolvedValueOnce([{
      id: 'wechat-main',
      name: 'Ediora 公众号',
      platform: 'wechat',
      positioning: 'AI 产品实践',
      audience: '开发者',
      tone: '克制、具体',
      is_active: true,
      app_id: 'private-app-id',
      app_secret: 'private-app-secret',
      voice_samples: ['样例'],
      style_rules: ['先给结论'],
    }, {
      id: 'disabled', name: '停用账号', platform: 'x', is_active: false,
    }])

    const response = await GET(new Request('http://localhost/api/chat/pipeline-options?kind=publish_account'))
    const body = await response.json()

    expect(body.options).toEqual([{
      id: 'wechat-main',
      displayName: 'Ediora 公众号',
      kind: 'publish_account',
      summary: 'wechat · AI 产品实践',
      metadata: {
        platform: 'wechat',
        positioning: 'AI 产品实践',
        audience: '开发者',
        tone: '克制、具体',
      },
    }])
    expect(JSON.stringify(body)).not.toContain('private-app')
  })
})
