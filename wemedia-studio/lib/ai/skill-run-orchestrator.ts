import {
  skillRunValidationSchema,
  type SkillRun,
  type SkillRunValidation,
} from './skill-run'
import { applyOutputEvidence, incompleteRequiredSteps } from './skill-run-evidence'

type DraftInput = { run: SkillRun }
type ValidationInput = { run: SkillRun; text: string }
type RevisionInput = ValidationInput & { violations: SkillRunValidation['violations'] }

type CompleteSkillRunOptions = {
  run: SkillRun
  draft(input: DraftInput): Promise<string>
  validate(input: ValidationInput): Promise<SkillRunValidation>
  revise(input: RevisionInput): Promise<string>
}

export type CompletedSkillRun = {
  text: string
  delivery: 'ready' | 'blocked'
  validation: SkillRunValidation
  revisionCount: 0 | 1
  run: SkillRun
}

function blockedText(validation: SkillRunValidation) {
  if (validation.violations.length === 0) return '本次 Skill 执行未通过验证，未交付未经验证的结果。'
  return `本次 Skill 执行未满足以下要求：\n${validation.violations
    .map(violation => `- ${violation.requirement}：${violation.correction}`)
    .join('\n')}`
}

function blockedResult(run: SkillRun, validation: SkillRunValidation, revisionCount: 0 | 1): CompletedSkillRun {
  const updated = { ...run, validation }
  return {
    text: blockedText(validation),
    delivery: 'blocked',
    validation,
    revisionCount,
    run: updated,
  }
}

function runtimeViolation(requirement: string, evidence: string, correction: string): SkillRunValidation {
  return { passed: false, violations: [{ requirement, evidence, correction }] }
}

async function safeValidation(
  validate: CompleteSkillRunOptions['validate'],
  input: ValidationInput,
) {
  try {
    return { validation: skillRunValidationSchema.parse(await validate(input)), errored: false }
  } catch {
    return {
      validation: runtimeViolation('验证未完成', '验证器没有返回有效结果', '重试并完成 Skill 验证'),
      errored: true,
    }
  }
}

export async function completeSkillRun({
  run,
  draft,
  validate,
  revise,
}: CompleteSkillRunOptions): Promise<CompletedSkillRun> {
  const incompleteDependencies = incompleteRequiredSteps(run).filter(step => (
    step.requiredReferences.length > 0 || step.requiredTools.length > 0
  ))
  if (incompleteDependencies.length > 0) {
    return blockedResult(run, runtimeViolation(
      '必要工作流步骤未完成',
      incompleteDependencies.map(step => step.id).join(', '),
      `完成步骤：${incompleteDependencies.map(step => step.id).join(', ')}`,
    ), 0)
  }

  let text: string
  try {
    text = (await draft({ run })).trim()
  } catch {
    text = ''
  }
  if (!text) {
    return blockedResult(run, runtimeViolation('生成有效结果', '初稿为空', '重新生成非空结果'), 0)
  }

  const firstResult = await safeValidation(validate, { run, text })
  const firstValidation = firstResult.validation
  if (firstResult.errored) return blockedResult(run, firstValidation, 0)
  if (firstValidation.passed) {
    const acceptedRun = applyOutputEvidence({ ...run, validation: firstValidation }, text)
    return { text, delivery: 'ready', validation: firstValidation, revisionCount: 0, run: acceptedRun }
  }

  let revisedText: string
  try {
    revisedText = (await revise({ run, text, violations: firstValidation.violations })).trim()
  } catch {
    revisedText = ''
  }
  if (!revisedText) {
    return blockedResult(run, runtimeViolation('生成有效修订结果', '修订结果为空', '根据违规清单重新修订'), 1)
  }

  const secondValidation = (await safeValidation(validate, { run, text: revisedText })).validation
  if (!secondValidation.passed) return blockedResult(run, secondValidation, 1)

  const acceptedRun = applyOutputEvidence({ ...run, validation: secondValidation }, revisedText)
  return {
    text: revisedText,
    delivery: 'ready',
    validation: secondValidation,
    revisionCount: 1,
    run: acceptedRun,
  }
}
