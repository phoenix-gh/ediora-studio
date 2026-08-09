import { z } from 'zod'
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai'

import type { RegisteredSkill, SkillReference, SkillReferenceContent } from '../skills/registry'
import { createSkillRun, sanitizeSkillRunPlan, type SkillRunActivation, type SkillRunValidation } from './skill-run'
import { applyReferenceEvidence, applyToolEvidence } from './skill-run-evidence'
import { completeSkillRun } from './skill-run-orchestrator'
import { buildSkillPlanPrompt, loadPlannedReferences } from './skill-run-planner'

const skillSelectionSchema = z.object({
  skillName: z.preprocess(
    value => value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value,
    z.string().min(1).max(80).optional(),
  ),
  continueRestored: z.boolean().default(false),
}).strict()

const skillSelectionToolEnvelopeSchema = z.object({
  tool: z.literal('loadSkill'),
  arguments: z.object({
    name: z.preprocess(
      value => value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value,
      z.string().min(1).max(200).optional(),
    ),
    skillName: z.preprocess(
      value => value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value,
      z.string().min(1).max(80).optional(),
    ),
    continueRestored: z.boolean().optional(),
  }).passthrough(),
}).strict()

type SkillSelection = z.infer<typeof skillSelectionSchema>

function parseSkillSelection(value: unknown): SkillSelection | undefined {
  const direct = skillSelectionSchema.safeParse(value)
  if (direct.success) return direct.data

  const toolEnvelope = skillSelectionToolEnvelopeSchema.safeParse(value)
  if (!toolEnvelope.success) return undefined
  return skillSelectionSchema.parse({
    skillName: toolEnvelope.data.arguments.skillName ?? toolEnvelope.data.arguments.name,
    continueRestored: toolEnvelope.data.arguments.continueRestored ?? false,
  })
}

