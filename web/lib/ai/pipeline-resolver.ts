import { apiGet, type ApiRequestError, workerHeaders } from './job-client'
import { buildAgentCapabilitySnapshot } from './agent-capabilities'
import { resolveSkillBinding } from '../skills/bindings'
import {
  getEnabledSkill,
  listSkillReferences,
  loadSkillPreloadContext,
  type RegisteredSkill,
} from '../skills/registry'

export type PipelineParameterKind = 'writing_plan' | 'publish_account'

export type SubmittedSkillInvocation = {
  invocationId: string
  skillName: string
  skillDisplayName: string
  parameterKind?: PipelineParameterKind
  parameterId?: string
  parameterDisplayName?: string
}

export type PipelineParameterOption = {
  id: string
  displayName: string
  kind: PipelineParameterKind
  summary: string
  metadata: Record<string, unknown>
}

export type ResolvedSkillInvocationPayload = {
  invocation_id: string
  skill_name: string
  skill_display_name: string
  parameter_kind?: PipelineParameterKind
  parameter_id?: string
  parameter_display_name?: string
  skill_snapshot: Record<string, unknown>
  binding_snapshot: Record<string, unknown>
  parameter_snapshot: Record<string, unknown> | null
  capability_snapshot: Record<string, unknown>
}

export class PipelineResolutionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'PipelineResolutionError'
  }
}

type WritingPlanRecord = {
  id: number
  title: string
  strategy?: string
  description?: string
  genre?: string
  status?: string
  tags?: Array<{ name?: string }>
  cover_style?: Record<string, unknown> | null
  image_style?: string | null
  sources?: Array<{
    id: number
    url?: string
    title?: string
    content?: string
    note?: string
    platform?: string
    draft_id?: number | null
  }>
}

