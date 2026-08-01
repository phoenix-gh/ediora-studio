import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type SkillSource = 'builtin' | 'uploaded'

export type ManagedSkill = {
  name: string
  description: string
  version: string
  source: SkillSource
  enabled: boolean
}

export type RegisteredSkill = ManagedSkill & {
  instructions: string
  directory: string
}

export type SkillRegistryErrorCode =
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'invalid_archive'
  | 'too_large'

export class SkillRegistryError extends Error {
  constructor(
    readonly code: SkillRegistryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SkillRegistryError'
  }
}

type PersistedSkillState = {
  source: SkillSource
  enabled: boolean
}

type PersistedState = Record<string, PersistedSkillState>

type SkillRecord = ManagedSkill & {
  directory: string
  instructions: string
}

const skillNamePattern = /^[A-Za-z0-9._-]{1,80}$/
let mutationQueue: Promise<void> = Promise.resolve()

function bundledDirectory() {
  return process.env.WMS_SKILLS_BUNDLED_DIR ?? join(process.cwd(), 'skills')
}

function runtimeSkillsDirectory() {
  return process.env.WMS_SKILLS_RUNTIME_DIR ?? join(process.cwd(), '.runtime', 'skills')
}

function stateFile() {
  return process.env.WMS_SKILLS_STATE_FILE ?? join(dirname(runtimeSkillsDirectory()), 'skills-state.json')
}

async function withMutation<T>(operation: () => Promise<T>) {
  const result = mutationQueue.then(operation, operation)
  mutationQueue = result.then(() => undefined, () => undefined)
  return result
}

function readFrontmatterValue(frontmatter: string, key: string) {
  const line = frontmatter
    .split(/\r?\n/)
    .find(candidate => candidate.trimStart().startsWith(`${key}:`))
  if (!line) return ''
  return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '')
}

function parseSkillMetadata(instructions: string) {
  const frontmatter = instructions.match(/^---\s*\n([\s\S]*?)\n---(?:\s|$)/)?.[1] ?? ''
  const name = readFrontmatterValue(frontmatter, 'name')
  if (!name || !skillNamePattern.test(name)) return null
  return {
    name,
    description: readFrontmatterValue(frontmatter, 'description'),
    version: readFrontmatterValue(frontmatter, 'version'),
  }
}

async function readSkill(directory: string, source: SkillSource): Promise<SkillRecord | null> {
  try {
    const instructions = await readFile(join(directory, 'SKILL.md'), 'utf8')
    const metadata = parseSkillMetadata(instructions)
    if (!metadata) return null
    return { ...metadata, source, enabled: true, directory, instructions }
  } catch {
    return null
  }
}

async function discoverFromDirectory(root: string, source: SkillSource) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const records: SkillRecord[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const record = await readSkill(join(root, entry.name), source)
    if (record) records.push(record)
  }
  return records
}

async function readState(): Promise<PersistedState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(stateFile(), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const state: PersistedState = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const candidate = value as Partial<PersistedSkillState>
      if ((candidate.source === 'builtin' || candidate.source === 'uploaded') && typeof candidate.enabled === 'boolean') {
        state[name] = { source: candidate.source, enabled: candidate.enabled }
      }
    }
    return state
  } catch {
    return {}
  }
}

async function writeState(state: PersistedState) {
  const target = stateFile()
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function allRecords() {
  const [bundled, uploaded, state] = await Promise.all([
    discoverFromDirectory(bundledDirectory(), 'builtin'),
    discoverFromDirectory(runtimeSkillsDirectory(), 'uploaded'),
    readState(),
  ])

  const records = new Map<string, SkillRecord>()
  for (const record of [...bundled, ...uploaded]) {
    // Bundled content owns a name if a manually-created runtime directory is inconsistent.
    if (records.has(record.name)) continue
    const saved = state[record.name]
    records.set(record.name, {
      ...record,
      enabled: saved?.source === record.source ? saved.enabled : true,
    })
  }
  return [...records.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function toManagedSkill(record: SkillRecord): ManagedSkill {
  const { directory: _directory, instructions: _instructions, ...metadata } = record
  return metadata
}

export async function listSkills(): Promise<ManagedSkill[]> {
  return (await allRecords()).map(toManagedSkill)
}

export async function listEnabledSkills(): Promise<RegisteredSkill[]> {
  return (await allRecords())
    .filter(record => record.enabled)
    .map(record => ({ ...record }))
}

export async function getEnabledSkill(name: string): Promise<RegisteredSkill | null> {
  const record = (await allRecords()).find(candidate => candidate.name === name)
  if (!record || !record.enabled) return null
  return { ...record }
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<ManagedSkill> {
  return withMutation(async () => {
    const record = (await allRecords()).find(candidate => candidate.name === name)
    if (!record) throw new SkillRegistryError('not_found', `Skill not found: ${name}`)
    const state = await readState()
    state[name] = { source: record.source, enabled }
    await writeState(state)
    return { ...toManagedSkill(record), enabled }
  })
}

export async function deleteUploadedSkill(name: string): Promise<void> {
  return withMutation(async () => {
    const record = (await allRecords()).find(candidate => candidate.name === name)
    if (!record) throw new SkillRegistryError('not_found', `Skill not found: ${name}`)
    if (record.source !== 'uploaded') {
      throw new SkillRegistryError('forbidden', 'Bundled Skills cannot be deleted')
    }

    const temporary = join(runtimeSkillsDirectory(), `.deleting-${randomUUID()}`)
    await rename(record.directory, temporary)
    try {
      const state = await readState()
      delete state[name]
      await writeState(state)
      await rm(temporary, { recursive: true, force: true })
    } catch (error) {
      await rename(temporary, record.directory).catch(() => undefined)
      throw error
    }
  })
}

export async function installSkillArchive(_buffer: Uint8Array): Promise<ManagedSkill[]> {
  throw new SkillRegistryError('invalid_archive', 'ZIP installation is not enabled yet')
}

export function isSkillName(value: string) {
  return skillNamePattern.test(value)
}

