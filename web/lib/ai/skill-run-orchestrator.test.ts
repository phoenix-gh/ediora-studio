import { describe, expect, it, vi } from 'vitest'

import { createSkillRun, sanitizeSkillRunPlan, type SkillRunValidation } from './skill-run'
import { applyReferenceEvidence, applyToolEvidence } from './skill-run-evidence'
import { completeSkillRun } from './skill-run-orchestrator'

const violation = {
  requirement: '不得虚构事实',
  evidence: '草稿包含无来源事实',
  correction: '删除无来源事实',
}

function baseRun({ dependencies = false } = {}) {
  const plan = sanitizeSkillRunPlan({
    goal: '完成请求',
    steps: [{
      id: 'deliver',
      instruction: '交付结果',
      requiredReferences: dependencies ? ['references/rules.md'] : [],
      requiredTools: dependencies ? ['search_assets'] : [],
    }],
    outputRequirements: ['不得虚构事实'],
    verificationCriteria: ['逐句检查事实'],
  }, {
    referencePaths: ['references/rules.md'],
    toolNames: ['search_assets'],
  })
  return createSkillRun('Alpha', plan, 'automatic')
}

describe('generic SkillRun completion lifecycle', () => {
  it('delivers a draft that passes its first validation', async () => {
    const validate = vi.fn(async (): Promise<SkillRunValidation> => ({ passed: true, violations: [] }))
    const revise = vi.fn()

    const result = await completeSkillRun({
      run: baseRun(),
      draft: async () => 'accepted draft',
      validate,
      revise,
    })

    expect(result).toMatchObject({ text: 'accepted draft', delivery: 'ready', revisionCount: 0 })
    expect(result.run.steps[0].status).toBe('completed')
    expect(validate).toHaveBeenCalledOnce()
    expect(revise).not.toHaveBeenCalled()
  })

  it('revises once and validates the revised result', async () => {
    const validate = vi.fn()
      .mockResolvedValueOnce({ passed: false, violations: [violation] })
      .mockResolvedValueOnce({ passed: true, violations: [] })
    const revise = vi.fn(async ({ violations }: { violations: typeof violation[] }) => `fixed: ${violations[0].correction}`)

    const result = await completeSkillRun({
      run: baseRun(),
      draft: async () => 'bad draft',
      validate,
      revise,
    })

    expect(result).toMatchObject({ text: 'fixed: 删除无来源事实', delivery: 'ready', revisionCount: 1 })
    expect(validate).toHaveBeenCalledTimes(2)
    expect(revise).toHaveBeenCalledWith(expect.objectContaining({ text: 'bad draft', violations: [violation] }))
  })

  it('fails closed after the revised result still violates requirements', async () => {
    const validate = vi.fn(async () => ({ passed: false, violations: [violation] }))

    const result = await completeSkillRun({
      run: baseRun(),
      draft: async () => 'rejected first draft',
      validate,
      revise: async () => 'rejected revised draft',
    })

    expect(result).toMatchObject({ delivery: 'blocked', revisionCount: 1 })
    expect(result.text).toContain('不得虚构事实')
    expect(result.text).not.toContain('rejected first draft')
    expect(result.text).not.toContain('rejected revised draft')
  })

  it('does not draft when required reference or tool evidence is incomplete', async () => {
    const draft = vi.fn(async () => 'must not be delivered')
    const validate = vi.fn()

    const result = await completeSkillRun({
      run: applyReferenceEvidence(baseRun({ dependencies: true }), ['references/rules.md']),
      draft,
      validate,
      revise: vi.fn(),
    })

    expect(result.delivery).toBe('blocked')
    expect(result.text).toContain('deliver')
    expect(draft).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
  })

  it('allows drafting when every required dependency has successful evidence', async () => {
    let run = applyReferenceEvidence(baseRun({ dependencies: true }), ['references/rules.md'])
    run = applyToolEvidence(run, [{
      type: 'dynamic-tool', toolName: 'search_assets', state: 'output-available', toolCallId: 'call-1', output: {},
    }])

    const result = await completeSkillRun({
      run,
      draft: async () => 'grounded result',
      validate: async () => ({ passed: true, violations: [] }),
      revise: vi.fn(),
    })

    expect(result.delivery).toBe('ready')
  })

  it('fails closed when validation throws', async () => {
    const result = await completeSkillRun({
      run: baseRun(),
      draft: async () => 'unvalidated draft',
      validate: async () => { throw new Error('provider unavailable') },
      revise: vi.fn(),
    })

    expect(result.delivery).toBe('blocked')
    expect(result.text).toContain('验证未完成')
    expect(result.text).not.toContain('unvalidated draft')
  })

  it('reports empty drafts as runtime incompletion instead of a Skill violation', async () => {
    await expect(completeSkillRun({
      run: baseRun(),
      draft: async () => '   ',
      validate: vi.fn(),
      revise: vi.fn(),
    })).rejects.toMatchObject({ code: 'final_answer_missing' })
  })

  it('reports empty revisions as runtime incompletion instead of a Skill violation', async () => {
    await expect(completeSkillRun({
      run: baseRun(),
      draft: async () => 'bad',
      validate: async () => ({ passed: false, violations: [violation] }),
      revise: async () => '',
    })).rejects.toMatchObject({ code: 'final_revision_missing' })
  })
})
