import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { setSkillEnabled } from '../skills/registry'
import { discoverSkills } from './discover-skills'

let runtimeDir = ''

describe('discoverSkills', () => {
  it('automatically lists every local skill with a named frontmatter block', async () => {
    const skills = await discoverSkills()

    expect(skills.map(skill => skill.name)).toEqual(expect.arrayContaining([
      'baoyu-article-illustrator',
      'baoyu-cover-image',
    ]))
    expect(skills).toEqual([...skills].sort((left, right) => left.name.localeCompare(right.name)))
    expect(skills.find(skill => skill.name === 'baoyu-cover-image')).toMatchObject({
      description: expect.any(String),
      version: expect.any(String),
      instructions: expect.stringContaining('baoyu-cover-image'),
    })
  })

  afterEach(async () => {
    delete process.env.WMS_SKILLS_RUNTIME_DIR
    delete process.env.WMS_SKILLS_STATE_FILE
    if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true })
    runtimeDir = ''
  })

  it('omits a disabled Skill and restores it when enabled again', async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), 'wms-discover-skills-'))
    process.env.WMS_SKILLS_RUNTIME_DIR = runtimeDir
    process.env.WMS_SKILLS_STATE_FILE = join(runtimeDir, 'skills-state.json')

    await setSkillEnabled('baoyu-cover-image', false)
    expect((await discoverSkills()).some(skill => skill.name === 'baoyu-cover-image')).toBe(false)

    await setSkillEnabled('baoyu-cover-image', true)
    expect((await discoverSkills()).some(skill => skill.name === 'baoyu-cover-image')).toBe(true)
  })
})
