import { generateText, Output, stepCountIs, type ModelMessage, type ToolSet } from 'ai'

import {
  openGlobalAgentTools,
  type ChatSkillRuntime,
  type GlobalAgentToolOptions,
  type ImageGenerator,
} from './global-chat-tools'
import {
  buildAgentCapabilitySnapshot,
  type AgentCapabilitySnapshot,
  type AgentRuntimeMode,
  type SkillCapabilityInput,
} from './agent-capabilities'
import {
  resolveAgentToolPolicy,
  type AgentToolPolicyProfile,
} from './agent-tool-policy'
import { executeSkillRunWithAiSdk, selectSkillForTurn } from './skill-run-ai-sdk'
import {
  sanitizeSkillRunPlan,
  skillRunPlanInputSchema,
  skillRunValidationSchema,
  type SkillRun,
  type SkillRunActivation,
} from './skill-run'
import type {
  AgentApprovalPolicy,
  AgentModelMessageEvent,
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
  mcpEndpoint: string
  imageGenerator: ImageGenerator
  model: Parameters<typeof generateText>[0]['model']
  approvalPolicy?: AgentApprovalPolicy
  policyProfile?: AgentToolPolicyProfile
  mode?: AgentRuntimeMode
  skillMode: AgentSkillMode
  skillName?: string
  restoredSkillName?: string
  automaticSelection?: boolean
  draftId?: number
  dailyCreationRunId?: number
  allowedToolNames?: readonly string[]
  blockedToolNames?: readonly string[]
  alwaysAvailableToolNames?: readonly string[]
  beforeToolExecute?: (event: AgentToolAudit) => Promise<AgentToolDecision>
  onToolAudit?: (event: AgentToolAudit) => void | Promise<void>
  onMessage?: (event: AgentModelMessageEvent) => void | Promise<void>
  dependencies?: AgentRuntimeDependencies
}

export type AgentRunRequest = {
  objective: string
  modelMessages: ModelMessage[]
  selectedContext?: string
  maxSteps: number
  requiredTools?: string[]
  onStep?: (checkpoint: AgentStepCheckpoint) => void | Promise<void>
}

