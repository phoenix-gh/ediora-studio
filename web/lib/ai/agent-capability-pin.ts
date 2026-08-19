import type { AgentCapabilitySnapshot } from './agent-capabilities'
import { isAgentCapabilitySnapshot } from './agent-capabilities'

type PersistedExecution = {
  capability_pin?: AgentCapabilitySnapshot | null
  skill_name?: string | null
  audit?: Record<string, unknown>
}

export function capabilityPinFromExecution(
  execution: PersistedExecution,
): AgentCapabilitySnapshot | undefined {
  const audit = execution.audit ?? {}
  return [
    execution.capability_pin,
    audit.capabilityPin,
    audit.capabilities,
  ].find(isAgentCapabilitySnapshot)
}

export function restoredSkillNameFromExecution(
  execution: PersistedExecution,
): string | undefined {
  const direct = execution.skill_name?.trim()
  if (direct) return direct
  const audit = execution.audit ?? {}
  for (const key of ['skillRun', 'skill_run']) {
    const value = audit[key]
    if (!value || typeof value !== 'object') continue
    const skillName = (value as Record<string, unknown>).skillName
    if (typeof skillName === 'string' && skillName.trim()) return skillName.trim()
  }
  return undefined
}
