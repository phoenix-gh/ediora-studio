import { expect, it } from 'vitest'

import {
  buildDailyCreationSelectionPrompt,
  buildDailyCreationValidationPrompt,
  normalizeRunDirectories,
} from './daily-creation-job'

it('uses current directory lists and falls back to a legacy directory', () => {
  expect(normalizeRunDirectories({
    directories: ['目录甲', '目录乙'], directory: '旧目录',
  })).toEqual(['目录甲', '目录乙'])
  expect(normalizeRunDirectories({ directory: '旧目录' })).toEqual(['旧目录'])
  expect(() => normalizeRunDirectories({ directories: [], directory: '' }))
    .toThrow(/at least one directory/i)
})

it('emits zero-based validation indices and their exact schema to the provider', () => {
  const post = {
    asset_id: 381,
    title: 'AI 头像服务',
    text: '短帖正文',
    topic: 'AI 头像副业',
    angle: '标准化交付',
    reuse_decision: 'fresh',
    reuse_explanation: '',
  }
  const payload = JSON.parse(buildDailyCreationValidationPrompt({
    posts: [post],
    recent_global_usage: [],
    deterministic_issues: [],
  }))

  expect(payload.output_rules).toEqual([
    '只返回一个 JSON 对象，不要 Markdown 或解释。',
    '顶层只能包含 accepted_indices 和 rejected，禁止使用任何别名。',
    '所有 index 都是 indexed_posts 中从 0 开始的帖子位置，绝对不能填写 asset_id。',
    'index 只能取 valid_indices 中明确列出的值。',
  ])
  expect(payload.valid_indices).toEqual([0])
  expect(payload.indexed_posts).toEqual([{ index: 0, post }])
  expect(payload.output_schema).toMatchObject({
    type: 'object',
    required: expect.arrayContaining(['accepted_indices', 'rejected']),
    properties: {
      accepted_indices: {
        description: expect.stringMatching(/从 0 开始.*不能.*asset_id/),
      },
      rejected: {
        items: {
          properties: {
            index: {
              description: expect.stringMatching(/从 0 开始.*不能.*asset_id/),
            },
          },
        },
      },
    },
  })
})

it('emits the complete strict selection schema to the provider', () => {
  const payload = JSON.parse(buildDailyCreationSelectionPrompt({
    requested_count: 10,
    rule: { name: '夜间创作' },
    candidates: [{ id: 12, title: '需求验证' }],
    recent_global_usage: [],
  }))

  expect(payload.output_rules).toEqual([
    '只返回一个 JSON 对象，不要 Markdown 或解释。',
    '顶层只能包含 selected 和 excluded，禁止使用任何别名。',
    'selected 和 excluded 必须始终返回数组；没有排除项时 excluded 返回空数组。',
    '候选素材可能没有 title、topic 或 angle；topic 和 angle 不是候选素材已有字段，必须根据 summary 等素材内容生成，且不得为空。',
    '所有 ID 必须来自给定候选或历史用量。',
  ])
  expect(payload.output_schema).toMatchObject({
    type: 'object',
    required: expect.arrayContaining(['selected', 'excluded']),
    properties: {
      selected: {
        type: 'array',
        items: {
          required: expect.arrayContaining([
            'asset_id',
            'topic',
            'angle',
            'reuse_decision',
            'reuse_explanation',
            'compared_usage_ids',
          ]),
          properties: {
            topic: {
              description: expect.stringMatching(/根据.*素材.*生成/),
            },
            angle: {
              description: expect.stringMatching(/根据.*素材.*生成/),
            },
          },
        },
      },
    },
  })
})
