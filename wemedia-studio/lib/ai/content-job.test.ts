import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { setSkillEnabled } from '../skills/registry'
import {
  dailyCreationSelectionSchema,
  parseDailyCreationSelection,
  parseDailyCreationValidation,
  parseXPostBatch,
  illustrationImageInputSchema,
  insertInlineImage,
  loadBaoyuSkillRulesForTest,
  parseTemplateCandidate,
  validateDailyCreationSelection,
  validateXPostBatch,
  toolsForContentStep,
} from './content-job'

let runtimeDir = ''

afterEach(async () => {
  delete process.env.WMS_SKILLS_RUNTIME_DIR
  delete process.env.WMS_SKILLS_STATE_FILE
  delete process.env.WMS_SKILLS_MAX_REFERENCE_BYTES
  if (runtimeDir) await rm(runtimeDir, { recursive: true, force: true })
  runtimeDir = ''
})

it('keeps template extraction free of persistence tools', () => {
  expect(toolsForContentStep('template_extraction')).toEqual([])
})

it('accepts daily creation selection evidence only from observed tools', () => {
  const selection = dailyCreationSelectionSchema.parse({
    selected: [{
      asset_id: 12, topic: '需求验证', angle: '真实付费',
      reuse_decision: 'reuse_allowed',
      reuse_explanation: '历史讨论问卷，这次讨论实际付款。',
      compared_usage_ids: [7],
    }],
    excluded: [{ asset_id: 13, reason: '与近期内容同角度' }],
  })
  expect(validateDailyCreationSelection(selection, [12, 13], [7])).toEqual(selection)
  expect(() => validateDailyCreationSelection(selection, [99], [7]))
    .toThrow(/invented asset/i)
  expect(() => validateDailyCreationSelection(selection, [12, 13], [8]))
    .toThrow(/invented usage/i)
})

it('accepts only the complete daily creation selection contract', () => {
  const exactSelection = {
    selected: [{
      asset_id: 12,
      topic: '需求验证',
      angle: '真实付费',
      reuse_decision: 'fresh' as const,
      reuse_explanation: '',
      compared_usage_ids: [],
    }],
    excluded: [{ asset_id: 13, reason: '与近期内容同角度' }],
  }

  expect(parseDailyCreationSelection(exactSelection)).toEqual(exactSelection)
})

it.each([
  {
    selected_candidates: [{
      asset_id: 12,
      topic: '需求验证',
      angle: '真实付费',
      reuse_decision: 'fresh',
      reuse_explanation: '',
      compared_usage_ids: [],
    }],
    excluded: [],
  },
  {
    selected: [{
      asset_id: 12,
      topic: '需求验证',
      angle: '真实付费',
      reuse_decision: 'fresh',
      reuse_explanation: '',
      compared_usage_ids: [],
    }],
    excluded: [],
    selected_candidates: [],
  },
  { selected: [{ id: 12, reason: '紧凑结构' }], excluded: [] },
  {
    selected: [{
      asset_id: 12,
      topic: '需求验证',
      angle: '真实付费',
      reuse_decision: 'fresh',
      reuse_explanation: '',
      compared_usage_ids: [],
    }],
  },
  {
    selected: [{
      asset_id: 12,
      topic: '需求验证',
      angle: '真实付费',
      reuse_decision: 'fresh',
    }],
    excluded: [],
  },
])('rejects a non-contract daily creation selection: %j', malformed => {
  expect(() => parseDailyCreationSelection(malformed)).toThrow(/invalid daily creation selection/i)
})

it('normalizes wrapped and text-only X post batches against selected evidence', () => {
  const selected = [{ asset_id: 12, topic: '需求验证', angle: '真实付费', reuse_decision: 'fresh' as const, reuse_explanation: '' }]
  expect(parseXPostBatch({ posts: [{ asset_id: 12, title: '标题', text: '正文', topic: '需求验证', angle: '真实付费', reuse_decision: 'fresh' }] }, selected)[0].asset_id).toBe(12)
  expect(parseXPostBatch(['一条完整的短帖正文'], selected)[0]).toEqual(expect.objectContaining({ asset_id: 12, text: '一条完整的短帖正文' }))
})

