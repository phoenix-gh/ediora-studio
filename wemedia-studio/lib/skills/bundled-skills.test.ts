import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { discoverSkills } from '../ai/discover-skills'
import {
  deleteUploadedSkill,
  getEnabledSkill,
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

  it('requires task-specific references before social copy is drafted', async () => {
    const skill = await getEnabledSkill(skillName)

    expect(skill?.instructions).toContain('涉及收益、成本、投资、金融或 Crypto：必须读取 `references/finance-writing.md`')
    expect(skill?.instructions).toContain('需要可直接发布到 X 或其他平台：必须读取 `references/layout-playbook.md`')
    expect(skill?.instructions).toContain('改写、润色或去除 AI 味：必须读取 `references/writing-clean-rules.md`')
    expect(skill?.instructions).toContain('涉及账号声音或发布身份：必须读取 `references/voice-system.md`')
  })
})
