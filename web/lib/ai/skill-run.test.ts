import { describe, expect, it } from 'vitest'

import { createSkillRun, sanitizeSkillRunPlan } from './skill-run'

const catalogs = {
  referencePaths: ['references/rules.md', 'references/checks.md'],
  toolNames: ['search_assets', 'read_asset'],
}

function validPlan() {
  return {
    goal: '完成用户请求',
    steps: [{
      id: 'research',
      instruction: '读取规则并检索资产',
      requiredReferences: ['references/rules.md'],
      requiredTools: ['search_assets'],
    }],
    outputRequirements: ['遵循已读取的规则'],
    verificationCriteria: ['结果中的事实可以追溯'],
  }
}

describe('generic SkillRun contract', () => {
  it('sanitizes a plan against the active reference and tool catalogs', () => {
    expect(sanitizeSkillRunPlan(validPlan(), catalogs)).toEqual({
      ...validPlan(),
      steps: [{ ...validPlan().steps[0], status: 'pending', evidence: [] }],
    })
  })

  it('deduplicates catalogs inside the plan without changing order', () => {
    const plan = validPlan()
    plan.steps[0].requiredReferences.push('references/rules.md')
    plan.steps[0].requiredTools.push('search_assets')
    plan.outputRequirements.push('遵循已读取的规则')

    const sanitized = sanitizeSkillRunPlan(plan, catalogs)

    expect(sanitized.steps[0].requiredReferences).toEqual(['references/rules.md'])
    expect(sanitized.steps[0].requiredTools).toEqual(['search_assets'])
    expect(sanitized.outputRequirements).toEqual(['遵循已读取的规则'])
  })

  it.each([
    ['an unlisted reference', { ...validPlan(), steps: [{ ...validPlan().steps[0], requiredReferences: ['scripts/run.sh'] }] }],
    ['an unavailable tool', { ...validPlan(), steps: [{ ...validPlan().steps[0], requiredTools: ['shell'] }] }],
    ['duplicate step ids', { ...validPlan(), steps: [validPlan().steps[0], validPlan().steps[0]] }],
    ['an empty goal', { ...validPlan(), goal: '   ' }],
    ['unknown fields', { ...validPlan(), command: 'run.sh' }],
  ])('rejects %s', (_label, plan) => {
    expect(() => sanitizeSkillRunPlan(plan, catalogs)).toThrow('Invalid Skill plan')
  })

  it('bounds the number of steps and combined requirements', () => {
    const tooManySteps = {
      ...validPlan(),
      steps: Array.from({ length: 13 }, (_, index) => ({
        id: `step-${index}`,
        instruction: '执行步骤',
        requiredReferences: [],
        requiredTools: [],
      })),
    }
    const tooManyRequirements = {
      ...validPlan(),
      outputRequirements: Array.from({ length: 13 }, (_, index) => `输出要求 ${index}`),
      verificationCriteria: Array.from({ length: 12 }, (_, index) => `验收要求 ${index}`),
    }

    expect(() => sanitizeSkillRunPlan(tooManySteps, catalogs)).toThrow('Invalid Skill plan')
    expect(() => sanitizeSkillRunPlan(tooManyRequirements, catalogs)).toThrow('Invalid Skill plan')
  })

  it('creates an evidence-empty run with its activation source', () => {
    const plan = sanitizeSkillRunPlan(validPlan(), catalogs)

    expect(createSkillRun('Alpha', plan, 'automatic')).toEqual({
      skillName: 'Alpha',
      activation: 'automatic',
      goal: '完成用户请求',
      steps: plan.steps,
      requiredReferences: ['references/rules.md'],
      loadedReferences: [],
      requiredTools: ['search_assets'],
      toolEvidence: [],
      outputRequirements: ['遵循已读取的规则'],
      verificationCriteria: ['结果中的事实可以追溯'],
      validation: { passed: false, violations: [] },
    })
  })
})
