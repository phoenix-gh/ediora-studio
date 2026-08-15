import { describe, expect, it } from 'vitest'

import {
  contentResponseContractExample,
  contentResponseAnalysisSchema,
  parseContentResponseAnalysis,
} from './content-response-job'


function validAnalysis() {
  return {
    content_value_score: 80,
    value_dimensions: {
      novelty: { score: 80, reason: '新角度' },
      practicality: { score: 80, reason: '可执行' },
      credibility: { score: 70, reason: '有来源' },
      writing_space: { score: 75, reason: '有展开空间' },
      evergreen_value: { score: 65, reason: '有长期价值' },
    },
    summary_cn: '摘要',
    core_thesis: '核心思想',
    value_points: ['价值点'],
    evidence: [{ text: '来源说法', type: 'source_claim' }],
    risks: [],
    verification_items: [],
    recommended_content_types: ['research', 'tutorial'],
    recommended_disposition: 'worth_writing',
    recommendation_reason: '值得扩写',
    suggested_title: '一篇值得写的文章',
    suggested_angle: '从实践路径切入',
    target_reader: '正在搭建内容系统的创作者',
    suggested_structure: ['开篇', '论证', '结论'],
  }
}


describe('content response analysis schema', () => {
  it('accepts low value content so it can still enter the inbox', () => {
    const input = validAnalysis()
    input.content_value_score = 10
    expect(contentResponseAnalysisSchema.parse(input).content_value_score).toBe(10)
  })

  it('requires writing space and editorial destination fields', () => {
    const value = validAnalysis()
    expect(value.value_dimensions.writing_space.score).toBe(75)
    expect(value.recommended_disposition).toBe('worth_writing')
    expect(value.suggested_structure).toEqual(['开篇', '论证', '结论'])
  })

  it('does not accept the removed discussion dimension', () => {
    const value: Record<string, unknown> = validAnalysis()
    const dimensions = value.value_dimensions as Record<string, unknown>
    delete dimensions.writing_space
    dimensions.discussion_value = { score: 70, reason: '旧字段' }
    expect(() => contentResponseAnalysisSchema.parse(value)).toThrow()
  })

  it('parses fenced JSON output', () => {
    expect(parseContentResponseAnalysis(`\`\`\`json\n${JSON.stringify(validAnalysis())}\n\`\`\``))
      .toMatchObject({ summary_cn: '摘要' })
  })

  it('builds an exact editorial repair contract without account scoring', () => {
    const example = contentResponseContractExample()

    expect(contentResponseAnalysisSchema.parse(example)).toMatchObject({
      value_dimensions: { writing_space: { score: 70 } },
      recommended_disposition: 'worth_writing',
    })
    expect(example).not.toHaveProperty('account_scores')
    expect(example).not.toHaveProperty('comment_angles')
  })
})
