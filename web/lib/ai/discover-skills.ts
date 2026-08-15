import { listEnabledSkills } from '../skills/registry'

export type DiscoveredSkill = {
  name: string
  description: string
  version: string
  instructions: string
}

export async function discoverSkills(): Promise<DiscoveredSkill[]> {
  const skills = await listEnabledSkills()
  return skills.map(({ name, description, version, instructions }) => ({ name, description, version, instructions }))
}
