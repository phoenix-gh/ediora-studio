import { generateText, Output, stepCountIs, type ModelMessage, type ToolSet } from 'ai'

import { openGlobalAgentTools, type ChatSkillRuntime, type GlobalAgentToolOptions } from './global-chat-tools'
import { executeSkillRunWithAiSdk, selectSkillForTurn } from './skill-run-ai-sdk'
import {
  skillRunPlanInputSchema,
  skillRunValidationSchema,
  type SkillRun,
  type SkillRunActivation,
} from './skill-run'
import type {
  AgentApprovalPolicy,
  AgentSkillMode,
  AgentStepCheckpoint,
  AgentToolAudit,
  AgentToolDecision,
} from './agent-runtime-types'
import {
  getEnabledSkill,
  listEnabledSkills,
  type RegisteredSkill,
} from '../skills/registry'

export type AgentSelectedSkill = {
  skill: RegisteredSkill
  activation: SkillRunActivation
}

export type AgentRuntimeDependencies = {
  openTools(options: GlobalAgentToolOptions): Promise<ChatSkillRuntime>
  listEnabledSkills(): Promise<RegisteredSkill[]>
  getEnabledSkill(name: string): Promise<RegisteredSkill | null>
  generate: typeof generateText
}

export type OpenAgentRuntimeOptions = {
  apiBase: string
  model: Parameters<typeof generateText>[0]['model']
  approvalPolicy: AgentApprovalPolicy
  skillMode: AgentSkillMode
  skillName?: string
  restoredSkillName?: string
  automaticSelection?: boolean
  draftId?: number
  beforeToolExecute?: (event: AgentToolAudit) => Promise<AgentToolDecision>
  onToolAudit?: (event: AgentToolAudit) => void | Promise<void>
  dependencies?: AgentRuntimeDependencies
}

export type AgentRunRequest = {
  objective: string
  modelMessages: ModelMessage[]
  selectedContext?: string
  maxSteps: number
  onStep?: (checkpoint: AgentStepCheckpoint) => void | Promise<void>
}

export type AgentRunResult = {
  kind: 'completed' | 'approval'
  text: string
  parts: Record<string, unknown>[]
  skillRun?: SkillRun
  revisionCount: 0 | 1
  selectedSkill?: { name: string; activation: SkillRunActivation }
}

export type AgentRuntime = {
  readonly tools: ToolSet
  readonly catalogContext: string
  readonly selectedSkill: AgentSelectedSkill | undefined
  prepare(objective: string): Promise<AgentSelectedSkill | undefined>
  run(request: AgentRunRequest): Promise<AgentRunResult>
  snapshot: ChatSkillRuntime['snapshot']
  activeContext: ChatSkillRuntime['activeContext']
  readReferences: ChatSkillRuntime['readReferences']
  close(): Promise<void>
}

const defaultDependencies: AgentRuntimeDependencies = {
  openTools: openGlobalAgentTools,
  listEnabledSkills,
  getEnabledSkill,
  generate: generateText,
}

export function planningTools(tools: ToolSet) {
  return Object.entries(tools)
    .filter(([name]) => name !== 'loadSkill' && name !== 'readSkillReference')
    .map(([name, value]) => ({
      name,
      description: typeof (value as { description?: unknown }).description === 'string'
        ? (value as { description: string }).description
        : '',
    }))
}

export function executionParts(result: {
  toolResults: Array<Record<string, unknown>>
  content: Array<Record<string, unknown>>
}) {
  const parts: Record<string, unknown>[] = []
  for (const item of result.toolResults) {
    if (typeof item.toolName !== 'string' || typeof item.toolCallId !== 'string') continue
    parts.push({
      type: 'dynamic-tool', toolName: item.toolName, toolCallId: item.toolCallId,
      state: 'output-available', output: item.output,
    })
  }
  for (const item of result.content) {
    if (item.type !== 'tool-approval-request' || !item.toolCall || typeof item.toolCall !== 'object') continue
    const toolCall = item.toolCall as Record<string, unknown>
    if (typeof toolCall.toolName !== 'string' || typeof toolCall.toolCallId !== 'string' || typeof item.approvalId !== 'string') continue
    parts.push({
      type: 'dynamic-tool', toolName: toolCall.toolName, toolCallId: toolCall.toolCallId,
      state: 'approval-requested', input: toolCall.input, approval: { id: item.approvalId },
    })
  }
  return parts
}

