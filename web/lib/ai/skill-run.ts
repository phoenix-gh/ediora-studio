import { z } from 'zod'

const boundedText = z.string().trim().min(1).max(2_000)
const identifier = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/)
const catalogName = z.string().trim().min(1).max(500)

export const skillRunPlanStepInputSchema = z.object({
  id: identifier,
  instruction: boundedText,
  requiredReferences: z.array(catalogName).max(24),
  requiredTools: z.array(catalogName).max(24),
}).strict()

export const skillRunPlanInputSchema = z.object({
  goal: boundedText,
  steps: z.array(skillRunPlanStepInputSchema).min(1).max(12),
  outputRequirements: z.array(boundedText).max(24),
  verificationCriteria: z.array(boundedText).max(24),
}).strict()

export const skillRunViolationSchema = z.object({
  requirement: boundedText,
  evidence: boundedText,
  correction: boundedText,
}).strict()

export const skillRunValidationSchema = z.object({
  passed: z.boolean(),
  violations: z.array(skillRunViolationSchema).max(24),
}).strict().superRefine((value, context) => {
  if (value.passed && value.violations.length > 0) {
    context.addIssue({ code: 'custom', message: 'A passing validation cannot contain violations' })
  }
})

export type SkillRunActivation = 'manual' | 'automatic' | 'restored'
export type SkillRunStepStatus = 'pending' | 'completed' | 'failed' | 'skipped'
export type SkillRunValidation = z.infer<typeof skillRunValidationSchema>

export type SkillRunStep = z.infer<typeof skillRunPlanStepInputSchema> & {
  status: SkillRunStepStatus
  evidence: string[]
}

export type SkillRunPlan = Omit<z.infer<typeof skillRunPlanInputSchema>, 'steps'> & {
  steps: SkillRunStep[]
}

export type SkillToolEvidence = {
  stepId: string
  toolName: string
  toolCallId: string
  state: 'succeeded' | 'failed' | 'approval-pending'
}

export type SkillRun = {
  skillName: string
  activation: SkillRunActivation
  goal: string
  steps: SkillRunStep[]
  requiredReferences: string[]
  loadedReferences: string[]
  requiredTools: string[]
  toolEvidence: SkillToolEvidence[]
  outputRequirements: string[]
  verificationCriteria: string[]
  validation: SkillRunValidation
}

type SkillRunCatalogs = {
  referencePaths: string[]
  toolNames: string[]
}

function unique(values: string[]) {
  return [...new Set(values)]
}

export function sanitizeSkillRunPlan(input: unknown, catalogs: SkillRunCatalogs): SkillRunPlan {
  const parsed = skillRunPlanInputSchema.safeParse(input)
  if (!parsed.success) throw new Error('Invalid Skill plan')

  const referencePaths = new Set(catalogs.referencePaths)
  const toolNames = new Set(catalogs.toolNames)
  const stepIds = new Set<string>()
  const steps: SkillRunStep[] = []

  for (const step of parsed.data.steps) {
    if (stepIds.has(step.id)) throw new Error('Invalid Skill plan: duplicate step id')
    stepIds.add(step.id)
    const requiredReferences = unique(step.requiredReferences)
    const requiredTools = unique(step.requiredTools)
    if (requiredReferences.some(path => !referencePaths.has(path))) {
      throw new Error('Invalid Skill plan: unknown reference')
    }
    if (requiredTools.some(name => !toolNames.has(name))) {
      throw new Error('Invalid Skill plan: unknown tool')
    }
    steps.push({ ...step, requiredReferences, requiredTools, status: 'pending', evidence: [] })
  }

  const outputRequirements = unique(parsed.data.outputRequirements)
  const verificationCriteria = unique(parsed.data.verificationCriteria)
  if (outputRequirements.length + verificationCriteria.length > 24) {
    throw new Error('Invalid Skill plan: too many requirements')
  }

  return { goal: parsed.data.goal, steps, outputRequirements, verificationCriteria }
}

export function createSkillRun(skillName: string, plan: SkillRunPlan, activation: SkillRunActivation): SkillRun {
  return {
    skillName,
    activation,
    goal: plan.goal,
    steps: plan.steps.map(step => ({ ...step, evidence: [...step.evidence] })),
    requiredReferences: unique(plan.steps.flatMap(step => step.requiredReferences)),
    loadedReferences: [],
    requiredTools: unique(plan.steps.flatMap(step => step.requiredTools)),
    toolEvidence: [],
    outputRequirements: [...plan.outputRequirements],
    verificationCriteria: [...plan.verificationCriteria],
    validation: { passed: false, violations: [] },
  }
}
