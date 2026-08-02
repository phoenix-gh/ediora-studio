import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'

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
  execution?: SkillExecutionHints
}

export type SkillExecutionHints = {
  planRequired: boolean
  verificationRequired: boolean
  maxRevisions: 0 | 1
}

export type SkillManifest = {
  preloadReferences: string[]
  execution: SkillExecutionHints
}

export type SkillReference = {
  path: string
  bytes: number
}

export type SkillReferenceContent = SkillReference & {
  content: string
}

export type SkillContext = {
  name: string
  instructions: string
  references: SkillReferenceContent[]
}

export type SkillRegistryErrorCode =
  | 'not_found'
  | 'conflict'
  | 'forbidden'
  | 'invalid_archive'
  | 'invalid_reference'
  | 'reference_not_found'
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
export const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024
export const MAX_ARCHIVE_FILES = 500
export const MAX_SKILL_REFERENCES = 200
export const MAX_SKILL_REFERENCE_BYTES = 128 * 1024
export const MAX_SKILL_REFERENCE_CONTEXT_BYTES = 512 * 1024
const supportedReferenceExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml'])
const preloadManifestName = 'WMS_SKILL.json'
const defaultExecutionHints: SkillExecutionHints = {
  planRequired: true,
  verificationRequired: true,
  maxRevisions: 1,
}
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

function invalidManifest(): never {
  referenceError('invalid_reference', 'Invalid Skill preload manifest')
}

async function readManifestFromDirectory(directory: string): Promise<SkillManifest> {
  const manifestPath = join(directory, preloadManifestName)
  let manifestBytes: Buffer
  try {
    const metadata = await lstat(manifestPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) invalidManifest()
    if (metadata.size > MAX_SKILL_REFERENCE_BYTES) {
      throw new SkillRegistryError('too_large', 'Skill preload manifest is too large')
    }
    manifestBytes = await readFile(manifestPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { preloadReferences: [], execution: { ...defaultExecutionHints } }
    }
    if (error instanceof SkillRegistryError) throw error
    referenceError('invalid_reference', 'Unable to read Skill preload manifest')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes))
  } catch {
    invalidManifest()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalidManifest()
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'preloadReferences' && key !== 'execution')) invalidManifest()
  const paths = record.preloadReferences ?? []
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) invalidManifest()
  const uniquePaths = [...new Set(paths as string[])]
  if (uniquePaths.length > MAX_SKILL_REFERENCES) {
    throw new SkillRegistryError('too_large', `Skill contains more than ${MAX_SKILL_REFERENCES} preload references`)
  }

  const executionValue = record.execution
  if (executionValue !== undefined && (!executionValue || typeof executionValue !== 'object' || Array.isArray(executionValue))) invalidManifest()
  const executionRecord = (executionValue ?? {}) as Record<string, unknown>
  if (Object.keys(executionRecord).some(key => !['planRequired', 'verificationRequired', 'maxRevisions'].includes(key))) invalidManifest()
  const planRequired = executionRecord.planRequired ?? defaultExecutionHints.planRequired
  const verificationRequired = executionRecord.verificationRequired ?? defaultExecutionHints.verificationRequired
  const maxRevisions = executionRecord.maxRevisions ?? defaultExecutionHints.maxRevisions
  if (typeof planRequired !== 'boolean' || typeof verificationRequired !== 'boolean' || (maxRevisions !== 0 && maxRevisions !== 1)) invalidManifest()

  return {
    preloadReferences: uniquePaths,
    execution: { planRequired, verificationRequired, maxRevisions },
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
  return {
    name: record.name,
    description: record.description,
    version: record.version,
    source: record.source,
    enabled: record.enabled,
  }
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

function referenceError(code: 'invalid_reference' | 'reference_not_found', message: string): never {
  throw new SkillRegistryError(code, message)
}

async function enabledSkillOrThrow(name: string) {
  const skill = await getEnabledSkill(name)
  if (!skill) throw new SkillRegistryError('not_found', `Skill unavailable: ${name}`)
  return skill
}

function validatedReferenceParts(referencePath: string) {
  if (!referencePath || referencePath.includes('\0') || referencePath.includes('\\') || isAbsolute(referencePath)) {
    referenceError('invalid_reference', 'Invalid Skill reference path')
  }
  const parts = referencePath.split('/')
  if (
    parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))
    || parts.at(-1) === 'SKILL.md'
    || !supportedReferenceExtensions.has(extname(parts.at(-1) ?? '').toLowerCase())
  ) referenceError('invalid_reference', 'Invalid Skill reference path')
  return parts
}

