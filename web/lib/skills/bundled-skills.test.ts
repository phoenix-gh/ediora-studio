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
const xArticleSkillName = 'x-article-writing'
const wechatArticleSkillName = 'wechat-article-writing'
const expectedXArticleReferences = [
  'references/article-structure.md',
  'references/hooks-and-layout.md',
  'references/quality-check.md',
]
const githubTrendingSkillName = 'github-trending-chart'

let runtimeDir = ''

describe('bundled human-social-copy Skill', () => {
  beforeEach(async () => {
    runtimeDir = await mkdtemp(join(tmpdir(), 'wms-human-social-copy-'))
    process.env.SKILLS_RUNTIME_DIR = join(runtimeDir, 'skills')
    process.env.SKILLS_STATE_FILE = join(runtimeDir, 'skills-state.json')
  })

  afterEach(async () => {
    delete process.env.SKILLS_RUNTIME_DIR
    delete process.env.SKILLS_STATE_FILE
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

  it('discovers the bundled X Article Skill with its independent format boundary', async () => {
    expect(await listSkills()).toContainEqual(expect.objectContaining({
      name: xArticleSkillName,
      source: 'builtin',
      enabled: true,
      version: '1.0.0-wms.1',
    }))
    expect((await discoverSkills()).map(skill => skill.name)).toContain(xArticleSkillName)
    expect((await listSkillReferences(xArticleSkillName)).map(reference => reference.path))
      .toEqual(expectedXArticleReferences)

    const skill = await getEnabledSkill(xArticleSkillName)
    expect(skill?.description).toContain('X/Twitter Article')
    expect(skill?.description).toContain('x_article')
    expect(skill?.description).toContain('expanded_article')
    expect(skill?.instructions).toContain('不适用于普通 X 长帖或 Thread')
    expect(skill?.instructions).toContain('不得编造')
    expect(skill?.instructions).toContain('save_draft')
    for (const referencePath of expectedXArticleReferences) {
      expect(skill?.instructions).toContain(`readSkillReference`)
      expect(skill?.instructions).toContain(`\`${referencePath}\``)
      await expect(readSkillReference(xArticleSkillName, referencePath)).resolves.toEqual(
        expect.objectContaining({
          path: referencePath,
          content: expect.stringMatching(/\S/),
          bytes: expect.any(Number),
        }),
      )
    }
  })

  it('discovers the bundled WeChat Article Skill with the intelligence draft contract', async () => {
    expect(await listSkills()).toContainEqual(expect.objectContaining({
      name: wechatArticleSkillName,
      source: 'builtin',
      enabled: true,
      version: '1.0.0-wms.1',
    }))
    expect((await discoverSkills()).map(skill => skill.name)).toContain(wechatArticleSkillName)
    expect((await listSkillReferences(wechatArticleSkillName)).map(reference => reference.path))
      .toEqual(['agents/openai.yaml'])

    const skill = await getEnabledSkill(wechatArticleSkillName)
    expect(skill?.description).toContain('微信公众号文章')
    expect(skill?.description).toContain('wechat_article')
    expect(skill?.instructions).toContain('不得编造')
    expect(skill?.instructions).toContain('save_draft')
    expect(skill?.instructions).toContain('draft_type=mp')
    expect(skill?.instructions).toContain('不得发布')
  })

  it('can disable and restore the bundled X Article Skill but cannot delete it', async () => {
    await expect(deleteUploadedSkill(xArticleSkillName)).rejects.toMatchObject({ code: 'forbidden' })

    await setSkillEnabled(xArticleSkillName, false)
    expect((await discoverSkills()).map(skill => skill.name)).not.toContain(xArticleSkillName)
    await expect(listSkillReferences(xArticleSkillName)).rejects.toMatchObject({ code: 'not_found' })

    await setSkillEnabled(xArticleSkillName, true)
    expect((await discoverSkills()).map(skill => skill.name)).toContain(xArticleSkillName)
    expect(await listSkillReferences(xArticleSkillName)).toHaveLength(expectedXArticleReferences.length)
  })

  it('discovers the default GitHub daily ranking chart Skill', async () => {
    expect(await listSkills()).toContainEqual(expect.objectContaining({
      name: githubTrendingSkillName,
      source: 'builtin',
      enabled: true,
    }))
    expect(await listSkillReferences(githubTrendingSkillName)).toEqual([])
    expect((await discoverSkills()).map(skill => skill.name)).toContain(githubTrendingSkillName)

    const skill = await getEnabledSkill(githubTrendingSkillName)
    expect(skill?.description).toContain('GitHub daily')
    expect(skill?.instructions).toContain('get_github_daily_trending')
    expect(skill?.instructions).toContain('project_intro')
    expect(skill?.instructions).toContain('recommendation')
    expect(skill?.instructions).toContain('generateImage')
    expect(skill?.instructions).toContain('临时文件')
  })
})
