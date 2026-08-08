import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyDrafts,
  createWorkbenchState,
  getSelectedDraft,
  getVisibleDrafts,
  selectDraft,
  setWorkbenchFilter,
  setWorkbenchSettingsOpen,
} from '../content/workbench-state.js'
import { copyText } from '../content/workbench-clipboard.js'

const rawDrafts = [
  {
    id: 1,
    title: '文章',
    content: 'Agent',
    status: 'ready',
    draft_type: 'article',
    updated_at: '2026-08-08T10:00:00Z',
  },
  {
    id: 2,
    title: '帖子',
    content: 'X',
    status: 'ready',
    draft_type: 'x',
    updated_at: '2026-08-08T11:00:00Z',
  },
  {
    id: 3,
    title: '编辑中',
    content: '不要展示',
    status: 'editing',
    draft_type: 'article',
    updated_at: '2026-08-08T12:00:00Z',
  },
]

test('selects newest ready draft and applies filters', () => {
  let state = applyDrafts(createWorkbenchState(), rawDrafts)

  assert.equal(getSelectedDraft(state).id, 2)

  state = setWorkbenchFilter(state, { query: 'Agent' })
  assert.deepEqual(getVisibleDrafts(state).map(draft => draft.id), [1])

  state = setWorkbenchFilter(state, { query: '', type: 'x' })
  assert.deepEqual(getVisibleDrafts(state).map(draft => draft.id), [2])
})

test('preserves selection across refresh and toggles settings', () => {
  let state = selectDraft(applyDrafts(createWorkbenchState(), rawDrafts), 1)
  state = applyDrafts(state, [...rawDrafts].reverse())

  assert.equal(getSelectedDraft(state).id, 1)
  assert.equal(setWorkbenchSettingsOpen(state, true).settingsOpen, true)
})

test('copies without leaking body text on failure', async () => {
  const copied = []
  await copyText('正文\n第二段', {
    clipboard: { writeText: async text => copied.push(text) },
  })
  assert.deepEqual(copied, ['正文\n第二段'])

  await assert.rejects(
    copyText('private body', {
      clipboard: { writeText: async () => { throw new Error('nope') } },
    }),
    error => {
      assert.equal(error.code, 'CLIPBOARD_FAILED')
      assert.equal(error.message.includes('private body'), false)
      return true
    },
  )
})