function isInsideDirectory(root: string, target: string) {
  const pathFromRoot = relative(root, target)
  return pathFromRoot !== '' && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(pathFromRoot)
}

async function safeReferenceTarget(skillDirectory: string, referencePath: string) {
  const parts = validatedReferenceParts(referencePath)
  let current = skillDirectory
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let metadata
    try {
      metadata = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        referenceError('reference_not_found', `Skill reference not found: ${referencePath}`)
      }
      throw error
    }
    if (metadata.isSymbolicLink()) referenceError('invalid_reference', 'Skill reference symlinks are not allowed')
    const final = index === parts.length - 1
    if ((!final && !metadata.isDirectory()) || (final && !metadata.isFile())) {
      referenceError('reference_not_found', `Skill reference not found: ${referencePath}`)
    }
  }
  const [rootPath, targetPath] = await Promise.all([realpath(skillDirectory), realpath(current)])
  if (!isInsideDirectory(rootPath, targetPath)) referenceError('invalid_reference', 'Skill reference escapes its Skill directory')
  return current
}

export function skillReferenceContextByteLimit() {
  return configuredLimit('WMS_SKILLS_MAX_REFERENCE_CONTEXT_BYTES', MAX_SKILL_REFERENCE_CONTEXT_BYTES)
}

export async function listSkillReferences(name: string): Promise<SkillReference[]> {
  const skill = await enabledSkillOrThrow(name)
  const maxReferences = configuredLimit('WMS_SKILLS_MAX_REFERENCES', MAX_SKILL_REFERENCES)
  const references: SkillReference[] = []

  async function visit(directory: string, prefix: string) {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      const target = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(target, path)
      } else if (
        entry.isFile()
        && entry.name !== 'SKILL.md'
        && path !== 'UPSTREAM.md'
        && path !== preloadManifestName
        && supportedReferenceExtensions.has(extname(entry.name).toLowerCase())
      ) {
        references.push({ path, bytes: (await lstat(target)).size })
        if (references.length > maxReferences) {
          throw new SkillRegistryError('too_large', `Skill contains more than ${maxReferences} references`)
        }
      }
    }
  }

  await visit(skill.directory, '')
  return references.sort((left, right) => left.path.localeCompare(right.path))
}

export async function readSkillReference(name: string, referencePath: string): Promise<SkillReferenceContent> {
  const skill = await enabledSkillOrThrow(name)
  const target = await safeReferenceTarget(skill.directory, referencePath)
  const bytes = await readFile(target)
  const maxBytes = configuredLimit('WMS_SKILLS_MAX_REFERENCE_BYTES', MAX_SKILL_REFERENCE_BYTES)
  if (bytes.byteLength > maxBytes) {
    throw new SkillRegistryError('too_large', `Skill reference exceeds ${maxBytes} bytes`)
  }
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    referenceError('invalid_reference', 'Skill reference must be valid UTF-8')
  }
  if (content.includes('\0')) referenceError('invalid_reference', 'Skill reference contains NUL bytes')
  return { path: referencePath, content, bytes: bytes.byteLength }
}

export async function loadSkillContext(name: string, referencePaths: string[]): Promise<SkillContext> {
  const skill = await enabledSkillOrThrow(name)
  const uniquePaths = [...new Set(referencePaths)]
  const references: SkillReferenceContent[] = []
  let totalBytes = 0
  for (const referencePath of uniquePaths) {
    const reference = await readSkillReference(name, referencePath)
    totalBytes += reference.bytes
    if (totalBytes > skillReferenceContextByteLimit()) {
      throw new SkillRegistryError('too_large', `Skill reference context exceeds ${skillReferenceContextByteLimit()} bytes`)
    }
    references.push(reference)
  }
  return { name: skill.name, instructions: skill.instructions, references }
}

export async function loadSkillPreloadContext(name: string): Promise<SkillContext> {
  const skill = await enabledSkillOrThrow(name)
  const manifest = await readManifestFromDirectory(skill.directory)
  return loadSkillContext(name, manifest.preloadReferences)
}

