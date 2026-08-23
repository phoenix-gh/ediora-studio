import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  apiGet: vi.fn(),
  workerHeaders: vi.fn(() => ({ 'X-Worker-Token': 'server-worker-token' })),
}))
const registry = vi.hoisted(() => ({
  getEnabledSkill: vi.fn(),
  listSkillReferences: vi.fn(),
  loadSkillPreloadContext: vi.fn(),
}))
const binding = vi.hoisted(() => ({ resolveSkillBinding: vi.fn() }))
const capabilities = vi.hoisted(() => ({ buildAgentCapabilitySnapshot: vi.fn() }))

vi.mock('./job-client', () => api)
vi.mock('../skills/registry', () => registry)
vi.mock('../skills/bindings', () => binding)
vi.mock('./agent-capabilities', () => capabilities)

import { resolvePipelineInvocations } from './pipeline-resolver'

describe('pipeline resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registry.getEnabledSkill.mockResolvedValue({
      name: 'article-drafting',
      description: 'draft',
      version: '1.0.0',
      digest: 'a'.repeat(64),
      source: 'builtin',
      instructions: 'private skill instructions',
      directory: '/private/skill',
      packageFiles: [],
      requestedAllowedTools: [],
    })
    registry.listSkillReferences.mockResolvedValue([])
    registry.loadSkillPreloadContext.mockResolvedValue({ references: [] })
    binding.resolveSkillBinding.mockReturnValue({
      skillName: 'article-drafting',
      displayName: '文章写作',
      parameter: { kind: 'writing_plan', required: true },
      primaryOutput: 'article',
      capabilityProfile: 'writing',
    })
    capabilities.buildAgentCapabilitySnapshot.mockReturnValue({
      schemaVersion: 1,
      mode: 'chat',
      skill: { name: 'article-drafting' },
      tools: [],
      policy: { approvalPolicy: 'interactive', allowedToolNames: [] },
    })
    api.apiGet.mockResolvedValue({
      id: 12,
      title: '真实写作方案',
      strategy: '从一手资料切入',
      description: '写给开发者',
      status: 'active',
      genre: '技术观点',
      tags: [{ name: 'AI' }],
      sources: [{ id: 3, title: '报告', url: 'https://example.com', content: 'source body' }],
    })
  })

  it('resolves the authoritative Skill and parameter snapshot while ignoring client labels', async () => {
    const [resolved] = await resolvePipelineInvocations([{
      invocationId: 'one',
      skillName: 'article-drafting',
      skillDisplayName: '客户端伪造名称',
      parameterKind: 'writing_plan',
      parameterId: '12',
      parameterDisplayName: '客户端伪造方案',
    }])

    expect(resolved).toMatchObject({
      invocation_id: 'one',
      skill_name: 'article-drafting',
      skill_display_name: '文章写作',
      parameter_kind: 'writing_plan',
      parameter_id: '12',
      parameter_display_name: '真实写作方案',
      skill_snapshot: {
        name: 'article-drafting',
        version: '1.0.0',
        digest: 'a'.repeat(64),
        instructions: 'private skill instructions',
      },
      parameter_snapshot: {
        id: 12,
        title: '真实写作方案',
        strategy: '从一手资料切入',
        sources: [{ id: 3, title: '报告', content: 'source body' }],
      },
    })
    expect(resolved.capability_snapshot).toEqual(expect.objectContaining({ schemaVersion: 1 }))
    expect(api.apiGet).toHaveBeenCalledWith('/writing-plans/12', { 'X-Worker-Token': 'server-worker-token' })
  })

  it('fails atomically when a required parameter is missing', async () => {
    await expect(resolvePipelineInvocations([{
      invocationId: 'one',
      skillName: 'article-drafting',
      skillDisplayName: '文章写作',
    }])).rejects.toThrow('需要选择写作方案')
    expect(api.apiGet).not.toHaveBeenCalled()
  })
})
