import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { discoverSkills } from '../ai/discover-skills'
import {
  deleteUploadedSkill,
  listSkillReferences,
  listSkills,
  readSkillReference,
  setSkillEnabled,
} from './registry'

const skillName = 'human-social-copy'
const expectedReferences = [
  'references/adaptive-hooks.md',
  'references/finance-writing.md',
  'references/kol-brief-workflow.md',
  'references/layout-playbook.md',
  'references/patterns.md',
  'references/sourcing-playbook.md',
  'references/voice-system.md',
  'references/writing-clean-rules.md',
]

let runtimeDir = ''

describe('bundled human-social-copy Skill', () => {
  beforeEach(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), 'wms-human-social-copy-'))
    process.env.WMS_SKILLS_RUNTIME_DIR = join(runtimeDir, 'skills')
    process.env.WMS_SKILLS_STATE_FILE = join(runtimeDir, 'skills-state.json')
  })

  afterEach(async () => {
    delete process.env.WMS_SKILLS_RUNTIME_DIR
    delete process.env.WMS_SKILLS_STATE_FILE
    await rm(runtimeDir, { recursive: true, force: true })
  })

  it('is discoverable with its complete on-demand reference catalog', async () => {
    expect(await listSkills()).toContainEqual(expect.objectContaining({
      name: skillName,
      source: 'builtin',
      enabled: true,
      version: '1.0.0-wms.1',
    }))

    expect((await listSkillReferences(skillName)).map(reference => reference.path))
      .toEqual(expectedReferences)

    for (const referencePath of expectedReferences) {
      const reference = await readSkillReference(skillName, referencePath)
      expect(reference).toEqual(expect.objectContaining({
        path: referencePath,
        content: expect.stringMatching(/\S/),
      }))
      expect(reference.bytes).toBeGreaterThan(0)
    }

    expect((await discoverSkills()).map(skill => skill.name)).toContain(skillName)
  })

  it('can be disabled and restored but cannot be deleted', async () => {
    await expect(deleteUploadedSkill(skillName)).rejects.toMatchObject({ code: 'forbidden' })

    await setSkillEnabled(skillName, false)
    expect((await discoverSkills()).map(skill => skill.name)).not.toContain(skillName)
    await expect(listSkillReferences(skillName)).rejects.toMatchObject({ code: 'not_found' })

    await setSkillEnabled(skillName, true)
    expect((await discoverSkills()).map(skill => skill.name)).toContain(skillName)
    expect(await listSkillReferences(skillName)).toHaveLength(expectedReferences.length)
  })
})