export async function loadSkillManifest(name: string): Promise<SkillManifest> {
  const skill = await enabledSkillOrThrow(name)
  return readManifestFromDirectory(skill.directory)
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

function configuredLimit(environmentName: string, fallback: number) {
  const configured = Number(process.env[environmentName])
  return Number.isSafeInteger(configured) && configured > 0 ? configured : fallback
}

function invalidArchive(message: string): never {
  throw new SkillRegistryError('invalid_archive', message)
}

function validateArchivePath(name: string) {
  if (!name || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    invalidArchive(`Unsafe ZIP path: ${name}`)
  }
  const directory = name.endsWith('/')
  const parts = name.split('/')
  if (directory) parts.pop()
  if (!parts.length || parts.some(part => !part || part === '.' || part === '..')) {
    invalidArchive(`Unsafe ZIP path: ${name}`)
  }
  return { parts, directory }
}

type CentralEntry = { name: string; originalSize: number; isSymlink: boolean }

function readCentralEntries(buffer: Uint8Array): CentralEntry[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const minimumEndRecord = 22
  const start = Math.max(0, buffer.byteLength - 0xffff - minimumEndRecord)
  let endRecord = -1
  for (let offset = buffer.byteLength - minimumEndRecord; offset >= start; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endRecord = offset
      break
    }
  }
  if (endRecord < 0 || endRecord + 22 > buffer.byteLength) invalidArchive('Invalid ZIP end record')

  const count = view.getUint16(endRecord + 10, true)
  const centralSize = view.getUint32(endRecord + 12, true)
  const centralOffset = view.getUint32(endRecord + 16, true)
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    invalidArchive('ZIP64 archives are not supported')
  }
  if (centralOffset + centralSize > buffer.byteLength) invalidArchive('Invalid ZIP central directory')

  const entries: CentralEntry[] = []
  let cursor = centralOffset
  const decoder = new TextDecoder()
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
      invalidArchive('Invalid ZIP central directory entry')
    }
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const end = cursor + 46 + nameLength + extraLength + commentLength
    if (end > buffer.byteLength) invalidArchive('Truncated ZIP central directory entry')
    const name = decoder.decode(buffer.subarray(cursor + 46, cursor + 46 + nameLength))
    const madeBy = view.getUint16(cursor + 4, true)
    const externalAttributes = view.getUint32(cursor + 38, true)
    const unixMode = (externalAttributes >>> 16) & 0xffff
    entries.push({
      name,
      originalSize: view.getUint32(cursor + 24, true),
      isSymlink: (madeBy >>> 8) === 3 && (unixMode & 0xf000) === 0xa000,
    })
    cursor = end
  }
  return entries
}

type ArchiveSkill = {
  name: string
  description: string
  version: string
  root: string
  files: Array<{ relativePath: string; content: Uint8Array }>
}

