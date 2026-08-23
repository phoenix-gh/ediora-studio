import { NextResponse } from 'next/server'

import { discoverSkills } from '@/lib/ai/discover-skills'
import { resolveSkillBinding } from '@/lib/skills/bindings'

export async function GET() {
  const skills = await discoverSkills()
  return NextResponse.json(skills.map(({ name, description, version }) => {
    const binding = resolveSkillBinding({ name, description })
    return {
      name,
      description,
      version,
      displayName: binding.displayName,
      parameterKind: binding.parameter?.kind ?? null,
      parameterRequired: binding.parameter?.required ?? false,
      primaryOutput: binding.primaryOutput,
      capabilityProfile: binding.capabilityProfile,
    }
  }))
}
