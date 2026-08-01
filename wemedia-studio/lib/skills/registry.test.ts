import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  deleteUploadedSkill,
  getEnabledSkill,
  listEnabledSkills,
  listSkills,
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
})