function parseArchive(buffer: Uint8Array): ArchiveSkill[] {
  const maxArchiveBytes = configuredLimit('WMS_SKILLS_MAX_ARCHIVE_BYTES', MAX_ARCHIVE_BYTES)
  const maxUnpackedBytes = configuredLimit('WMS_SKILLS_MAX_UNPACKED_BYTES', MAX_UNPACKED_BYTES)
  const maxFiles = configuredLimit('WMS_SKILLS_MAX_FILES', MAX_ARCHIVE_FILES)
  if (buffer.byteLength > maxArchiveBytes) {
    throw new SkillRegistryError('too_large', `ZIP exceeds ${maxArchiveBytes} bytes`)
  }

  const centralEntries = readCentralEntries(buffer)
  if (centralEntries.length > maxFiles) throw new SkillRegistryError('too_large', `ZIP contains more than ${maxFiles} files`)
  const seenPaths = new Set<string>()
  let centralUnpackedBytes = 0
  for (const entry of centralEntries) {
    validateArchivePath(entry.name)
    if (seenPaths.has(entry.name)) invalidArchive(`Duplicate ZIP path: ${entry.name}`)
    seenPaths.add(entry.name)
    if (entry.isSymlink) invalidArchive(`ZIP symlinks are not allowed: ${entry.name}`)
    centralUnpackedBytes += entry.originalSize
    if (centralUnpackedBytes > maxUnpackedBytes) {
      throw new SkillRegistryError('too_large', `ZIP expands beyond ${maxUnpackedBytes} bytes`)
    }
  }

  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(buffer)
  } catch {
    invalidArchive('Unable to read ZIP archive')
  }

  const entries = Object.entries(files)
  if (entries.length > maxFiles) throw new SkillRegistryError('too_large', `ZIP contains more than ${maxFiles} files`)
  const skillPaths = entries
    .map(([name]) => name)
    .filter(name => !name.endsWith('/') && name.split('/').at(-1) === 'SKILL.md')
  if (!skillPaths.length) invalidArchive('ZIP must contain at least one SKILL.md')

  const roots = [...new Set(skillPaths.map(path => path.slice(0, -'SKILL.md'.length).replace(/\/$/, '')))]
  const rootForPath = (path: string) => roots
    .filter(root => path === (root ? `${root}/SKILL.md` : 'SKILL.md') || path.startsWith(root ? `${root}/` : ''))
    .sort((left, right) => right.length - left.length)[0]
  const skills: ArchiveSkill[] = []
  const names = new Set<string>()
  for (const root of roots) {
    const skillPath = root ? `${root}/SKILL.md` : 'SKILL.md'
    const skillFile = files[skillPath]
    if (!skillFile) invalidArchive(`Missing Skill file: ${skillPath}`)
    const metadata = parseSkillMetadata(strFromU8(skillFile))
    if (!metadata) invalidArchive(`Invalid Skill frontmatter: ${skillPath}`)
    if (names.has(metadata.name)) invalidArchive(`Duplicate Skill name: ${metadata.name}`)
    names.add(metadata.name)

    const rootPrefix = root ? `${root}/` : ''
    const matching = entries.filter(([path]) => !path.endsWith('/') && rootForPath(path) === root)
    if (!matching.length) invalidArchive(`Skill directory is empty: ${root || '/'}`)
    skills.push({
      ...metadata,
      root,
      files: matching.filter(([path]) => !path.endsWith('/')).map(([path, content]) => ({
        relativePath: path.slice(rootPrefix.length),
        content,
      })),
    })
  }

  for (const [path] of entries) {
    if (path.endsWith('/')) continue
    if (rootForPath(path) === undefined) {
      invalidArchive(`File is not inside a Skill directory: ${path}`)
    }
  }
  return skills
}

export async function installSkillArchive(buffer: Uint8Array): Promise<ManagedSkill[]> {
  const parsed = parseArchive(buffer)
  return withMutation(async () => {
    const existing = await allRecords()
    const existingNames = new Set(existing.map(skill => skill.name))
    for (const skill of parsed) {
      if (existingNames.has(skill.name)) {
        throw new SkillRegistryError('conflict', `Skill already exists: ${skill.name}`)
      }
    }

    const runtimeRoot = runtimeSkillsDirectory()
    const stagingRoot = join(runtimeRoot, `.install-${randomUUID()}`)
    const movedDirectories: string[] = []
    const originalState = await readState()
    await mkdir(stagingRoot, { recursive: true })
    try {
      for (const skill of parsed) {
        const destination = join(stagingRoot, skill.name)
        await mkdir(destination, { recursive: true })
        for (const file of skill.files) {
          if (!file.relativePath || file.relativePath.includes('/') && file.relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
            invalidArchive(`Unsafe Skill file path: ${file.relativePath}`)
          }
          const target = join(destination, file.relativePath)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, file.content)
        }
      }

      const state = await readState()
      for (const skill of parsed) {
        const target = join(runtimeRoot, skill.name)
        try {
          await readdir(target)
          throw new SkillRegistryError('conflict', `Skill directory already exists: ${skill.name}`)
        } catch (error) {
          if (error instanceof SkillRegistryError) throw error
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await rename(join(stagingRoot, skill.name), target)
        movedDirectories.push(target)
        state[skill.name] = { source: 'uploaded', enabled: true }
      }
      await writeState(state)
      await rm(stagingRoot, { recursive: true, force: true })
      return parsed.map(skill => ({
        name: skill.name,
        description: skill.description,
        version: skill.version,
        source: 'uploaded' as const,
        enabled: true,
      }))
    } catch (error) {
      for (const directory of movedDirectories) await rm(directory, { recursive: true, force: true })
      await rm(stagingRoot, { recursive: true, force: true })
      await writeState(originalState).catch(() => undefined)
      throw error
    }
  })
}

export function isSkillName(value: string) {
  return skillNamePattern.test(value)
}
