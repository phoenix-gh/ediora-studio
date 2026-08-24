import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import type { RegisteredSkill, SkillReference } from '../skills/registry'
import { sanitizeSkillRunPlan } from './skill-run'
import { buildSkillPlanPrompt, loadPlannedReferences } from './skill-run-planner'

const references: SkillReference[] = [
  { path: 'references/rules.md', bytes: 5 },
  { path: 'references/checks.md', bytes: 6 },
]

function syntheticSkill(name: string, instructions: string): RegisteredSkill {
  return {
    name,
    description: `${name} handles a synthetic workflow`,
    version: '1.0.0',
    digest: 'a'.repeat(64),
    source: 'uploaded',
    enabled: true,
    reviewState: 'approved',
    standardCompatible: true,
    diagnostics: [],
    instructions,
    content: instructions,
    directory: `/skills/${name}`,
    packageFiles: [],
    requestedAllowedTools: [],
  }
}

describe('generic Skill run planning', () => {
  it.each([
    syntheticSkill('Alpha', '# Procedure\nRewrite the supplied material.\n# Verification\nCheck every rule.'),
    syntheticSkill('Beta', '# Procedure\nResearch primary sources.\n# Verification\nCite collected evidence.'),
    syntheticSkill('Gamma', '# Procedure\nGenerate a media asset.\n# Verification\nInspect the output.'),
  ])('builds the same domain-neutral planning contract for $name', skill => {
    const prompt = buildSkillPlanPrompt({
      skill,
      userRequest: '处理当前输入',
      selectedContext: 'Selected account: Example',
      references,
      tools: [{ name: 'search_assets', description: 'Search assets' }],
    })

    expect(prompt).toContain(skill.instructions)
    expect(prompt).toContain('Use only exact reference paths and tool names from the catalogs')
    expect(prompt).toContain('outputRequirements')
    expect(prompt).toContain('verificationCriteria')
  })

  it('includes the previous assistant deliverable when planning a follow-up rewrite', () => {
    const prompt = buildSkillPlanPrompt({
      skill: syntheticSkill('Rewrite', '# Procedure\nRewrite the supplied material.'),
      userRequest: '我只要写一个短帖',
      conversationContext: '<previous_assistant_deliverable>这是上一轮文章。</previous_assistant_deliverable>',
      selectedContext: '',
      references,
      tools: [],
    })

    expect(prompt).toContain('这是上一轮文章。')
    expect(prompt).toContain('将上一轮交付物改写为短帖')
  })

  it('contains no bundled Skill identifier or domain branch', () => {
    const source = readFileSync(new URL('./skill-run-planner.ts', import.meta.url), 'utf8')

    expect(source).not.toMatch(/human-social-copy|baoyu-cover-image|baoyu-article-illustrator/)
  })

  it('loads the union of planned references once in first-use order', async () => {
    const plan = sanitizeSkillRunPlan({
      goal: '执行合成任务',
      steps: [
        { id: 'one', instruction: '读取规则', requiredReferences: ['references/rules.md'], requiredTools: [] },
        { id: 'two', instruction: '核对规则', requiredReferences: ['references/rules.md', 'references/checks.md'], requiredTools: [] },
      ],
      outputRequirements: [],
      verificationCriteria: [],
    }, { referencePaths: references.map(item => item.path), toolNames: [] })
    const readReferences = vi.fn(async (paths: string[]) => paths.map(path => ({ path, content: path, bytes: 1 })))

    await expect(loadPlannedReferences(plan, readReferences)).resolves.toEqual([
      { path: 'references/rules.md', content: 'references/rules.md', bytes: 1 },
      { path: 'references/checks.md', content: 'references/checks.md', bytes: 1 },
    ])
    expect(readReferences).toHaveBeenCalledOnce()
    expect(readReferences).toHaveBeenCalledWith(['references/rules.md', 'references/checks.md'])
  })

  it('propagates a required reference read failure', async () => {
    const plan = sanitizeSkillRunPlan({
      goal: '执行合成任务',
      steps: [{ id: 'read', instruction: '读取规则', requiredReferences: ['references/rules.md'], requiredTools: [] }],
      outputRequirements: [], verificationCriteria: [],
    }, { referencePaths: references.map(item => item.path), toolNames: [] })

    await expect(loadPlannedReferences(plan, async () => { throw new Error('read failed') }))
      .rejects.toThrow('read failed')
  })
})