type PublishAccountRecord = {
  id: string
  name: string
  platform?: string
  positioning?: string
  audience?: string
  tone?: string
  topic_focus?: string[]
  taboo?: string[]
  word_range?: Record<string, number>
  image_style?: string
  cover_style?: Record<string, unknown>
  voice_samples?: string[]
  style_rules?: string[]
  is_active?: boolean
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function matchesQuery(values: unknown[], query: string) {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return values.some(value => text(value).toLocaleLowerCase().includes(normalized))
}

function shortSummary(value: unknown, fallback: string) {
  const normalized = text(value).replace(/\s+/g, ' ')
  return (normalized || fallback).slice(0, 240)
}

function writingPlanOption(plan: WritingPlanRecord): PipelineParameterOption {
  const tags = (plan.tags ?? []).map(tag => text(tag.name)).filter(Boolean)
  return {
    id: String(plan.id),
    displayName: text(plan.title) || `写作方案 #${plan.id}`,
    kind: 'writing_plan',
    summary: shortSummary(plan.strategy || plan.description, '未填写方案策略'),
    metadata: {
      genre: text(plan.genre),
      tags,
      sourceCount: plan.sources?.length ?? 0,
    },
  }
}

function publishAccountOption(account: PublishAccountRecord): PipelineParameterOption {
  const platform = text(account.platform) || '未设置平台'
  return {
    id: account.id,
    displayName: text(account.name) || account.id,
    kind: 'publish_account',
    summary: `${platform} · ${shortSummary(account.positioning, '未填写账号定位')}`,
    metadata: {
      platform,
      positioning: text(account.positioning),
      audience: text(account.audience),
      tone: text(account.tone),
    },
  }
}

export async function listPipelineParameterOptions(
  kind: PipelineParameterKind,
  query = '',
): Promise<PipelineParameterOption[]> {
  const headers = workerHeaders()
  if (kind === 'writing_plan') {
    const plans = await apiGet<WritingPlanRecord[]>('/writing-plans', headers)
    return plans
      .filter(plan => plan.status === undefined || plan.status === 'active')
      .filter(plan => matchesQuery([plan.title, plan.strategy, plan.description, ...(plan.tags ?? []).map(tag => tag.name)], query))
      .slice(0, 50)
      .map(writingPlanOption)
  }

  const accounts = await apiGet<PublishAccountRecord[]>('/publish-accounts', headers)
  return accounts
    .filter(account => account.is_active !== false)
    .filter(account => matchesQuery([account.name, account.platform, account.positioning, account.audience, account.tone], query))
    .slice(0, 50)
    .map(publishAccountOption)
}

async function loadWritingPlan(id: string): Promise<WritingPlanRecord> {
  const planId = Number(id)
  if (!Number.isSafeInteger(planId) || planId <= 0) {
    throw new PipelineResolutionError(422, '写作方案 ID 无效')
  }
  try {
    const plan = await apiGet<WritingPlanRecord>(`/writing-plans/${planId}`, workerHeaders())
    if (plan.status !== undefined && plan.status !== 'active') {
      throw new PipelineResolutionError(409, '写作方案已停用，不能用于新 Pipeline')
    }
    return plan
  } catch (error) {
    if (error instanceof PipelineResolutionError) throw error
    const status = (error as ApiRequestError).status
    if (status === 404) throw new PipelineResolutionError(404, '写作方案不存在或无权使用')
    throw error
  }
}

async function loadPublishAccount(id: string): Promise<PublishAccountRecord> {
  if (!id.trim()) throw new PipelineResolutionError(422, '发布账号 ID 无效')
  try {
    const account = await apiGet<PublishAccountRecord>(`/publish-accounts/${encodeURIComponent(id)}`, workerHeaders())
    if (account.is_active === false) {
      throw new PipelineResolutionError(409, '发布账号已停用，不能用于新 Pipeline')
    }
    return account
  } catch (error) {
    if (error instanceof PipelineResolutionError) throw error
    const status = (error as ApiRequestError).status
    if (status === 404) throw new PipelineResolutionError(404, '发布账号不存在或无权使用')
    throw error
  }
}

function writingPlanSnapshot(plan: WritingPlanRecord): Record<string, unknown> {
  return {
    id: plan.id,
    title: text(plan.title),
    strategy: text(plan.strategy),
    description: text(plan.description),
    genre: text(plan.genre),
    tags: (plan.tags ?? []).map(tag => text(tag.name)).filter(Boolean),
    cover_style: plan.cover_style ?? null,
    image_style: plan.image_style ?? null,
    sources: (plan.sources ?? []).map(source => ({
      id: source.id,
      url: text(source.url),
      title: text(source.title),
      content: text(source.content),
      note: text(source.note),
      platform: text(source.platform),
      draft_id: source.draft_id ?? null,
    })),
  }
}

function publishAccountSnapshot(account: PublishAccountRecord): Record<string, unknown> {
  return {
    id: account.id,
    name: text(account.name),
    platform: text(account.platform),
    positioning: text(account.positioning),
    audience: text(account.audience),
    tone: text(account.tone),
    topic_focus: account.topic_focus ?? [],
    taboo: account.taboo ?? [],
    word_range: account.word_range ?? {},
    image_style: text(account.image_style),
    cover_style: account.cover_style ?? {},
    voice_samples: account.voice_samples ?? [],
    style_rules: account.style_rules ?? [],
  }
}

async function skillRuntimeSnapshot(skill: RegisteredSkill) {
  const [references, preload] = await Promise.all([
    listSkillReferences(skill.name),
    loadSkillPreloadContext(skill.name),
  ])
  return buildAgentCapabilitySnapshot({
    mode: 'chat',
    skill: {
      skill,
      activation: 'manual',
      references,
      loadedReferences: preload.references,
    },
    tools: {},
    approvalPolicy: 'interactive',
    allowedToolNames: [],
  }) as unknown as Record<string, unknown>
}

async function resolveOne(invocation: SubmittedSkillInvocation): Promise<ResolvedSkillInvocationPayload> {
  const skill = await getEnabledSkill(invocation.skillName)
  if (!skill) throw new PipelineResolutionError(404, `Skill 不可用：${invocation.skillName}`)

  const binding = resolveSkillBinding(skill)
  const submittedParameterFields = [invocation.parameterKind, invocation.parameterId, invocation.parameterDisplayName]
  const hasParameter = submittedParameterFields.some(value => value !== undefined)
  if (binding.parameter && !hasParameter) {
    throw new PipelineResolutionError(422, `Skill「${binding.displayName}」需要选择${binding.parameter.kind === 'writing_plan' ? '写作方案' : '发布账号'}`)
  }
  if (!binding.parameter && hasParameter) {
    throw new PipelineResolutionError(422, `Skill「${binding.displayName}」不接受参数`)
  }
  if (binding.parameter && invocation.parameterKind !== binding.parameter.kind) {
    throw new PipelineResolutionError(422, 'Skill 参数类型与绑定定义不匹配')
  }
  if (binding.parameter && !invocation.parameterId) {
    throw new PipelineResolutionError(422, 'Skill 参数不能为空')
  }

  const [capabilitySnapshot, parameter] = await Promise.all([
    skillRuntimeSnapshot(skill),
    binding.parameter && invocation.parameterId
      ? binding.parameter.kind === 'writing_plan'
        ? loadWritingPlan(invocation.parameterId)
        : loadPublishAccount(invocation.parameterId)
      : Promise.resolve(null),
  ])

  const parameterSnapshot = parameter === null
    ? null
    : binding.parameter?.kind === 'writing_plan'
      ? writingPlanSnapshot(parameter as WritingPlanRecord)
      : publishAccountSnapshot(parameter as PublishAccountRecord)
  const parameterDisplayName = parameter === null
    ? undefined
    : binding.parameter?.kind === 'writing_plan'
      ? writingPlanOption(parameter as WritingPlanRecord).displayName
      : publishAccountOption(parameter as PublishAccountRecord).displayName

  return {
    invocation_id: invocation.invocationId,
    skill_name: skill.name,
    skill_display_name: binding.displayName,
    ...(binding.parameter ? {
      parameter_kind: binding.parameter.kind,
      parameter_id: invocation.parameterId,
      parameter_display_name: parameterDisplayName,
    } : {}),
    skill_snapshot: {
      name: skill.name,
      version: skill.version,
      digest: skill.digest,
      source: skill.source,
      instructions: skill.instructions,
      requestedAllowedTools: [],
    },
    binding_snapshot: {
      skillName: skill.name,
      displayName: binding.displayName,
      primaryOutput: binding.primaryOutput,
      capabilityProfile: binding.capabilityProfile,
      requestedAllowedTools: [],
      profileAllowedTools: [],
    },
    parameter_snapshot: parameterSnapshot,
    capability_snapshot: capabilitySnapshot,
  }
}

export async function resolvePipelineInvocations(
  invocations: SubmittedSkillInvocation[],
): Promise<ResolvedSkillInvocationPayload[]> {
  if (!Array.isArray(invocations) || invocations.length === 0 || invocations.length > 24) {
    throw new PipelineResolutionError(400, '至少需要选择一个 Skill，最多选择 24 个')
  }
  const seen = new Set<string>()
  for (const invocation of invocations) {
    if (seen.has(invocation.invocationId)) {
      throw new PipelineResolutionError(422, `重复的 invocationId：${invocation.invocationId}`)
    }
    seen.add(invocation.invocationId)
  }
  return Promise.all(invocations.map(resolveOne))
}
