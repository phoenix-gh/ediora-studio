import { describe, expect, it, vi } from 'vitest'

import type { RegisteredSkill, SkillReference } from '../skills/registry'
import { executeSkillRunWithAiSdk, selectSkillForTurn, skillRunUIResponse } from './skill-run-ai-sdk'

const alpha: RegisteredSkill = {
  name: 'Alpha', description: 'Handles alpha tasks', version: '1.0.0', source: 'uploaded', enabled: true,
  instructions: '# Procedure\nRead applicable rules and complete the task.\n# Verification\nCheck the output.', directory: '/skills/alpha',
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
      decide: async () => ({ skillName: 'Alpha', continueRestored: false }),
    })).resolves.toEqual({ skillName: 'Alpha', activation: 'automatic' })

    await expect(selectSkillForTurn({
      enabledSkills: [alpha, beta], userRequest: 'follow up', restoredSkillName: 'Alpha',
      decide: async () => ({ skillName: 'Alpha', continueRestored: true }),
    })).resolves.toEqual({ skillName: 'Alpha', activation: 'restored' })

    await expect(selectSkillForTurn({
      enabledSkills: [alpha], userRequest: 'unrelated', restoredSkillName: 'Alpha',
      decide: async () => ({ continueRestored: false }),
    })).resolves.toBeUndefined()
  })

  it('rejects selector output that is not in the enabled catalog', async () => {
    await expect(selectSkillForTurn({
      enabledSkills: [alpha], userRequest: 'task',
      decide: async () => ({ skillName: 'Forged', continueRestored: false }),
    })).rejects.toThrow('Invalid Skill selection')
  })

  it('runs plan, progressive load, execution, and validation without forcing tool choice', async () => {
    const calls: string[] = []
    const execute = vi.fn(async (input: Record<string, unknown>) => {
      calls.push('execute')
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
      selectedContext: '',
      references,
      tools: [{ name: 'search_assets', description: 'Search assets' }],
      plan: async () => { calls.push('plan'); return plan },
      readReferences: async paths => { calls.push('references'); return paths.map(path => ({ path, content: 'rules', bytes: 5 })) },
      execute,
      validate: async () => { calls.push('validate'); return { passed: true, violations: [] } },
      revise: vi.fn(),
    })

    expect(calls).toEqual(['plan', 'references', 'execute', 'validate'])
    expect(result).toMatchObject({ kind: 'completed', completed: { delivery: 'ready', text: 'grounded draft' } })
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