it('normalizes common AI validation aliases and rejects out-of-range evidence', () => {
  expect(parseDailyCreationValidation({ approved_indices: [0], rejections: [{ post_index: 1, reason: '语义重复' }] }, 2)).toEqual({
    accepted_indices: [0], rejected: [{ index: 1, reason: '语义重复' }],
  })
  expect(() => parseDailyCreationValidation({ accepted_indices: [2], rejected: [] }, 2)).toThrow(/out-of-range/i)
  expect(() => parseDailyCreationValidation({ summary: '都很好' }, 2)).toThrow(/invalid daily creation validation/i)
})

it('rejects duplicate posts, unjustified reuse, and invented experience', () => {
  expect(validateXPostBatch([
    { asset_id: 1, title: 'A', text: '同一条内容', topic: '增长', angle: '成本', reuse_decision: 'fresh', reuse_explanation: '' },
    { asset_id: 2, title: 'B', text: ' 同一条内容 ', topic: '增长', angle: '效率', reuse_decision: 'fresh', reuse_explanation: '' },
    { asset_id: 3, title: 'C', text: '我亲自测试了三个月。', topic: '增长', angle: '实践', reuse_decision: 'reuse_allowed', reuse_explanation: '' },
  ])).toEqual([
    { index: 1, reason: 'within_batch_duplicate' },
    { index: 2, reason: 'invented_personal_experience' },
    { index: 2, reason: 'reuse_explanation_required' },
  ])
})

it('inserts an illustration after its matching level-two heading', () => {
  expect(insertInlineImage('## 安装\n\n正文', '/api/uploads/install.png', '安装')).toEqual({
    content: '## 安装\n\n![插图](/api/uploads/install.png)\n\n正文',
    placement: 'anchor',
  })
})

it('appends an illustration when its heading is absent', () => {
  expect(insertInlineImage('# 标题\n\n正文', '/api/uploads/fallback.png', '不存在')).toEqual({
    content: '# 标题\n\n正文\n\n![插图](/api/uploads/fallback.png)',
    placement: 'append',
  })
})

it('does not insert the same illustration URL twice', () => {
  expect(insertInlineImage('![插图](/api/uploads/install.png)', '/api/uploads/install.png', '安装')).toEqual({
    content: '![插图](/api/uploads/install.png)',
    placement: 'existing',
  })
})

it('requires a heading anchor for automatic illustrations', () => {
  expect(illustrationImageInputSchema.safeParse({ prompt: 'x'.repeat(20) }).success).toBe(false)
  expect(illustrationImageInputSchema.safeParse({
    prompt: 'x'.repeat(20),
    anchor_heading: '安装 sing-box',
  }).success).toBe(true)
})

it('accepts a null merge target from a non-merge candidate', () => {
  expect(parseTemplateCandidate(JSON.stringify({
    recommendation: 'create', title: '案例拆解', genre: 'commentary', writing_guide: '先讲现象，再解释原因。',
    title_formula: '[现象] 为什么发生', unsuitable_for: '纯新闻', genericity_check: '未含专有名词', merge_target_id: null, reason: '可复用',
  })).merge_target_id).toBeNull()
})

it('normalizes an array of unsuitable cases into display text', () => {
  expect(parseTemplateCandidate(JSON.stringify({
    recommendation: 'create', title: '案例拆解', genre: 'commentary', writing_guide: '先讲现象，再解释原因。',
    title_formula: '[现象] 为什么发生', unsuitable_for: ['纯新闻', '无案例观点'], genericity_check: '未含专有名词', reason: '可复用',
  })).unsuitable_for).toBe('纯新闻\n无案例观点')
})

it('refuses to load a disabled automatic image Skill', async () => {
  runtimeDir = await mkdtemp(join(tmpdir(), 'wms-content-skill-'))
  process.env.WMS_SKILLS_RUNTIME_DIR = runtimeDir
  process.env.WMS_SKILLS_STATE_FILE = join(runtimeDir, 'skills-state.json')

  await setSkillEnabled('baoyu-cover-image', false)
  await expect(loadBaoyuSkillRulesForTest('cover')).rejects.toThrow(/unavailable|disabled/i)
})

it('applies the shared Skill reference byte limit to background cover rules', async () => {
  process.env.WMS_SKILLS_MAX_REFERENCE_BYTES = '1'

  await expect(loadBaoyuSkillRulesForTest('cover')).rejects.toMatchObject({ code: 'too_large' })
})