export function agentSkillRunAudit(result: AgentRunResult) {
  const run = result.skillRun
  if (!run) return undefined
  return {
    skillName: run.skillName,
    activation: run.activation,
    steps: run.steps.map(step => ({ id: step.id, status: step.status, evidence: step.evidence })),
    loadedReferences: run.loadedReferences,
    toolEvidence: run.toolEvidence,
    validation: run.validation,
    revisionCount: result.revisionCount,
  }
}

export async function openAgentRuntime(
  options: OpenAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const deps = options.dependencies ?? defaultDependencies
  const automaticSelection = options.automaticSelection ?? true
  let selected: AgentSelectedSkill | undefined
  let prepared = !automaticSelection

  if (options.skillMode === 'manual') {
    const name = options.skillName?.trim()
    const skill = name ? await deps.getEnabledSkill(name) : null
    if (!skill) throw new Error('Selected skill is unavailable')
    selected = { skill, activation: 'manual' }
    prepared = true
  }

  const toolOptions = (skillName?: string, restoredSkillName?: string): GlobalAgentToolOptions => ({
    apiBase: options.apiBase,
    draftId: options.draftId,
    skillName,
    restoredSkillName,
    approvalPolicy: options.approvalPolicy,
    beforeToolExecute: options.beforeToolExecute,
    onToolAudit: options.onToolAudit,
  })
  let registry = await deps.openTools(toolOptions(
    selected?.skill.name,
    !automaticSelection && !selected ? options.restoredSkillName : undefined,
  ))

  async function prepare(objective: string) {
    if (prepared) return selected
    const enabledSkills = await deps.listEnabledSkills()
    const choice = await selectSkillForTurn({
      enabledSkills,
      userRequest: objective,
      restoredSkillName: options.restoredSkillName,
      decide: async ({ prompt }) => {
        const decision = await deps.generate({
          model: options.model,
          prompt,
          output: Output.json(),
        })
        return decision.output
      },
    })
    prepared = true
    if (!choice) return undefined
    const skill = enabledSkills.find(candidate => candidate.name === choice.skillName)
    if (!skill) throw new Error('Selected skill is unavailable')
    selected = { skill, activation: choice.activation }
    await registry.close()
    registry = await deps.openTools(toolOptions(skill.name))
    return selected
  }

  async function run(request: AgentRunRequest): Promise<AgentRunResult> {
    const active = await prepare(request.objective)
    if (!active) {
      const generated = await deps.generate({
        model: options.model,
        messages: request.modelMessages,
        tools: registry.tools,
        stopWhen: stepCountIs(request.maxSteps),
      })
      const parts = executionParts({
        toolResults: generated.toolResults as Array<Record<string, unknown>>,
        content: generated.content as Array<Record<string, unknown>>,
      })
      await request.onStep?.({ phase: 'execute', parts })
      return { kind: 'completed', text: generated.text, parts, revisionCount: 0 }
    }

    const result = await executeSkillRunWithAiSdk({
      skill: active.skill,
      activation: active.activation,
      userRequest: request.objective,
      selectedContext: request.selectedContext ?? '',
      references: registry.activeContext()?.references ?? [],
      tools: planningTools(registry.tools),
      plan: async ({ prompt }) => {
        const planned = await deps.generate({ model: options.model, prompt, output: Output.json() })
        const parsed = skillRunPlanInputSchema.safeParse(planned.output)
        let plan: unknown = parsed.success ? parsed.data : undefined
        if (!parsed.success) {
          const repaired = await deps.generate({
            model: options.model,
            prompt: `${prompt}\n\nThe previous JSON was invalid. Repair it exactly: every step id must be a string, arrays must use exact listed paths and tools, and no unknown fields are allowed.\n\nPrevious JSON:\n${JSON.stringify(planned.output)}`,
            output: Output.json(),
          })
          plan = skillRunPlanInputSchema.parse(repaired.output)
        }
        await request.onStep?.({ phase: 'plan', detail: plan })
        return plan
      },
      readReferences: async paths => {
        const references = await registry.readReferences(paths)
        if (paths.length > 0) await request.onStep?.({
          phase: 'references',
          detail: references.map(reference => ({ path: reference.path, bytes: reference.bytes })),
        })
        return references
      },
      execute: async ({ prompt, requiredTools }) => {
        const generated = await deps.generate({
          model: options.model,
          instructions: prompt,
          messages: request.modelMessages,
          tools: registry.tools,
          activeTools: requiredTools,
          stopWhen: stepCountIs(request.maxSteps),
        })
        const parts = executionParts({
          toolResults: generated.toolResults as Array<Record<string, unknown>>,
          content: generated.content as Array<Record<string, unknown>>,
        })
        await request.onStep?.({ phase: 'execute', parts })
        return { text: generated.text, parts }
      },
      validate: async ({ text, run, loadedReferences }) => {
        const prompt = `Return valid JSON only in exactly this shape: {"passed": boolean, "violations": [{"requirement": string, "evidence": string, "correction": string}]}. A passing result must use an empty violations array. Validate the candidate strictly against every dynamic requirement and verification criterion. Quote concrete candidate evidence for each violation.\n\nRequirements:\n${JSON.stringify(run.outputRequirements)}\n\nVerification criteria:\n${JSON.stringify(run.verificationCriteria)}\n\nLoaded references:\n${JSON.stringify(loadedReferences)}\n\nCandidate:\n${text}`
        const checked = await deps.generate({ model: options.model, prompt, output: Output.json() })
        const parsed = skillRunValidationSchema.safeParse(checked.output)
        let validation
        if (parsed.success) validation = parsed.data
        else {
          const repaired = await deps.generate({
            model: options.model,
            prompt: `${prompt}\n\nThe previous JSON was invalid. Repair its shape without changing the substantive judgment.\n\nPrevious JSON:\n${JSON.stringify(checked.output)}`,
            output: Output.json(),
          })
          validation = skillRunValidationSchema.parse(repaired.output)
        }
        await request.onStep?.({ phase: 'validate', detail: validation })
        return validation
      },
      revise: async ({ text, run, loadedReferences, violations }) => {
        const revised = await deps.generate({
          model: options.model,
          prompt: `Revise the candidate once. Use only the supplied evidence, satisfy every requirement, and correct every violation. Return only the revised deliverable.\n\nRequirements:\n${JSON.stringify(run.outputRequirements)}\n\nLoaded references:\n${JSON.stringify(loadedReferences)}\n\nViolations:\n${JSON.stringify(violations)}\n\nCandidate:\n${text}`,
        })
        await request.onStep?.({ phase: 'revise', detail: { text: revised.text } })
        return revised.text
      },
    })
    const skillRun = result.kind === 'completed' ? result.completed.run : result.run
    const revisionCount = result.kind === 'completed' ? result.completed.revisionCount : 0
    const parts = result.kind === 'completed'
      ? [{ type: 'text', text: result.completed.text }]
      : result.parts as Record<string, unknown>[]
    return {
      kind: result.kind,
      text: result.kind === 'completed' ? result.completed.text : '',
      parts,
      skillRun,
      revisionCount,
      selectedSkill: { name: active.skill.name, activation: active.activation },
    }
  }

  return {
    get tools() { return registry.tools },
    get catalogContext() { return registry.catalogContext },
    get selectedSkill() { return selected },
    prepare,
    run,
    snapshot: () => registry.snapshot(),
    activeContext: () => registry.activeContext(),
    readReferences: paths => registry.readReferences(paths),
    close: () => registry.close(),
  }
}
