import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type DiscoveredSkill = {
  name: string
  description: string
  version: string
  instructions: string
}

function frontmatterValue(frontmatter: string, key: string) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? ''
}

export async function discoverSkills(): Promise<DiscoveredSkill[]> {
  const root = join(process.cwd(), 'skills')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const skills = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    try {
      const instructions = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8')
      const frontmatter = instructions.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] ?? ''
      const name = frontmatterValue(frontmatter, 'name')
      return name ? { name, description: frontmatterValue(frontmatter, 'description'), version: frontmatterValue(frontmatter, 'version'), instructions } : null
    } catch {
      return null
    }
  }))
  return skills.filter((skill): skill is DiscoveredSkill => skill !== null).sort((a, b) => a.name.localeCompare(b.name))
}
