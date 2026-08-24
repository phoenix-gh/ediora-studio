import { describe, expect, it } from 'vitest'

import {
  createSkillBindingResolver,
  resolveSkillBinding,
} from './bindings'

describe('Skill bindings', () => {
  it('defines the four first-party pipeline bindings outside the Skill packages', () => {
    expect(resolveSkillBinding({
      name: 'source-research',
      description: '研究资料',
    })).toMatchObject({
      skillName: 'source-research',
      displayName: '资料研究',
      primaryOutput: 'research_bundle',
      capabilityProfile: 'research',
      requestedAllowedTools: ['web_search', 'fetch_url'],
      profileAllowedTools: ['web_search', 'fetch_url'],
    })
    expect(resolveSkillBinding({
      name: 'writing-plan',
      description: '按写作方案写作',
    })).toMatchObject({
      displayName: '写作方案',
      parameter: { kind: 'writing_plan', required: true },
      primaryOutput: 'article',
      capabilityProfile: 'writing',
    })
    expect(resolveSkillBinding({
      name: 'humanize-writing',
      description: '去除 AI 味',
    })).toMatchObject({
      displayName: '去 AI 味',
      primaryOutput: 'article',
      capabilityProfile: 'transform',
    })
    expect(resolveSkillBinding({
      name: 'account-voice',
      description: '账号文风',
    })).toMatchObject({
      displayName: '账号文风',
      parameter: { kind: 'publish_account', required: true },
      primaryOutput: 'article',
      capabilityProfile: 'transform',
    })
  })

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
