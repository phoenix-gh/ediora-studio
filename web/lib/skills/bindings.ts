import type { ManagedSkill } from './registry'

export type SkillParameterKind = 'writing_plan' | 'publish_account'
export type SkillPrimaryOutput = 'research_bundle' | 'article' | 'generic'
export type SkillCapabilityProfile =
  | 'restricted'
  | 'research'
  | 'writing'
  | 'draft-writing'
  | 'transform'
  | 'interactive'

export type SkillBinding = {
  skillName: string
  displayName: string
  description?: string
  parameter?: {
    kind: SkillParameterKind
    required: boolean
  }
  primaryOutput: SkillPrimaryOutput
  capabilityProfile: SkillCapabilityProfile
  defaultEnabled: boolean
}

const builtinBindings: readonly SkillBinding[] = Object.freeze([
  {
    skillName: 'human-social-copy',
    displayName: 'Human social copy',
    primaryOutput: 'article',
    capabilityProfile: 'writing',
    defaultEnabled: true,
  },
  {
    skillName: 'x-article-writing',
    displayName: 'X Article writing',
    primaryOutput: 'article',
    capabilityProfile: 'draft-writing',
    defaultEnabled: true,
  },
  {
    skillName: 'wechat-article-writing',
    displayName: 'WeChat article writing',
    primaryOutput: 'article',
    capabilityProfile: 'draft-writing',
    defaultEnabled: true,
  },
])

function frozenBinding(binding: SkillBinding): Readonly<SkillBinding> {
  return Object.freeze({
    ...binding,
    ...(binding.parameter === undefined
      ? {}
      : { parameter: Object.freeze({ ...binding.parameter }) }),
  })
}

export function createSkillBindingResolver(
  bindings: readonly SkillBinding[],
): (skill: Pick<ManagedSkill, 'name' | 'description'>) => Readonly<SkillBinding> {
  const bindingMap = new Map<string, Readonly<SkillBinding>>()
  for (const binding of bindings) {
    if (bindingMap.has(binding.skillName)) {
      throw new Error(`Duplicate Skill binding: ${binding.skillName}`)
    }
    bindingMap.set(binding.skillName, frozenBinding(binding))
  }
  Object.freeze(bindingMap)

  return skill => {
    const binding = bindingMap.get(skill.name)
    if (binding) return frozenBinding(binding)
    return Object.freeze({
      skillName: skill.name,
      displayName: skill.name,
      description: skill.description,
      primaryOutput: 'generic' as const,
      capabilityProfile: 'restricted' as const,
      defaultEnabled: false,
    })
  }
}

export const resolveSkillBinding = createSkillBindingResolver(builtinBindings)
