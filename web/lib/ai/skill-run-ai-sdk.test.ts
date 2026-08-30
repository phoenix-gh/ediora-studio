import { describe, expect, it, vi } from 'vitest'

import type { RegisteredSkill, SkillReference } from '../skills/registry'
import { executeSkillRunWithAiSdk, selectSkillForTurn, skillRunUIResponse } from './skill-run-ai-sdk'

const alpha: RegisteredSkill = {
  name: 'Alpha', description: 'Handles alpha tasks', version: '1.0.0', source: 'uploaded', enabled: true,
  digest: 'a'.repeat(64), reviewState: 'approved', standardCompatible: true, diagnostics: [],
  instructions: '# Procedure\nRead applicable rules and complete the task.\n# Verification\nCheck the output.',
  content: '# Procedure\nRead applicable rules and complete the task.\n# Verification\nCheck the output.',
  directory: '/skills/alpha', packageFiles: [], requestedAllowedTools: [],
}
const beta = { ...alpha, name: 'Beta', description: 'Handles beta tasks' }
const references: SkillReference[] = [{ path: 'references/rules.md', bytes: 5 }]

const plan = {
  goal: '完成任务',
  steps: [{ id: 'deliver', instruction: '交付结果', requiredReferences: ['references/rules.md'], requiredTools: ['search_assets'] }],
  outputRequirements: ['只使用证据'],
  verificationCriteria: ['逐项核对'],
}

