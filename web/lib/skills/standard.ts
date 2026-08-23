import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

const standardNamePattern = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/
const legacyNamePattern = /^[A-Za-z0-9._-]{1,80}$/
const MAX_DESCRIPTION = 1024
const MAX_COMPATIBILITY = 500

export function isStandardSkillName(value: string) {
  return standardNamePattern.test(value)
}

export type SkillDiagnosticCode =
  | 'legacy_name'
  | 'legacy_directory'
  | 'legacy_metadata'

export type SkillDocument = {
  name: string
  description: string
  version: string
  license?: string
  compatibility?: string
  metadata: Readonly<Record<string, string>>
  requestedAllowedTools: readonly string[]
  body: string
  standardCompatible: boolean
  diagnostics: readonly SkillDiagnosticCode[]
}

export type SkillPackageFile = {
  path: string
  bytes: number
  kind: 'reference' | 'asset' | 'script' | 'other'
}

export class SkillDocumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillDocumentError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function fail(message: string): never {
  throw new SkillDocumentError(message)
}

function diagnosticOnce(diagnostics: SkillDiagnosticCode[], code: SkillDiagnosticCode) {
  if (!diagnostics.includes(code)) diagnostics.push(code)
}

function parseFrontmatter(contents: string) {
  const match = contents.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/)
  if (!match) fail('Skill document is missing YAML frontmatter')

  const document = parseDocument(match[1], { uniqueKeys: true })
  if (document.errors.length > 0) {
    fail(`Skill frontmatter is invalid: ${document.errors[0]?.message ?? 'parse error'}`)
  }
  const value = document.toJS() as unknown
  if (!isRecord(value)) fail('Skill frontmatter must be a YAML object')
  return { frontmatter: value, body: contents.slice(match[0].length).trimStart() }
}

function readOptionalString(
  frontmatter: Record<string, unknown>,
  key: string,
  maximum: number,
  allowLegacy: boolean,
  diagnostics: SkillDiagnosticCode[],
) {
  const value = frontmatter[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximum) {
    if (!allowLegacy) fail(`${key} must be a string of at most ${maximum} characters`)
    diagnosticOnce(diagnostics, 'legacy_metadata')
    return undefined
  }
  return value
}

function readMetadata(
  frontmatter: Record<string, unknown>,
  allowLegacy: boolean,
  diagnostics: SkillDiagnosticCode[],
) {
  const rawMetadata = frontmatter.metadata
  if (rawMetadata === undefined) return {}
  if (!isRecord(rawMetadata)) {
    if (!allowLegacy) fail('metadata must be a YAML object')
    diagnosticOnce(diagnostics, 'legacy_metadata')
    return {}
  }

  const metadata: Record<string, string> = {}
  for (const [key, value] of Object.entries(rawMetadata)) {
    if (typeof value !== 'string') {
      if (!allowLegacy) fail(`metadata.${key} must be a string`)
      diagnosticOnce(diagnostics, 'legacy_metadata')
      continue
    }
    metadata[key] = value
  }
  return metadata
}

export function parseSkillDocument(
  contents: string,
  options: { expectedDirectoryName?: string; allowLegacy: boolean },
): SkillDocument {
  const { frontmatter, body } = parseFrontmatter(contents)
  const diagnostics: SkillDiagnosticCode[] = []
  const name = frontmatter.name
  if (typeof name !== 'string' || name.length === 0) fail('Skill name is required')

  if (!standardNamePattern.test(name)) {
    if (!options.allowLegacy || !legacyNamePattern.test(name)) {
      fail(`Skill name "${name}" does not match the standard name format`)
    }
    diagnosticOnce(diagnostics, 'legacy_name')
  }

  if (options.expectedDirectoryName !== undefined && name !== options.expectedDirectoryName) {
    if (!options.allowLegacy) {
      fail(`Skill directory must match name "${name}"`)
    }
    diagnosticOnce(diagnostics, 'legacy_directory')
  }

  const description = frontmatter.description
  if (typeof description !== 'string' || description.trim().length === 0 || description.length > MAX_DESCRIPTION) {
    fail(`Skill description must be a non-empty string of at most ${MAX_DESCRIPTION} characters`)
  }

  const metadata = readMetadata(frontmatter, options.allowLegacy, diagnostics)
  const metadataVersion = metadata.version
  const topLevelVersion = frontmatter.version
  if (topLevelVersion !== undefined && typeof topLevelVersion !== 'string') {
    if (!options.allowLegacy) fail('version must be a string')
    diagnosticOnce(diagnostics, 'legacy_metadata')
  }
  const version = metadataVersion ?? (typeof topLevelVersion === 'string' ? topLevelVersion : '')
  const license = readOptionalString(frontmatter, 'license', Number.MAX_SAFE_INTEGER, options.allowLegacy, diagnostics)
  const compatibility = readOptionalString(
    frontmatter,
    'compatibility',
    MAX_COMPATIBILITY,
    options.allowLegacy,
    diagnostics,
  )

  const allowedTools = frontmatter['allowed-tools']
  if (allowedTools !== undefined && typeof allowedTools !== 'string') {
    if (!options.allowLegacy) fail('allowed-tools must be a string')
    diagnosticOnce(diagnostics, 'legacy_metadata')
  }

  return {
    name,
    description,
    version,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    metadata: Object.freeze(metadata),
    requestedAllowedTools: Object.freeze(
      typeof allowedTools === 'string' ? allowedTools.trim().split(/\s+/).filter(Boolean) : [],
    ),
    body,
    standardCompatible: diagnostics.length === 0,
    diagnostics: Object.freeze([...diagnostics]),
  }
}

type InspectedFile = SkillPackageFile & { data: Buffer }

function classifyFile(path: string): SkillPackageFile['kind'] {
  const root = path.split('/')[0]
  if (root === 'references') return 'reference'
  if (root === 'assets') return 'asset'
  if (root === 'scripts') return 'script'
  return 'other'
}

async function inspectDirectory(
  directory: string,
  prefix: string,
  files: InspectedFile[],
  skipSymlinks: boolean,
) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name)
    const stat = await lstat(absolutePath)
    if (stat.isSymbolicLink()) {
      if (skipSymlinks) continue
      throw new Error(`Skill package contains a symlink: ${prefix}${entry.name}`)
    }
    const path = prefix ? `${prefix}${entry.name}` : entry.name
    if (stat.isDirectory()) {
      await inspectDirectory(absolutePath, `${path}/`, files, skipSymlinks)
      continue
    }
    if (!stat.isFile()) throw new Error(`Skill package contains unsupported entry: ${path}`)
    const data = await readFile(absolutePath)
    files.push({ path, bytes: data.byteLength, kind: classifyFile(path), data })
  }
}

export async function inspectSkillPackage(
  directory: string,
  options: { skipSymlinks?: boolean } = {},
): Promise<{ digest: string; files: readonly SkillPackageFile[] }> {
  const rootStat = await lstat(directory)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Skill package root must be a directory without symlinks')
  }

  const inspected: InspectedFile[] = []
  await inspectDirectory(directory, '', inspected, options.skipSymlinks ?? false)
  inspected.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)

  const hash = createHash('sha256')
  for (const file of inspected) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(String(file.bytes))
    hash.update('\0')
    hash.update(file.data)
  }

  return {
    digest: hash.digest('hex'),
    files: inspected.map(file => ({
      path: file.path,
      bytes: file.bytes,
      kind: file.kind,
    })),
  }
}
