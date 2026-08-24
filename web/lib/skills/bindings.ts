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
  requestedAllowedTools?: readonly string[]
  profileAllowedTools?: readonly string[]
  defaultEnabled: boolean
}

const builtinBindings: readonly SkillBinding[] = Object.freeze([
  {
    skillName: 'source-research',
    displayName: '资料研究',
    description: '为明确的研究任务检索、核验并整理可追溯资料；普通数据查询或单次选题检索不需要使用。',
    primaryOutput: 'research_bundle',
    capabilityProfile: 'research',
    requestedAllowedTools: ['web_search', 'fetch_url'],
    profileAllowedTools: ['web_search', 'fetch_url'],
    defaultEnabled: true,
  },
  {
    skillName: 'writing-plan',
    displayName: '写作方案',
    description: '按选定的写作方案把研究材料组织成完整文章。',
    parameter: { kind: 'writing_plan', required: true },
    primaryOutput: 'article',
    capabilityProfile: 'writing',
    requestedAllowedTools: ['web_search', 'fetch_url'],
    profileAllowedTools: ['web_search', 'fetch_url'],
    defaultEnabled: true,
  },
  {
    skillName: 'humanize-writing',
    displayName: '去 AI 味',
    description: '在不改变事实和结构的前提下，去除模板化和机械化表达。',
    primaryOutput: 'article',
    capabilityProfile: 'transform',
    requestedAllowedTools: [],
    profileAllowedTools: [],
    defaultEnabled: true,
  },
  {
    skillName: 'account-voice',
    displayName: '账号文风',
    description: '根据已选择账号的风格画像改写文章，不执行发布或账号操作。',
    parameter: { kind: 'publish_account', required: true },
    primaryOutput: 'article',
    capabilityProfile: 'transform',
    requestedAllowedTools: [],
    profileAllowedTools: [],
    defaultEnabled: true,
  },
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
    ...(binding.requestedAllowedTools === undefined ? {} : {
      requestedAllowedTools: Object.freeze([...binding.requestedAllowedTools]),
    }),
    ...(binding.profileAllowedTools === undefined ? {} : {
      profileAllowedTools: Object.freeze([...binding.profileAllowedTools]),
    }),
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
