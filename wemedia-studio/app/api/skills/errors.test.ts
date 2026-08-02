import { describe, expect, it } from 'vitest'

import { SkillRegistryError } from '@/lib/skills/registry'

import { skillErrorResponse } from './errors'

describe('Skill API errors', () => {
  it.each([
    ['invalid_reference', 400],
    ['reference_not_found', 404],
  ] as const)('maps %s to HTTP %s', (code, status) => {
    expect(skillErrorResponse(new SkillRegistryError(code, 'reference failed')).status).toBe(status)
  })
})
