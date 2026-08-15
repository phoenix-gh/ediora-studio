import { describe, expect, it } from 'vitest'

import { createSkillRun, sanitizeSkillRunPlan } from './skill-run'
import {
  applyOutputEvidence,
  applyReferenceEvidence,
  applyToolEvidence,
  incompleteRequiredSteps,
} from './skill-run-evidence'

function run() {
  return createSkillRun('Alpha', sanitizeSkillRunPlan({
    goal: '完成请求',
    steps: [
      { id: 'research', instruction: '读取并检索', requiredReferences: ['references/rules.md'], requiredTools: ['search_assets'] },
      { id: 'write', instruction: '生成结果', requiredReferences: [], requiredTools: [] },
    ],
    outputRequirements: ['遵循规则'],
    verificationCriteria: ['检查结果'],
  }, {
    referencePaths: ['references/rules.md'],
    toolNames: ['search_assets'],
  }), 'automatic')
}

describe('SkillRun evidence ledger', () => {
  it('completes a dependency step only after reference and successful tool evidence exist', () => {
    const withReference = applyReferenceEvidence(run(), ['references/rules.md'])
    expect(withReference.steps[0].status).toBe('pending')

    const updated = applyToolEvidence(withReference, [{
      type: 'dynamic-tool',
      toolName: 'search_assets',
      state: 'output-available',
      toolCallId: 'call-1',
      output: { result: [] },
    }])

    expect(updated.toolEvidence).toEqual([
      { toolName: 'search_assets', toolCallId: 'call-1', state: 'succeeded' },
    ])
    expect(updated.steps[0]).toMatchObject({
      status: 'completed',
      evidence: ['reference:references/rules.md', 'tool:search_assets:call-1'],
    })
  })

  it.each([
    ['output-error', { type: 'dynamic-tool', toolName: 'search_assets', state: 'output-error', toolCallId: 'call-1' }],
    ['approval-requested', { type: 'dynamic-tool', toolName: 'search_assets', state: 'approval-requested', toolCallId: 'call-2' }],
    ['approval-responded', { type: 'dynamic-tool', toolName: 'search_assets', state: 'approval-responded', toolCallId: 'call-3' }],
    ['plain text', { type: 'text', text: 'search_assets succeeded' }],
    ['unknown tool', { type: 'dynamic-tool', toolName: 'other_tool', state: 'output-available', toolCallId: 'call-4' }],
  ])('does not complete required work from %s', (_label, part) => {
    const updated = applyToolEvidence(applyReferenceEvidence(run(), ['references/rules.md']), [part])

    expect(updated.steps[0].status).toBe('pending')
  })

  it('records failed and pending tools compactly without storing outputs', () => {
    const updated = applyToolEvidence(run(), [
      { type: 'dynamic-tool', toolName: 'search_assets', state: 'output-error', toolCallId: 'failed', errorText: 'private output' },
      { type: 'dynamic-tool', toolName: 'search_assets', state: 'approval-requested', toolCallId: 'pending', input: { secret: true } },
    ])

    expect(updated.toolEvidence).toEqual([
      { toolName: 'search_assets', toolCallId: 'failed', state: 'failed' },
      { toolName: 'search_assets', toolCallId: 'pending', state: 'approval-pending' },
    ])
    expect(JSON.stringify(updated)).not.toContain('private output')
    expect(JSON.stringify(updated)).not.toContain('secret')
  })

  it('accepts only listed required reference evidence', () => {
    expect(applyReferenceEvidence(run(), ['references/other.md']).loadedReferences).toEqual([])
    expect(applyReferenceEvidence(run(), ['references/rules.md', 'references/rules.md']).loadedReferences)
      .toEqual(['references/rules.md'])
  })

  it('uses accepted output evidence only for steps without reference or tool dependencies', () => {
    const empty = applyOutputEvidence(run(), '   ')
    expect(empty.steps[1].status).toBe('pending')

    const updated = applyOutputEvidence(run(), 'accepted result')
    expect(updated.steps[0].status).toBe('pending')
    expect(updated.steps[1]).toMatchObject({ status: 'completed', evidence: ['output:accepted'] })
  })

  it('lists every step that still lacks required evidence', () => {
    const partial = applyReferenceEvidence(run(), ['references/rules.md'])
    expect(incompleteRequiredSteps(partial).map(step => step.id)).toEqual(['research', 'write'])
  })
})
