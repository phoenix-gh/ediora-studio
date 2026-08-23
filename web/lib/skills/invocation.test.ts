import { describe, expect, it } from 'vitest'

import { formatSkillInvocation } from './invocation'

describe('formatSkillInvocation', () => {
  const skill = {
    name: 'source-research',
    content: '# Workflow\n\nResearch attributable sources.',
  }

  it('matches the Pi skill block semantics with a logical location', () => {
    expect(formatSkillInvocation(skill, 'Focus on local-first AI.')).toBe(
      '<skill name="source-research" location="skill://source-research/SKILL.md">\n'
      + 'References are relative to skill://source-research/.\n\n'
      + '# Workflow\n\nResearch attributable sources.\n'
      + '</skill>\n\n'
      + 'Focus on local-first AI.',
    )
  })

  it('does not add a blank instruction suffix when none is supplied', () => {
    expect(formatSkillInvocation(skill)).toMatch(/<\/skill>$/)
  })
})
