import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  apiBase: vi.fn(() => 'http://api:8000/api'),
  workerHeaders: vi.fn(() => ({ 'X-Worker-Token': 'server-worker-token' })),
}))
const resolver = vi.hoisted(() => ({
  resolvePipelineInvocations: vi.fn(),
}))

vi.mock('@/lib/ai/job-client', () => api)
vi.mock('@/lib/ai/pipeline-resolver', () => resolver)

import { POST } from './route'

describe('Chat pipeline creation BFF route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.workerHeaders.mockReturnValue({ 'X-Worker-Token': 'server-worker-token' })
    resolver.resolvePipelineInvocations.mockResolvedValue([
      { invocation_id: 'one', skill_name: 'article-drafting', skill_display_name: '文章写作', skill_snapshot: { name: 'article-drafting' } },
      { invocation_id: 'two', skill_name: 'article-drafting', skill_display_name: '文章写作', skill_snapshot: { name: 'article-drafting' } },
    ])
  })

  it('resolves and forwards ordered duplicate invocations through the trusted server boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job: { id: 81 } }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(
      new Request('http://localhost/api/chat/sessions/7/pipelines', {
        method: 'POST',
        body: JSON.stringify({
          clientMessageId: 'message-1',
          objective: '写一篇关于 Agent Skill 的文章',
          title: 'Agent Skill 文章',
          invocations: [
            { invocationId: 'one', skillName: 'article-drafting', skillDisplayName: '错误显示名' },
            { invocationId: 'two', skillName: 'article-drafting', skillDisplayName: '错误显示名' },
          ],
        }),
      }),
      { params: Promise.resolve({ sessionId: '7' }) },
    )

    expect(response.status).toBe(201)
    expect(resolver.resolvePipelineInvocations).toHaveBeenCalledWith([
      { invocationId: 'one', skillName: 'article-drafting', skillDisplayName: '错误显示名' },
      { invocationId: 'two', skillName: 'article-drafting', skillDisplayName: '错误显示名' },
    ])
    expect(fetchMock).toHaveBeenCalledWith('http://api:8000/api/chat/sessions/7/pipelines', expect.objectContaining({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Token': 'server-worker-token',
      },
      body: JSON.stringify({
        client_message_id: 'message-1',
        objective: '写一篇关于 Agent Skill 的文章',
        title: 'Agent Skill 文章',
        invocations: [
          { invocation_id: 'one', skill_name: 'article-drafting', skill_display_name: '文章写作', skill_snapshot: { name: 'article-drafting' } },
          { invocation_id: 'two', skill_name: 'article-drafting', skill_display_name: '文章写作', skill_snapshot: { name: 'article-drafting' } },
        ],
      }),
    }))
  })

  it('returns a validation error without calling FastAPI when the body is malformed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await POST(
      new Request('http://localhost/api/chat/sessions/7/pipelines', {
        method: 'POST',
        body: JSON.stringify({ objective: '', invocations: [] }),
      }),
      { params: Promise.resolve({ sessionId: '7' }) },
    )

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(resolver.resolvePipelineInvocations).not.toHaveBeenCalled()
  })
})
