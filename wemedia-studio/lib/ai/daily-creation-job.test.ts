import { expect, it } from 'vitest'

import {
  buildDailyCreationSelectionPrompt,
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
        },
      },
    },
  })
})