function serializedSelection(value: unknown) {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

export async function selectSkillForTurn({
  enabledSkills,
  userRequest,
  restoredSkillName,
  decide,
}: {
  enabledSkills: RegisteredSkill[]
  userRequest: string
  restoredSkillName?: string
  decide(input: { prompt: string }): Promise<unknown>
}): Promise<{ skillName: string; activation: SkillRunActivation } | undefined> {
  const catalog = enabledSkills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n') || '- None'
  const prompt = `Return valid JSON only. Select at most one enabled Skill for the current request. Return exactly this shape: {"skillName": string|null, "continueRestored": boolean}. Return no skillName when none clearly matches. Continue a restored Skill only when the current request is a related follow-up. Do not return a tool-call envelope such as {"tool":"loadSkill","arguments":{...}} and do not call tools during Skill selection.\n\nRequest:\n${userRequest}\n\nRestored Skill:\n${restoredSkillName ?? '(none)'}\n\nEnabled Skills:\n${catalog}`
  const initial = await decide({ prompt })
  let decision = parseSkillSelection(initial)
  if (!decision) {
    const repaired = await decide({
      prompt: `${prompt}\n\nRepair the previous selector response. Remove unknown fields and return only the exact JSON shape requested above.\n\nPrevious selector response:\n${serializedSelection(initial)}`,
    })
    decision = parseSkillSelection(repaired)
    if (!decision) throw new Error('Invalid Skill selection response after repair')
  }
  const enabledNames = new Set(enabledSkills.map(skill => skill.name))
  if (decision.skillName && !enabledNames.has(decision.skillName)) throw new Error('Invalid Skill selection')
  if (decision.continueRestored) {
    if (!restoredSkillName || decision.skillName !== restoredSkillName || !enabledNames.has(restoredSkillName)) {
      throw new Error('Invalid Skill selection')
    }
    return { skillName: restoredSkillName, activation: 'restored' }
  }
  if (!decision.skillName) return undefined
  return { skillName: decision.skillName, activation: 'automatic' }
}

type PlanningTool = { name: string; description: string }
type ExecutionResult = { text: string; parts: unknown[]; toolResults?: unknown[] }

type ExecuteSkillRunOptions = {
  skill: RegisteredSkill
  activation: SkillRunActivation
  userRequest: string
  selectedContext: string
  references: SkillReference[]
  tools: PlanningTool[]
  plan(input: { prompt: string }): Promise<unknown>
  readReferences(paths: string[]): Promise<SkillReferenceContent[]>
  execute(input: {
    prompt: string
    loadedReferences: SkillReferenceContent[]
    requiredTools: string[]
  }): Promise<ExecutionResult>
  validate(input: {
    text: string
    run: ReturnType<typeof createSkillRun>
    loadedReferences: SkillReferenceContent[]
    toolResults: unknown[]
  }): Promise<SkillRunValidation>
  revise(input: {
    text: string
    run: ReturnType<typeof createSkillRun>
    loadedReferences: SkillReferenceContent[]
    toolResults: unknown[]
    violations: SkillRunValidation['violations']
  }): Promise<string>
}

function hasPendingApproval(parts: unknown[]) {
  return parts.some(part => Boolean(
    part && typeof part === 'object' && (part as Record<string, unknown>).state === 'approval-requested',
  ))
}

function executionPrompt({
  userRequest,
  selectedContext,
  skill,
  requirements,
  verification,
}: {
  userRequest: string
  selectedContext: string
  skill: RegisteredSkill
  requirements: string[]
  verification: string[]
}) {
  return `Execute the validated Skill plan. Use collected tool and reference evidence; do not claim a tool, action, or reference succeeded without evidence.\n\nUser request:\n${userRequest}\n\nSelected context:\n${selectedContext || '(none)'}\n\nSkill instructions:\n${skill.instructions}\n\nOutput requirements:\n${requirements.map(item => `- ${item}`).join('\n')}\n\nVerification criteria:\n${verification.map(item => `- ${item}`).join('\n')}`
}

export async function executeSkillRunWithAiSdk(options: ExecuteSkillRunOptions) {
  const rawPlan = await options.plan({
    prompt: buildSkillPlanPrompt({
      skill: options.skill,
      userRequest: options.userRequest,
      selectedContext: options.selectedContext,
      references: options.references,
      tools: options.tools,
    }),
  })
  const plan = sanitizeSkillRunPlan(rawPlan, {
    referencePaths: options.references.map(reference => reference.path),
    toolNames: options.tools.map(tool => tool.name),
  })
  let run = createSkillRun(options.skill.name, plan, options.activation)
  const loadedReferences = await loadPlannedReferences(plan, options.readReferences)
  run = applyReferenceEvidence(run, loadedReferences.map(reference => reference.path))

  const execution = await options.execute({
    prompt: executionPrompt({
      userRequest: options.userRequest,
      selectedContext: options.selectedContext,
      skill: options.skill,
      requirements: plan.outputRequirements,
      verification: plan.verificationCriteria,
    }),
    loadedReferences,
    requiredTools: run.requiredTools,
  })
  if (hasPendingApproval(execution.parts)) {
    return { kind: 'approval' as const, parts: execution.parts, run }
  }
  run = applyToolEvidence(run, execution.parts)

  const completed = await completeSkillRun({
    run,
    draft: async () => execution.text,
    validate: async ({ run: currentRun, text, toolResults }) => options.validate({
      text,
      run: currentRun,
      loadedReferences,
      toolResults: toolResults ?? execution.toolResults ?? execution.parts,
    }),
    revise: async ({ run: currentRun, text, violations }) => options.revise({
      text,
      run: currentRun,
      loadedReferences,
      toolResults: execution.toolResults ?? execution.parts,
      violations,
    }),
  })
  return { kind: 'completed' as const, completed }
}

type SkillRunExecutionResult = Awaited<ReturnType<typeof executeSkillRunWithAiSdk>>

export function skillRunUIResponse(result: SkillRunExecutionResult) {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      if (result.kind === 'completed') {
        const id = 'skill-run-final'
        writer.write({ type: 'text-start', id })
        writer.write({ type: 'text-delta', id, delta: result.completed.text })
        writer.write({ type: 'text-end', id })
        return
      }

      for (const part of result.parts) {
        if (!part || typeof part !== 'object') continue
        const record = part as Record<string, unknown>
        const toolName = typeof record.toolName === 'string' ? record.toolName : undefined
        const toolCallId = typeof record.toolCallId === 'string' ? record.toolCallId : undefined
        if (!toolName || !toolCallId) continue
        writer.write({ type: 'tool-input-available', toolName, toolCallId, input: record.input, dynamic: true })
        const approval = record.approval
        const approvalId = approval && typeof approval === 'object'
          ? (approval as Record<string, unknown>).id
          : record.approvalId
        if (typeof approvalId === 'string') {
          writer.write({ type: 'tool-approval-request', toolCallId, approvalId })
        }
      }
    },
  })
  return createUIMessageStreamResponse({ stream })
}
