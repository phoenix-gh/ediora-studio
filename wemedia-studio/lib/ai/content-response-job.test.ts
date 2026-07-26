import { describe, expect, it } from 'vitest'

import {
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
      discussion_value: { score: 75, reason: '可评论' },
      evergreen_value: { score: 65, reason: '有长期价值' },
    },
    summary_cn: '摘要',
    core_thesis: '核心思想',
    key_points: ['观点'],
    evidence: [{ text: '来源说法', type: 'source_claim' }],
    value_points: ['价值点'],
    risks: [],
    verification_items: [],
    personal_angles: ['个人经验'],
    article_outlines: [],
    comment_angles: [],
    recommended_output_types: ['expanded_article'],
    recommended_action: 'expand',
    recommendation_reason: '值得扩写',
    recommended_publish_account_id: null,
    account_scores: [],
  }
}


describe('content response analysis schema', () => {
  it('accepts low value content so it can still enter the inbox', () => {
    const input = validAnalysis()
    input.content_value_score = 10
    expect(contentResponseAnalysisSchema.parse(input).content_value_score).toBe(10)
  })

  it('rejects a recommended account with a hard taboo conflict', () => {
    const input: Record<string, unknown> = validAnalysis()
    input.recommended_publish_account_id = 'blocked'
    input.account_scores = [{
      publish_account_id: 'blocked',
      score: 99,
      rank: 1,
      fit_reasons: [],
      audience_value: '',
      recommended_tone: '',
      recommended_output_types: ['x_share'],
      taboo_risks: ['硬冲突'],
      has_hard_conflict: true,
    }]
    expect(() => contentResponseAnalysisSchema.parse(input)).toThrow(/hard conflict/)
  })

  it('parses fenced JSON output', () => {
    expect(parseContentResponseAnalysis(`\`\`\`json\n${JSON.stringify(validAnalysis())}\n\`\`\``))
      .toMatchObject({ summary_cn: '摘要' })
  })
})
