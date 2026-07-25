import { expect, it } from 'vitest'

import { parseTemplateCandidate, toolsForContentStep } from './content-job'

it('keeps template extraction free of persistence tools', () => {
  expect(toolsForContentStep('template_extraction')).toEqual([])
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
