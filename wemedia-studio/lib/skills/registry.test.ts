import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'

import {
  deleteUploadedSkill,
  getEnabledSkill,
  installSkillArchive,
  listEnabledSkills,
  listSkillReferences,
  listSkills,
  loadSkillContext,
  readSkillReference,
  setSkillEnabled,
} from './registry'

let bundledDir = ''
let runtimeDir = ''
let stateFile = ''

async function writeSkill(root: string, directory: string, name: string, version = '1.0.0') {
  const skillDir = join(root, directory)
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\nversion: ${version}\n---\n\n# ${name}\n`, 'utf8')
}

describe('Skill registry', () => {
  beforeEach(async () => {
    bundledDir = await mkdtemp(join(tmpdir(), 'wms-skill-bundled-'))
    runtimeDir = await mkdtemp(join(tmpdir(), 'wms-skill-runtime-'))
    stateFile = join(runtimeDir, 'skills-state.json')
    process.env.WMS_SKILLS_BUNDLED_DIR = bundledDir
    process.env.WMS_SKILLS_RUNTIME_DIR = runtimeDir
    process.env.WMS_SKILLS_STATE_FILE = stateFile
  })

  afterEach(async () => {
    delete process.env.WMS_SKILLS_BUNDLED_DIR
    delete process.env.WMS_SKILLS_RUNTIME_DIR
    delete process.env.WMS_SKILLS_STATE_FILE
    delete process.env.WMS_SKILLS_MAX_ARCHIVE_BYTES
    delete process.env.WMS_SKILLS_MAX_UNPACKED_BYTES
    delete process.env.WMS_SKILLS_MAX_FILES
    delete process.env.WMS_SKILLS_MAX_REFERENCES
    delete process.env.WMS_SKILLS_MAX_REFERENCE_BYTES
    delete process.env.WMS_SKILLS_MAX_REFERENCE_CONTEXT_BYTES
    await Promise.all([
      rm(bundledDir, { recursive: true, force: true }),
      rm(runtimeDir, { recursive: true, force: true }),
    ])
  })

  it('lists bundled Skills enabled by default and persists a toggle', async () => {
    await writeSkill(bundledDir, 'alpha', 'Alpha')

    expect(await listSkills()).toEqual([
      expect.objectContaining({ name: 'Alpha', source: 'builtin', enabled: true }),
    ])

    await setSkillEnabled('Alpha', false)

    expect((await listSkills())[0].enabled).toBe(false)
    expect(await listEnabledSkills()).toHaveLength(0)

    const state = JSON.parse(await readFile(join(runtimeDir, 'skills-state.json'), 'utf8'))
    expect(state).toEqual({ Alpha: { source: 'builtin', enabled: false } })
  })

  it('returns complete instructions only for enabled Skills', async () => {
    await writeSkill(bundledDir, 'alpha', 'Alpha')

    expect(await getEnabledSkill('Alpha')).toEqual(expect.objectContaining({
      name: 'Alpha',
      instructions: expect.stringContaining('# Alpha'),
      directory: join(bundledDir, 'alpha'),
    }))

    await setSkillEnabled('Alpha', false)
    expect(await getEnabledSkill('Alpha')).toBeNull()
  })

  it('does not allow deleting a bundled Skill and allows deleting an uploaded Skill', async () => {
    await writeSkill(bundledDir, 'alpha', 'Alpha')
    await writeSkill(runtimeDir, 'custom', 'Custom')

    await expect(deleteUploadedSkill('Alpha')).rejects.toMatchObject({ code: 'forbidden' })
    await deleteUploadedSkill('Custom')

    expect(await listSkills()).toHaveLength(1)
    await expect(readFile(join(runtimeDir, 'custom', 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('installs a root Skill and a wrapped multi-Skill archive as enabled uploads', async () => {
    const archive = zipSync({
      'SKILL.md': strToU8(skillMarkdown('Root')),
      'references/notes.md': strToU8('root notes'),
      'package/one/SKILL.md': strToU8(skillMarkdown('One')),
      'package/one/references/rules.md': strToU8('one rules'),
      'package/two/SKILL.md': strToU8(skillMarkdown('Two')),
    })

    await expect(installSkillArchive(archive)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Root', source: 'uploaded', enabled: true }),
      expect.objectContaining({ name: 'One', source: 'uploaded', enabled: true }),
      expect.objectContaining({ name: 'Two', source: 'uploaded', enabled: true }),
    ]))
    await expect(access(join(runtimeDir, 'Root', 'references', 'notes.md'))).resolves.toBeUndefined()
    await expect(readSkillReference('Root', 'references/notes.md')).resolves.toEqual({
      path: 'references/notes.md', content: 'root notes', bytes: 10,
    })
    expect((await listEnabledSkills()).map(skill => skill.name)).toEqual(expect.arrayContaining(['Root', 'One', 'Two']))
  })

  it('rejects conflicts, unsafe paths, duplicate names, and rolls back the whole archive', async () => {
    await writeSkill(runtimeDir, 'existing', 'Existing')
    const before = await readFile(join(runtimeDir, 'existing', 'SKILL.md'), 'utf8')

    await expect(installSkillArchive(zipSync({ 'new/SKILL.md': strToU8(skillMarkdown('Existing')) })))
      .rejects.toMatchObject({ code: 'conflict' })
    await expect(installSkillArchive(zipSync({ '../escape.txt': strToU8('nope'), 'SKILL.md': strToU8(skillMarkdown('Escape')) })))
      .rejects.toMatchObject({ code: 'invalid_archive' })
    await expect(installSkillArchive(zipSync({
      'one/SKILL.md': strToU8(skillMarkdown('Duplicate')),
      'two/SKILL.md': strToU8(skillMarkdown('Duplicate')),
    }))).rejects.toMatchObject({ code: 'invalid_archive' })

    expect(await readFile(join(runtimeDir, 'existing', 'SKILL.md'), 'utf8')).toBe(before)
    await expect(access(join(runtimeDir, 'Escape'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects archives containing Unix symlink entries or missing frontmatter names', async () => {
    const symlinkArchive = zipSync({
      'link': [strToU8('target'), { os: 3, attrs: 0o120777 << 16 }],
      'SKILL.md': strToU8(skillMarkdown('Symlink')),
    })
    await expect(installSkillArchive(symlinkArchive)).rejects.toMatchObject({ code: 'invalid_archive' })
    await expect(installSkillArchive(zipSync({ 'SKILL.md': strToU8('---\ndescription: missing name\n---\n') })))
      .rejects.toMatchObject({ code: 'invalid_archive' })
  })

  it('enforces configured archive limits before writing', async () => {
    process.env.WMS_SKILLS_MAX_UNPACKED_BYTES = '100'
    const archive = zipSync({ 'SKILL.md': strToU8(skillMarkdown('TooBig') + 'x'.repeat(200)) })
    await expect(installSkillArchive(archive)).rejects.toMatchObject({ code: 'too_large' })
    await expect(access(join(runtimeDir, 'TooBig'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps uploaded content and disabled state available to later registry reads', async () => {
    await installSkillArchive(zipSync({ 'SKILL.md': strToU8(skillMarkdown('Persistent')) }))
    await setSkillEnabled('Persistent', false)

    expect(await listSkills()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Persistent', source: 'uploaded', enabled: false }),
    ]))
    expect(await getEnabledSkill('Persistent')).toBeNull()
    expect(await readFile(join(runtimeDir, 'skills-state.json'), 'utf8')).toContain('Persistent')
  })

  it('discovers supported nested references and loads explicit context once per path', async () => {
    await writeSkill(bundledDir, 'alpha', 'Alpha')
    const skillDir = join(bundledDir, 'alpha')
    await mkdir(join(skillDir, 'references', 'nested'), { recursive: true })
    await mkdir(join(skillDir, '.hidden'), { recursive: true })
    await writeFile(join(skillDir, 'references', 'rules.md'), 'rules', 'utf8')
    await writeFile(join(skillDir, 'references', 'nested', 'config.yaml'), 'tone: direct', 'utf8')
    await writeFile(join(skillDir, 'references', 'image.png'), new Uint8Array([0, 1, 2]))
    await writeFile(join(skillDir, '.hidden', 'secret.md'), 'secret', 'utf8')
    await writeFile(join(skillDir, 'UPSTREAM.md'), 'provenance', 'utf8')

    await expect(listSkillReferences('Alpha')).resolves.toEqual([
      { path: 'references/nested/config.yaml', bytes: 12 },
      { path: 'references/rules.md', bytes: 5 },
    ])
    await expect(readSkillReference('Alpha', 'references/rules.md')).resolves.toEqual({
      path: 'references/rules.md', content: 'rules', bytes: 5,
    })
    await expect(loadSkillContext('Alpha', [
      'references/rules.md',
      'references/nested/config.yaml',
      'references/rules.md',
    ])).resolves.toEqual(expect.objectContaining({
      name: 'Alpha',
      instructions: expect.stringContaining('# Alpha'),
      references: [
        { path: 'references/rules.md', content: 'rules', bytes: 5 },
        { path: 'references/nested/config.yaml', content: 'tone: direct', bytes: 12 },
      ],
    }))
  })

  it('rejects unsafe, hidden, unsupported, malformed, and symlink reference reads', async () => {
    await writeSkill(bundledDir, 'alpha', 'Alpha')
    const skillDir = join(bundledDir, 'alpha')
    await mkdir(join(skillDir, 'references'), { recursive: true })
    await writeFile(join(skillDir, 'references', 'rules.md'), 'rules', 'utf8')
    await writeFile(join(skillDir, 'references', 'bad.md'), new Uint8Array([0xff]))
    await writeFile(join(skillDir, 'references', 'nul.md'), new Uint8Array([97, 0, 98]))
    await writeFile(join(skillDir, 'references', 'script.js'), 'alert(1)', 'utf8')
    await symlink(join(skillDir, 'references', 'rules.md'), join(skillDir, 'references', 'linked.md'))

    for (const path of ['', '/etc/passwd', '../outside.md', 'references\\rules.md', '.hidden/rules.md', 'SKILL.md']) {
      await expect(readSkillReference('Alpha', path)).rejects.toMatchObject({ code: 'invalid_reference' })
    }
    await expect(readSkillReference('Alpha', 'references/script.js')).rejects.toMatchObject({ code: 'invalid_reference' })
    await expect(readSkillReference('Alpha', 'references/missing.md')).rejects.toMatchObject({ code: 'reference_not_found' })
    await expect(readSkillReference('Alpha', 'references/linked.md')).rejects.toMatchObject({ code: 'invalid_reference' })
    await expect(readSkillReference('Alpha', 'references/bad.md')).rejects.toMatchObject({ code: 'invalid_reference' })
    await expect(readSkillReference('Alpha', 'references/nul.md')).rejects.toMatchObject({ code: 'invalid_reference' })
  })

  it('enforces catalog, file, and cumulative reference limits and disabled state', async () => {
    await writeSkill(bundledDir, 'alpha', 'Alpha')
    const skillDir = join(bundledDir, 'alpha')
    await mkdir(join(skillDir, 'references'), { recursive: true })
    await writeFile(join(skillDir, 'references', 'one.md'), '12345', 'utf8')
    await writeFile(join(skillDir, 'references', 'two.md'), '67890', 'utf8')

    process.env.WMS_SKILLS_MAX_REFERENCES = '1'
    await expect(listSkillReferences('Alpha')).rejects.toMatchObject({ code: 'too_large' })
    delete process.env.WMS_SKILLS_MAX_REFERENCES

    process.env.WMS_SKILLS_MAX_REFERENCE_BYTES = '4'
    await expect(readSkillReference('Alpha', 'references/one.md')).rejects.toMatchObject({ code: 'too_large' })
    delete process.env.WMS_SKILLS_MAX_REFERENCE_BYTES

    process.env.WMS_SKILLS_MAX_REFERENCE_CONTEXT_BYTES = '9'
    await expect(loadSkillContext('Alpha', ['references/one.md', 'references/two.md']))
      .rejects.toMatchObject({ code: 'too_large' })
    delete process.env.WMS_SKILLS_MAX_REFERENCE_CONTEXT_BYTES

    await setSkillEnabled('Alpha', false)
    await expect(listSkillReferences('Alpha')).rejects.toMatchObject({ code: 'not_found' })
    await expect(readSkillReference('Alpha', 'references/one.md')).rejects.toMatchObject({ code: 'not_found' })
  })
})

function skillMarkdown(name: string) {
  return `---\nname: ${name}\ndescription: ${name} description\nversion: 1.0.0\n---\n\n# ${name}\n`
}
