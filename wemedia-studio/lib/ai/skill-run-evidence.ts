import type { SkillRun, SkillRunStep, SkillToolEvidence } from './skill-run'

function cloneRun(run: SkillRun): SkillRun {
  return {
    ...run,
    steps: run.steps.map(step => ({
      ...step,
      requiredReferences: [...step.requiredReferences],
      requiredTools: [...step.requiredTools],
      evidence: [...step.evidence],
    })),
    requiredReferences: [...run.requiredReferences],
    loadedReferences: [...run.loadedReferences],
    requiredTools: [...run.requiredTools],
    toolEvidence: run.toolEvidence.map(item => ({ ...item })),
    outputRequirements: [...run.outputRequirements],
    verificationCriteria: [...run.verificationCriteria],
    validation: {
      ...run.validation,
      violations: run.validation.violations.map(violation => ({ ...violation })),
    },
  }
}

function successfulToolEvidence(run: SkillRun, toolName: string) {
  return run.toolEvidence.find(item => item.toolName === toolName && item.state === 'succeeded')
}

function refreshStep(run: SkillRun, step: SkillRunStep): SkillRunStep {
  const referenceEvidence = step.requiredReferences
    .filter(path => run.loadedReferences.includes(path))
    .map(path => `reference:${path}`)
  const toolEvidence = step.requiredTools.flatMap(toolName => {
    const evidence = successfulToolEvidence(run, toolName)
    return evidence ? [`tool:${toolName}:${evidence.toolCallId}`] : []
  })
  const hasDependencies = step.requiredReferences.length > 0 || step.requiredTools.length > 0
  const outputEvidence = hasDependencies || !step.evidence.includes('output:accepted') ? [] : ['output:accepted']
  const complete = hasDependencies
    ? referenceEvidence.length === step.requiredReferences.length && toolEvidence.length === step.requiredTools.length
    : outputEvidence.length === 1
  return {
    ...step,
    status: complete ? 'completed' : 'pending',
    evidence: [...referenceEvidence, ...toolEvidence, ...outputEvidence],
  }
}

function refreshSteps(run: SkillRun) {
  run.steps = run.steps.map(step => refreshStep(run, step))
  return run
}

export function applyReferenceEvidence(run: SkillRun, paths: string[]) {
  const updated = cloneRun(run)
  const required = new Set(updated.requiredReferences)
  updated.loadedReferences = [...new Set([
    ...updated.loadedReferences,
    ...paths.filter(path => required.has(path)),
  ])]
  return refreshSteps(updated)
}

function toolPartName(record: Record<string, unknown>) {
  if (typeof record.toolName === 'string') return record.toolName
  return typeof record.type === 'string' && record.type.startsWith('tool-')
    ? record.type.slice('tool-'.length)
    : undefined
}

function toolPartState(state: unknown): SkillToolEvidence['state'] | undefined {
  if (state === 'output-available') return 'succeeded'
  if (state === 'output-error') return 'failed'
  if (state === 'approval-requested' || state === 'approval-responded') return 'approval-pending'
  return undefined
}

export function applyToolEvidence(run: SkillRun, parts: unknown[]) {
  const updated = cloneRun(run)
  const requiredTools = new Set(updated.requiredTools)
  const evidence = new Map(updated.toolEvidence.map(item => [`${item.toolName}:${item.toolCallId}`, item]))

  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    const toolName = toolPartName(record)
    const state = toolPartState(record.state)
    if (!toolName || !requiredTools.has(toolName) || !state || typeof record.toolCallId !== 'string') continue
    const item = { toolName, toolCallId: record.toolCallId, state }
    evidence.set(`${toolName}:${record.toolCallId}`, item)
  }

  updated.toolEvidence = [...evidence.values()]
  return refreshSteps(updated)
}

export function applyOutputEvidence(run: SkillRun, text: string) {
  const updated = cloneRun(run)
  if (!text.trim()) return updated
  updated.steps = updated.steps.map(step => (
    step.requiredReferences.length === 0 && step.requiredTools.length === 0
      ? { ...step, evidence: [...new Set([...step.evidence, 'output:accepted'])] }
      : step
  ))
  return refreshSteps(updated)
}

export function incompleteRequiredSteps(run: SkillRun) {
  return run.steps.filter(step => step.status !== 'completed' && step.status !== 'skipped')
}