describe('generic SkillRun AI SDK adapter', () => {
  it('selects only an exact enabled Skill and can decline or continue a restored Skill', async () => {
    await expect(selectSkillForTurn({
      enabledSkills: [alpha, beta], userRequest: 'alpha task',
      decide: async () => ({ skillName: 'Alpha' }),
    })).resolves.toEqual({ skillName: 'Alpha', activation: 'automatic' })

    await expect(selectSkillForTurn({
      enabledSkills: [alpha, beta], userRequest: 'follow up', restoredSkillName: 'Alpha',
      decide: async () => ({ skillName: 'Alpha', continueRestored: true }),
    })).resolves.toEqual({ skillName: 'Alpha', activation: 'restored' })

    await expect(selectSkillForTurn({
      enabledSkills: [alpha], userRequest: 'unrelated', restoredSkillName: 'Alpha',
      decide: async () => ({}),
    })).resolves.toBeUndefined()

    await expect(selectSkillForTurn({
      enabledSkills: [alpha], userRequest: 'plain question',
      decide: async () => ({ skillName: null }),
    })).resolves.toBeUndefined()

    await expect(selectSkillForTurn({
      enabledSkills: [alpha], userRequest: 'plain question',
      decide: async () => ({ skillName: '' }),
    })).resolves.toBeUndefined()
  })

  it('keeps ordinary stored-source lookup in normal Chat instead of a research Skill run', async () => {
    const sourceResearch = {
      ...alpha,
      name: 'source-research',
      description: '检索、核验并整理与用户主题直接相关的可追溯资料，供后续写作阶段使用。',
    }

    await expect(selectSkillForTurn({
      enabledSkills: [sourceResearch],
      userRequest: '帮我从 X 的信息源的 Github 订阅源中获取一个今天可以写的题材',
      decide: async ({ prompt }) => ({
        skillName: prompt.toLowerCase().includes('ordinary stored-data lookup')
          ? null
          : 'source-research',
        continueRestored: false,
      }),
    })).resolves.toBeUndefined()
  })

  it('rejects selector output that is not in the enabled catalog', async () => {
    await expect(selectSkillForTurn({
      enabledSkills: [alpha], userRequest: 'task',
      decide: async () => ({ skillName: 'Forged', continueRestored: false }),
    })).rejects.toThrow('Invalid Skill selection')
  })

  it('accepts a loadSkill tool envelope returned by the selector model', async () => {
    await expect(selectSkillForTurn({
      enabledSkills: [alpha],
      userRequest: 'alpha task',
      decide: async () => ({ tool: 'loadSkill', arguments: { name: 'Alpha' } }),
    })).resolves.toEqual({ skillName: 'Alpha', activation: 'automatic' })
  })

  it('accepts a JSON string returned by a text-only selector', async () => {
    await expect(selectSkillForTurn({
      enabledSkills: [alpha],
      userRequest: 'alpha task',
      decide: async () => '{"skillName":"Alpha","continueRestored":false}',
    })).resolves.toEqual({ skillName: 'Alpha', activation: 'automatic' })
  })

  it('repairs one malformed selector response before failing', async () => {
    const decide = vi.fn()
      .mockResolvedValueOnce({ tool: 'unknown', arguments: { name: 'Alpha' } })
      .mockResolvedValueOnce({ skillName: 'Alpha', continueRestored: false })

    await expect(selectSkillForTurn({
      enabledSkills: [alpha], userRequest: 'alpha task', decide,
    })).resolves.toEqual({ skillName: 'Alpha', activation: 'automatic' })
    expect(decide).toHaveBeenCalledTimes(2)
    expect(decide.mock.calls[1][0].prompt).toContain('Repair')
  })

  it('runs plan, progressive load, execution, and validation without forcing tool choice', async () => {
    const calls: string[] = []
    let planningPrompt = ''
    let executionPrompt = ''
    const execute = vi.fn(async (input: Record<string, unknown>) => {
      calls.push('execute')
      executionPrompt = String(input.prompt)
      expect(input).not.toHaveProperty('toolChoice')
      return {
        text: 'grounded draft',
        parts: [{ type: 'dynamic-tool', toolName: 'search_assets', state: 'output-available', toolCallId: 'call-1', output: {} }],
      }
    })

    const result = await executeSkillRunWithAiSdk({
      skill: alpha,
      activation: 'automatic',
      userRequest: '完成任务',
      conversationContext: '<previous_assistant_deliverable>这是上一轮交付物。</previous_assistant_deliverable>',
      selectedContext: '',
      references,
      tools: [{ name: 'search_assets', description: 'Search assets' }],
      plan: async ({ prompt }) => { calls.push('plan'); planningPrompt = prompt; return plan },
      readReferences: async paths => { calls.push('references'); return paths.map(path => ({ path, content: 'rules', bytes: 5 })) },
      execute,
      validate: async () => { calls.push('validate'); return { passed: true, violations: [] } },
      revise: vi.fn(),
    })

    expect(calls).toEqual(['plan', 'references', 'execute', 'validate'])
    expect(result).toMatchObject({ kind: 'completed', completed: { delivery: 'ready', text: 'grounded draft' } })
    expect(planningPrompt).toContain('这是上一轮交付物。')
    expect(executionPrompt).toContain('deliver: 交付结果')
    expect(executionPrompt).toContain('这是上一轮交付物。')
    expect(executionPrompt).toContain('required tools: search_assets')
  })

  it('performs one revision and a second validation', async () => {
    const validate = vi.fn()
      .mockResolvedValueOnce({ passed: false, violations: [{ requirement: '自然表达', evidence: '模板化', correction: '重写' }] })
      .mockResolvedValueOnce({ passed: true, violations: [] })

    const result = await executeSkillRunWithAiSdk({
      skill: alpha, activation: 'manual', userRequest: '完成任务', references, selectedContext: '',
      tools: [{ name: 'search_assets', description: 'Search assets' }],
      plan: async () => plan,
      readReferences: async paths => paths.map(path => ({ path, content: 'rules', bytes: 5 })),
      execute: async () => ({
        text: 'first draft',
        parts: [{ type: 'dynamic-tool', toolName: 'search_assets', state: 'output-available', toolCallId: 'call-1', output: {} }],
      }),
      validate,
      revise: async () => 'revised draft',
    })

    expect(result).toMatchObject({ kind: 'completed', completed: { text: 'revised draft', revisionCount: 1 } })
    expect(validate).toHaveBeenCalledTimes(2)
  })

  it('retries execution once when required tool evidence is missing', async () => {
    const prompts: string[] = []
    let attempts = 0
    const execute = vi.fn(async (input: Record<string, unknown>) => {
      prompts.push(String(input.prompt))
      attempts += 1
      if (attempts === 1) return { text: '', parts: [] }
      return {
        text: 'grounded after retry',
        parts: [{ type: 'dynamic-tool', toolName: 'search_assets', state: 'output-available', toolCallId: 'retry-call', output: {} }],
      }
    })

    const result = await executeSkillRunWithAiSdk({
      skill: alpha,
      activation: 'automatic',
      userRequest: '完成任务',
      selectedContext: '',
      references,
      tools: [{ name: 'search_assets', description: 'Search assets' }],
      plan: async () => plan,
      readReferences: async paths => paths.map(path => ({ path, content: 'rules', bytes: 5 })),
      execute,
      validate: async () => ({ passed: true, violations: [] }),
      revise: vi.fn(),
    })

    expect(execute).toHaveBeenCalledTimes(2)
    expect(prompts[1]).toContain('Missing required plan steps')
    expect(result).toMatchObject({ kind: 'completed', completed: { delivery: 'ready', text: 'grounded after retry' } })
  })

  it('includes accumulated tool evidence when retrying missing plan steps', async () => {
    const prompts: string[] = []
    let attempts = 0
    const currentItemId = '2092621092644848065'
    const result = await executeSkillRunWithAiSdk({
      skill: alpha,
      activation: 'automatic',
      userRequest: '从系统信息源检索并读取 GitHub 帖子',
      selectedContext: '',
      references: [],
      tools: [
        { name: 'search_source_items', description: 'Search stored source items' },
        { name: 'get_source_item', description: 'Read one stored source item' },
      ],
      plan: async () => ({
        goal: '检索并读取当前条目',
        steps: [
          { id: 'search', instruction: '检索', requiredReferences: [], requiredTools: ['search_source_items'] },
          { id: 'read', instruction: '读取检索结果', requiredReferences: [], requiredTools: ['get_source_item'] },
        ],
        outputRequirements: ['使用当前检索结果'],
        verificationCriteria: ['读取完整条目'],
      }),
      readReferences: async () => [],
      execute: async ({ prompt }) => {
        prompts.push(prompt)
        attempts += 1
        if (attempts === 1) {
          return {
            text: '',
            parts: [{
              type: 'dynamic-tool', toolName: 'search_source_items',
              state: 'output-available', toolCallId: 'search-call',
              output: [{ source_type: 'x', id: currentItemId }],
            }],
            toolResults: [{
              toolName: 'search_source_items', toolCallId: 'search-call',
              output: [{ source_type: 'x', id: currentItemId }],
            }],
          }
        }
        expect(prompt).toContain(currentItemId)
        return {
          text: '已读取当前条目',
          parts: [{
            type: 'dynamic-tool', toolName: 'get_source_item',
            state: 'output-available', toolCallId: 'read-call',
            output: { source_type: 'x', id: currentItemId, content: '完整正文' },
          }],
        }
      },
      validate: async () => ({ passed: true, violations: [] }),
      revise: vi.fn(),
    })

    expect(prompts).toHaveLength(2)
    expect(result).toMatchObject({
      kind: 'completed', completed: { text: '已读取当前条目' },
    })
  })

  it('safely bounds non-serializable tool evidence in retry prompts', async () => {
    const currentItemId = '2092621092644848065'
    const output: Record<string, unknown> = {
      source_type: 'x',
      id: currentItemId,
      content: 'x'.repeat(200_000),
      sequence: 1n,
    }
    output.self = output
    let attempts = 0
    const result = await executeSkillRunWithAiSdk({
      skill: alpha,
      activation: 'automatic',
      userRequest: '检索后读取条目',
      selectedContext: '',
      references: [],
      tools: [
        { name: 'search_source_items', description: 'Search stored source items' },
        { name: 'get_source_item', description: 'Read one stored source item' },
      ],
      plan: async () => ({
        goal: '检索后读取条目',
        steps: [
          { id: 'search', instruction: '检索', requiredReferences: [], requiredTools: ['search_source_items'] },
          { id: 'read', instruction: '读取', requiredReferences: [], requiredTools: ['get_source_item'] },
        ],
        outputRequirements: [], verificationCriteria: [],
      }),
      readReferences: async () => [],
      execute: async ({ prompt }) => {
        attempts += 1
        if (attempts === 1) {
          return {
            text: '',
            parts: [{
              type: 'dynamic-tool', toolName: 'search_source_items',
              state: 'output-available', toolCallId: 'search-call', output,
            }],
            toolResults: [{ toolName: 'search_source_items', toolCallId: 'search-call', output }],
          }
        }
        expect(prompt).toContain('search_source_items')
        expect(prompt).toContain(currentItemId)
        expect(prompt).toContain('[Circular]')
        expect(new TextEncoder().encode(prompt).byteLength).toBeLessThan(80 * 1024)
        return {
          text: '完成',
          parts: [{
            type: 'dynamic-tool', toolName: 'get_source_item',
            state: 'output-available', toolCallId: 'read-call', output: { id: currentItemId },
          }],
        }
      },
      validate: async () => ({ passed: true, violations: [] }),
      revise: vi.fn(),
    })

    expect(result).toMatchObject({ kind: 'completed', completed: { text: '完成' } })
  })

  it('finalizes a tool-only execution before validating the Skill result', async () => {
    let finalizationPrompt = ''
    const validate = vi.fn(async ({ text }: { text: string }) => {
      expect(text).toBe('final deliverable')
      return { passed: true, violations: [] }
    })

    const result = await executeSkillRunWithAiSdk({
      skill: alpha,
      activation: 'automatic',
      userRequest: '完成任务',
      selectedContext: '',
      references,
      tools: [{ name: 'search_assets', description: 'Search assets' }],
      plan: async () => plan,
      readReferences: async paths => paths.map(path => ({ path, content: 'rules', bytes: 5 })),
      execute: async () => ({
        text: '',
        parts: [{
          type: 'dynamic-tool', toolName: 'search_assets', state: 'output-available',
          toolCallId: 'call-1', output: { id: 11, title: 'evidence' },
        }],
        toolResults: [{ toolName: 'search_assets', output: { id: 11, title: 'evidence' } }],
      }),
      finalize: async ({ prompt }) => {
        finalizationPrompt = prompt
        return 'final deliverable'
      },
      validate,
      revise: vi.fn(),
    })

    expect(result).toMatchObject({
      kind: 'completed',
      completed: { delivery: 'ready', text: 'final deliverable' },
    })
    expect(finalizationPrompt).toContain('Produce the final deliverable now')
    expect(finalizationPrompt).toContain('evidence')
    expect(validate).toHaveBeenCalledOnce()
  })

  it('reports a runtime incompletion when finalization still returns no answer', async () => {
    const validate = vi.fn()

    await expect(executeSkillRunWithAiSdk({
      skill: alpha,
      activation: 'automatic',
      userRequest: '完成任务',
      selectedContext: '',
      references,
      tools: [{ name: 'search_assets', description: 'Search assets' }],
      plan: async () => plan,
      readReferences: async paths => paths.map(path => ({ path, content: 'rules', bytes: 5 })),
      execute: async () => ({
        text: '',
        parts: [{
          type: 'dynamic-tool', toolName: 'search_assets', state: 'output-available',
          toolCallId: 'call-1', output: { id: 11 },
        }],
      }),
      finalize: async () => '   ',
      validate,
      revise: vi.fn(),
    })).rejects.toMatchObject({ code: 'final_answer_missing' })
    expect(validate).not.toHaveBeenCalled()
  })

  it('returns a pending approval before validation and revision', async () => {
    const validate = vi.fn()
    const revise = vi.fn()
    const approvalPart = { type: 'dynamic-tool', toolName: 'search_assets', state: 'approval-requested', toolCallId: 'call-1' }

    const result = await executeSkillRunWithAiSdk({
      skill: alpha, activation: 'automatic', userRequest: '完成任务', references, selectedContext: '',
      tools: [{ name: 'search_assets', description: 'Search assets' }],
      plan: async () => plan,
      readReferences: async paths => paths.map(path => ({ path, content: 'rules', bytes: 5 })),
      execute: async () => ({ text: '', parts: [approvalPart] }),
      validate,
      revise,
    })

    expect(result).toMatchObject({ kind: 'approval', parts: [approvalPart] })
    expect(validate).not.toHaveBeenCalled()
    expect(revise).not.toHaveBeenCalled()
  })

  it('streams only the accepted final result and never exposes a rejected draft', async () => {
    const result = await executeSkillRunWithAiSdk({
      skill: alpha, activation: 'manual', userRequest: '完成任务', references, selectedContext: '',
      tools: [{ name: 'search_assets', description: 'Search assets' }],
      plan: async () => plan,
      readReferences: async paths => paths.map(path => ({ path, content: 'rules', bytes: 5 })),
      execute: async () => ({
        text: 'rejected draft',
        parts: [{ type: 'dynamic-tool', toolName: 'search_assets', state: 'output-available', toolCallId: 'call-1', output: {} }],
      }),
      validate: vi.fn()
        .mockResolvedValueOnce({ passed: false, violations: [{ requirement: '准确', evidence: '错误', correction: '修正' }] })
        .mockResolvedValueOnce({ passed: true, violations: [] }),
      revise: async () => 'accepted revision',
    })

    const body = await skillRunUIResponse(result).text()
    expect(body).toContain('accepted revision')
    expect(body).not.toContain('rejected draft')
  })
})