export type AgentRunResult = {
  kind: 'completed' | 'approval'
  text: string
  parts: Record<string, unknown>[]
  finishReason?: string
  stepCount?: number
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
  capabilitySnapshot(): AgentCapabilitySnapshot
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
  const toolPolicy = resolveAgentToolPolicy(options.policyProfile, {
    approvalPolicy: options.approvalPolicy,
    allowedToolNames: options.allowedToolNames,
    blockedToolNames: options.blockedToolNames,
    alwaysAvailableToolNames: options.alwaysAvailableToolNames,
  })
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
    mcpEndpoint: options.mcpEndpoint,
    imageGenerator: options.imageGenerator,
    draftId: options.draftId,
    dailyCreationRunId: options.dailyCreationRunId,
    skillName,
    restoredSkillName,
    approvalPolicy: toolPolicy.approvalPolicy,
    blockedToolNames: toolPolicy.blockedToolNames,
    beforeToolExecute: options.beforeToolExecute,
    onToolAudit: options.onToolAudit,
  })
  let registry = await deps.openTools(toolOptions(
    selected?.skill.name,
    !automaticSelection && !selected ? options.restoredSkillName : undefined,
  ))

  const visibleTools = () => {
    if (!toolPolicy.allowedToolNames) return registry.tools
    const allowed = new Set(toolPolicy.allowedToolNames)
    return Object.fromEntries(
      Object.entries(registry.tools).filter(([name]) => allowed.has(name)),
    ) as ToolSet
  }

  const capabilitySnapshot = () => {
    const capabilityContext = registry.capabilityContext?.()
    const activeContext = registry.activeContext()
    const skill: SkillCapabilityInput | undefined = capabilityContext ?? (activeContext
      ? {
          skill: activeContext.skill,
          references: activeContext.references,
          activation: activeContext.activation,
          loadedReferences: [],
        }
      : undefined)
    return buildAgentCapabilitySnapshot({
      mode: options.mode ?? 'chat',
      skill,
      tools: visibleTools(),
      approvalPolicy: toolPolicy.approvalPolicy,
      allowedToolNames: toolPolicy.allowedToolNames,
    })
  }

  type GenerateInput = Parameters<typeof generateText>[0]

  const jsonSafe = (value: unknown): unknown => {
    if (value === undefined) return undefined
    try {
      return JSON.parse(JSON.stringify(value))
    } catch {
      return String(value)
    }
  }

  const modelRequestPayload = (input: GenerateInput): Record<string, unknown> => {
    const record = input as Record<string, unknown>
    const tools = record.tools
    return {
      system: jsonSafe(record.system),
      prompt: jsonSafe(record.prompt),
      instructions: jsonSafe(record.instructions),
      messages: jsonSafe(record.messages),
      activeTools: jsonSafe(record.activeTools),
      toolNames: tools && typeof tools === 'object' ? Object.keys(tools) : [],
      structuredOutput: record.output !== undefined,
    }
  }

  const modelResponsePayload = (result: unknown): Record<string, unknown> => {
    const record = result as Record<string, unknown>
    return {
      text: jsonSafe(record.text),
      output: jsonSafe(record.output),
      content: jsonSafe(record.content),
      reasoning: jsonSafe(record.reasoning),
      toolCalls: jsonSafe(record.toolCalls),
      toolResults: jsonSafe(record.toolResults),
      finishReason: jsonSafe(record.finishReason),
      usage: jsonSafe(record.usage),
    }
  }

  const emitMessage = async (
    phase: string,
    direction: AgentModelMessageEvent['direction'],
    payload: Record<string, unknown>,
  ) => {
    try {
      await options.onMessage?.({
        phase, direction, payload, occurredAt: new Date().toISOString(),
      })
    } catch {
      // Observability must not turn a successful Agent operation into a failed job.
    }
  }

  const generateWithMessageLog = async (input: GenerateInput, phase: string) => {
    await emitMessage(phase, 'model_request', modelRequestPayload(input))
    try {
      const result = await deps.generate(input)
      await emitMessage(phase, 'model_response', modelResponsePayload(result))
      return result
    } catch (error) {
      await emitMessage(phase, 'model_error', {
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  async function prepare(objective: string) {
    if (prepared) return selected
    const enabledSkills = await deps.listEnabledSkills()
    const choice = await selectSkillForTurn({
      enabledSkills,
      userRequest: objective,
      restoredSkillName: options.restoredSkillName,
      decide: async ({ prompt }) => {
        const decision = await generateWithMessageLog({
          model: options.model,
          prompt,
          output: Output.json(),
        }, 'skill_selection')
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
    const alwaysAvailableTools = [...new Set(toolPolicy.alwaysAvailableToolNames ?? [])]
    const adapterRequiredTools = [...new Set(request.requiredTools ?? [])]
    const tools = visibleTools()
    const unavailableTool = [...alwaysAvailableTools, ...adapterRequiredTools]
      .find(name => !tools[name])
    if (unavailableTool) {
      throw new Error(`Required Agent tool is unavailable: ${unavailableTool}`)
    }
    if (!active) {
      const generated = await generateWithMessageLog({
        model: options.model,
        instructions: `The enabled Skill catalog is available below. Decide yourself whether a Skill is relevant to the task. Call loadSkill only when it helps; otherwise continue without activating a Skill. Skill selection is not a prerequisite for completing the task.\n\n${registry.catalogContext}`,
        messages: request.modelMessages,
        tools,
        stopWhen: stepCountIs(request.maxSteps),
      }, 'execute')
      const parts = executionParts({
        toolResults: generated.toolResults as Array<Record<string, unknown>>,
        content: generated.content as Array<Record<string, unknown>>,
      })
      await request.onStep?.({ phase: 'execute', parts })
      const selectedAfterExecution = registry.activeContext()
      return {
        kind: 'completed', text: generated.text, parts, revisionCount: 0,
        finishReason: generated.finishReason,
        stepCount: Array.isArray(generated.steps) ? generated.steps.length : 0,
        selectedSkill: selectedAfterExecution
          ? { name: selectedAfterExecution.skill.name, activation: selectedAfterExecution.activation }
          : undefined,
      }
    }

    const activeReferences = registry.activeContext()?.references ?? []
    const availablePlanningTools = planningTools(tools)
    const planCatalogs = {
      referencePaths: activeReferences.map(reference => reference.path),
      toolNames: availablePlanningTools.map(tool => tool.name),
    }
    const validPlan = (input: unknown) => {
      const parsed = skillRunPlanInputSchema.safeParse(input)
      if (!parsed.success) return undefined
      try {
        sanitizeSkillRunPlan(parsed.data, planCatalogs)
        return parsed.data
      } catch {
        return undefined
      }
    }

    const result = await executeSkillRunWithAiSdk({
      skill: active.skill,
      activation: active.activation,
      userRequest: request.objective,
      selectedContext: request.selectedContext ?? '',
      references: activeReferences,
      tools: availablePlanningTools,
      plan: async ({ prompt }) => {
        const planned = await generateWithMessageLog(
          { model: options.model, prompt, output: Output.json() }, 'plan',
        )
        let plan = validPlan(planned.output)
        if (!plan) {
          const repaired = await generateWithMessageLog({
            model: options.model,
            prompt: `${prompt}\n\nRepair the previous Skill plan. Its JSON shape or catalog usage was invalid. Every step id must be a string. requiredReferences may contain only these exact paths: ${JSON.stringify(planCatalogs.referencePaths)}. requiredTools may contain only these exact tool names: ${JSON.stringify(planCatalogs.toolNames)}. Reference loading is represented by requiredReferences, never by inventing a reference-loader tool. Remove unknown fields and return the complete repaired plan.\n\nPrevious JSON:\n${JSON.stringify(planned.output)}`,
            output: Output.json(),
          }, 'plan')
          plan = validPlan(repaired.output)
          if (!plan) throw new Error('Invalid Skill plan after repair')
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
        const activeTools = [...new Set([
          ...requiredTools,
          ...adapterRequiredTools,
          ...alwaysAvailableTools,
        ])]
        const generated = await generateWithMessageLog({
          model: options.model,
          instructions: prompt,
          messages: request.modelMessages,
          tools,
          activeTools,
          stopWhen: stepCountIs(request.maxSteps),
        }, 'execute')
        const parts = executionParts({
          toolResults: generated.toolResults as Array<Record<string, unknown>>,
          content: generated.content as Array<Record<string, unknown>>,
        })
        await request.onStep?.({ phase: 'execute', parts })
        return {
          text: generated.text,
          parts,
          toolResults: generated.toolResults as unknown[],
        }
      },
      validate: async ({ text, run, loadedReferences, toolResults }) => {
        const prompt = `Return valid JSON only in exactly this shape: {"passed": boolean, "violations": [{"requirement": string, "evidence": string, "correction": string}]}. A passing result must use an empty violations array. Validate the candidate strictly against every dynamic requirement and verification criterion. Use the actual runtime tool audit and tool results below as evidence; do not claim that a tool result is unavailable when it is present. Quote concrete candidate or tool-result evidence for each violation.\n\nRequirements:\n${JSON.stringify(run.outputRequirements)}\n\nVerification criteria:\n${JSON.stringify(run.verificationCriteria)}\n\nLoaded references:\n${JSON.stringify(loadedReferences)}\n\nTool audit:\n${JSON.stringify(run.toolEvidence)}\n\nTool results:\n${JSON.stringify(toolResults)}\n\nCandidate:\n${text}`
        const checked = await generateWithMessageLog(
          { model: options.model, prompt, output: Output.json() }, 'validate',
        )
        const parsed = skillRunValidationSchema.safeParse(checked.output)
        let validation
        if (parsed.success) validation = parsed.data
        else {
          const repaired = await generateWithMessageLog({
            model: options.model,
            prompt: `${prompt}\n\nThe previous JSON was invalid. Repair its shape without changing the substantive judgment.\n\nPrevious JSON:\n${JSON.stringify(checked.output)}`,
            output: Output.json(),
          }, 'validate')
          validation = skillRunValidationSchema.parse(repaired.output)
        }
        await request.onStep?.({ phase: 'validate', detail: validation })
        return validation
      },
      revise: async ({ text, run, loadedReferences, toolResults, violations }) => {
        const revised = await generateWithMessageLog({
          model: options.model,
          prompt: `Revise the candidate once. Use only the supplied evidence, satisfy every requirement, and correct every violation. Return only the revised deliverable.\n\nRequirements:\n${JSON.stringify(run.outputRequirements)}\n\nVerification criteria:\n${JSON.stringify(run.verificationCriteria)}\n\nLoaded references:\n${JSON.stringify(loadedReferences)}\n\nTool audit:\n${JSON.stringify(run.toolEvidence)}\n\nTool results:\n${JSON.stringify(toolResults)}\n\nViolations:\n${JSON.stringify(violations)}\n\nCandidate:\n${text}`,
        }, 'revise')
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
    get tools() { return visibleTools() },
    get catalogContext() { return registry.catalogContext },
    get selectedSkill() { return selected },
    prepare,
    run,
    snapshot: () => registry.snapshot(),
    activeContext: () => registry.activeContext(),
    capabilitySnapshot,
    readReferences: paths => registry.readReferences(paths),
    close: () => registry.close(),
  }
}
