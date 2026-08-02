import type { RegisteredSkill, SkillReference, SkillReferenceContent } from '../skills/registry'
import type { SkillRunPlan } from './skill-run'

type PlanningTool = {
  name: string
  description: string
}

type SkillPlanPromptInput = {
  skill: RegisteredSkill
  userRequest: string
  selectedContext?: string
  references: SkillReference[]
  tools: PlanningTool[]
}

function bulletCatalog(items: string[]) {
  return items.length ? items.map(item => `- ${item}`).join('\n') : '- None'
}

export function buildSkillPlanPrompt({
  skill,
  userRequest,
  selectedContext = '',
  references,
  tools,
}: SkillPlanPromptInput) {
  return `Create a bounded execution plan for the active Skill and current user request. Return valid JSON only.

Use only exact reference paths and tool names from the catalogs. Include only references and tools that are applicable to this request. Do not treat loading a reference as proof that its rules were followed. User instructions override Skill defaults, but no plan may weaken truthfulness, tool approval, or platform safety.

Return this structured shape:
- goal: one concrete goal
- steps: 1 to 12 steps with id, instruction, requiredReferences, and requiredTools. Every id must be a string such as "step-1", never a number
- outputRequirements: requirements that the delivered result must satisfy
- verificationCriteria: checks that determine whether the result is acceptable

Current user request:
${userRequest}

Selected context:
${selectedContext || '(none)'}

Active Skill: ${skill.name}
${skill.instructions}

Available reference paths:
${bulletCatalog(references.map(reference => reference.path))}

Available tools:
${bulletCatalog(tools.map(tool => `${tool.name}: ${tool.description}`))}`
}

export async function loadPlannedReferences(
  plan: SkillRunPlan,
  readReferences: (paths: string[]) => Promise<SkillReferenceContent[]>,
) {
  const paths = [...new Set(plan.steps.flatMap(step => step.requiredReferences))]
  if (paths.length === 0) return []
  return readReferences(paths)
}
