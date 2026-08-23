import { describe, expect, it } from 'vitest'

import {
  createSkillBindingResolver,
  resolveSkillBinding,
} from './bindings'

describe('Skill bindings', () => {
  it('uses a restrictive generic binding for a standard package with no binding', () => {
    expect(resolveSkillBinding({
      name: 'portable-skill',
      description: 'Portable',
    })).toEqual({
      skillName: 'portable-skill',
      displayName: 'portable-skill',
      description: 'Portable',
      primaryOutput: 'generic',
      capabilityProfile: 'restricted',
      defaultEnabled: false,
    })
  })

  it('returns an immutable Ediora binding outside the package', () => {
    const resolve = createSkillBindingResolver([{
      skillName: 'bound-skill',
      displayName: '绑定技能',
      primaryOutput: 'article',
      capabilityProfile: 'writing',
      defaultEnabled: true,
    }])
    const binding = resolve({
      name: 'bound-skill',
      description: 'Bound',
    })
    expect(binding.displayName).toBe('绑定技能')
    expect(Object.isFrozen(binding)).toBe(true)
  })
})
