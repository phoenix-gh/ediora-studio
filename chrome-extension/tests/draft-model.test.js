import assert from 'node:assert/strict'
import test from 'node:test'

import {
  draftHasMedia,
  filterDrafts,
  getDraftTitle,
  getDraftTypeOptions,
  selectReadyDrafts,
} from '../content/draft-model.js'

const drafts = [
  {
    id: 2,
    title: 'X 帖子',
    content: 'Agent 工作流',
    status: 'ready',
    draft_type: 'x',
    updated_at: '2026-08-08T12:00:00Z',
  },
  {
    id: 1,
    title: '文章标题',
    content: '完整文章正文',
    status: 'editing',
    draft_type: 'article',
    updated_at: '2026-08-08T13:00:00Z',
  },
  {
    id: 3,
    title: '',
    draft: '公众号正文',
    status: 'ready',
    draft_type: 'mp',
    updated_at: '2026-08-08T11:00:00Z',
  },
]

test('keeps only ready drafts and sorts newest first', () => {
  assert.deepEqual(selectReadyDrafts(drafts).map(draft => draft.id), [2, 3])
})

test('searches title/content and filters by type', () => {
  const ready = selectReadyDrafts(drafts)

  assert.deepEqual(filterDrafts(ready, { query: '工作流' }).map(draft => draft.id), [2])
  assert.deepEqual(filterDrafts(ready, { type: 'mp' }).map(draft => draft.id), [3])
})

test('uses labels and safe title fallback', () => {
  const ready = selectReadyDrafts([{
    id: 4,
    title: '',
    content: '',
    status: 'ready',
    draft_type: 'podcast',
  }])

  assert.equal(getDraftTitle(ready[0]), '未命名草稿')
  assert.deepEqual(getDraftTypeOptions(ready), ['podcast'])
})

test('supports legacy draft field when content is absent', () => {
  assert.equal(selectReadyDrafts(drafts)[1].content, '公众号正文')
})

test('treats markdown or html images as multimedia drafts', () => {
  assert.equal(draftHasMedia({ content: '纯文字说明' }), false)
  assert.equal(draftHasMedia({ content: '![封面](/api/uploads/cover.png) 正文' }), true)
  assert.equal(draftHasMedia({ content: '<img src="/api/uploads/cover.png" alt="封面">' }), true)
  assert.equal(draftHasMedia({ content: '![空地址]()' }), false)
})
