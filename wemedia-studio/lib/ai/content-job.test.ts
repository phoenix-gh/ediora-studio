import { expect, it } from 'vitest'

import { illustrationImageInputSchema, insertInlineImage, parseTemplateCandidate, toolsForContentStep } from './content-job'

it('keeps template extraction free of persistence tools', () => {
  expect(toolsForContentStep('template_extraction')).toEqual([])
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
