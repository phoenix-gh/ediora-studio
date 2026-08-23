import type { RegisteredSkill } from './registry'

function escapeXmlAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function formatSkillInvocation(
  skill: Pick<RegisteredSkill, 'name' | 'content'>,
  additionalInstructions?: string,
): string {
  const escapedName = escapeXmlAttribute(skill.name)
  const location = `skill://${escapedName}/SKILL.md`
  const content = skill.content.endsWith('\n') ? skill.content : `${skill.content}\n`
  const block = `<skill name="${escapedName}" location="${location}">\n`
    + `References are relative to skill://${escapedName}/.\n\n`
    + `${content}</skill>`
  return additionalInstructions?.trim()
    ? `${block}\n\n${additionalInstructions}`
    : block
}
