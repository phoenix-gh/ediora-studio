import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { draftHasMedia } from '../content/draft-model.js'
import {
  WORKBENCH_LAYOUT_STORAGE_KEY,
  applyDrafts,
  createWorkbenchState,
  getSelectedDraft,
  getVisibleDrafts,
  normalizeWorkbenchLayout,
  publishDraftAndSelectNext,
  selectDraft,
  shuffleDrafts,
  setWorkbenchFilter,
  setWorkbenchLayout,
  setWorkbenchSettingsOpen,
} from '../content/workbench-state.js'
import { copyText } from '../content/workbench-clipboard.js'
import * as workbenchRuntime from '../content/workbench-runtime.js'

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

test('normalizes and stores stack or split layout', () => {
  assert.equal(WORKBENCH_LAYOUT_STORAGE_KEY, 'shuceWorkbenchLayout')
  assert.equal(normalizeWorkbenchLayout('split'), 'split')
  assert.equal(normalizeWorkbenchLayout('stack'), 'stack')
  assert.equal(normalizeWorkbenchLayout('weird'), 'stack')
  assert.equal(createWorkbenchState().layout, 'stack')
  assert.equal(setWorkbenchLayout(createWorkbenchState(), 'split').layout, 'split')
})

test('selects newest ready draft and applies filters', () => {
  let state = applyDrafts(createWorkbenchState(), rawDrafts)

  assert.equal(getSelectedDraft(state).id, 2)

  state = setWorkbenchFilter(state, { query: 'Agent' })
  assert.deepEqual(getVisibleDrafts(state).map(draft => draft.id), [1])

  state = setWorkbenchFilter(state, { query: '', type: 'x' })
  assert.deepEqual(getVisibleDrafts(state).map(draft => draft.id), [2])
})

test('shuffles current order without changing selection or filters', () => {
  let state = applyDrafts(createWorkbenchState(), [rawDrafts[0], rawDrafts[1]])
  state = setWorkbenchFilter(selectDraft(state, 1), { query: 'Agent', type: 'article' })
  const shuffled = shuffleDrafts(state, () => 0)

  assert.deepEqual(shuffled.drafts.map(draft => draft.id), [1, 2])
  assert.equal(shuffled.selectedId, 1)
  assert.equal(shuffled.query, 'Agent')
  assert.equal(shuffled.type, 'article')
  assert.notEqual(shuffled.drafts, state.drafts)
})

test('publishing after a shuffle keeps the remaining shuffled order', () => {
  const third = { ...rawDrafts[0], id: 4, title: '第三条', updated_at: '2026-08-08T09:00:00Z' }
  let state = applyDrafts(createWorkbenchState(), [rawDrafts[0], rawDrafts[1], third])
  state = shuffleDrafts(state, () => 0)
  state = selectDraft(state, state.drafts[1].id)
  const next = publishDraftAndSelectNext(state, state.selectedId)

  assert.deepEqual(next.drafts.map(draft => draft.id), [1, 2])
})

test('refreshing with applyDrafts restores server time order after a shuffle', () => {
  let state = shuffleDrafts(applyDrafts(createWorkbenchState(), rawDrafts), () => 0)
  state = applyDrafts(state, [...rawDrafts].reverse())

  assert.deepEqual(state.drafts.map(draft => draft.id), [2, 1])
})

function maxRun(values, wanted) {
  let longest = 0
  let current = 0
  for (const value of values) {
    if (value === wanted) {
      current += 1
      longest = Math.max(longest, current)
    } else {
      current = 0
    }
  }
  return longest
}

test('interleaves multimedia and text drafts at the current list ratio', () => {
  const drafts = [
    { id: 'm1', content: '![a](http://x/a.png)', status: 'ready' },
    { id: 'm2', content: '![b](http://x/b.png)', status: 'ready' },
    { id: 't1', content: '纯文字一', status: 'ready' },
    { id: 't2', content: '纯文字二', status: 'ready' },
    { id: 't3', content: '纯文字三', status: 'ready' },
    { id: 't4', content: '纯文字四', status: 'ready' },
  ]
  const state = { ...createWorkbenchState(), drafts, selectedId: 'm1', query: '封面' }
  const shuffled = shuffleDrafts(state, () => 0)

  assert.deepEqual(shuffled.drafts.map(draft => draft.id), ['t2', 'm2', 't3', 't4', 'm1', 't1'])
  assert.equal(shuffled.selectedId, 'm1')
  assert.equal(shuffled.query, '封面')
  assert.notEqual(shuffled.drafts, state.drafts)
})

test('keeps media and text run lengths within the existing frequency', () => {
  const drafts = [
    { id: 'm1', content: '![a](http://x/a.png)', status: 'ready' },
    { id: 'm2', content: '![b](http://x/b.png)', status: 'ready' },
    { id: 'm3', content: '<img src="http://x/c.png">', status: 'ready' },
    { id: 't1', content: '纯文字一', status: 'ready' },
    { id: 't2', content: '纯文字二', status: 'ready' },
    { id: 't3', content: '纯文字三', status: 'ready' },
    { id: 't4', content: '纯文字四', status: 'ready' },
    { id: 't5', content: '纯文字五', status: 'ready' },
    { id: 't6', content: '纯文字六', status: 'ready' },
    { id: 't7', content: '纯文字七', status: 'ready' },
  ]
  const shuffled = shuffleDrafts({ ...createWorkbenchState(), drafts }, () => 0.31)
  const kinds = shuffled.drafts.map(draft => (draftHasMedia(draft) ? 'm' : 't'))

  assert.equal(kinds.filter(kind => kind === 'm').length, 3)
  assert.equal(kinds.filter(kind => kind === 't').length, 7)
  assert.ok(maxRun(kinds, 'm') <= 1)
  assert.ok(maxRun(kinds, 't') <= 3)
  assert.deepEqual(
    shuffled.drafts.map(draft => draft.id).sort(),
    drafts.map(draft => draft.id).sort(),
  )
})

test('preserves selection across refresh and toggles settings', () => {
  let state = selectDraft(applyDrafts(createWorkbenchState(), rawDrafts), 1)
  state = applyDrafts(state, [...rawDrafts].reverse())

  assert.equal(getSelectedDraft(state).id, 1)
  assert.equal(setWorkbenchSettingsOpen(state, true).settingsOpen, true)
})

test('removes the published draft and selects the next visible draft', () => {
  let state = applyDrafts(createWorkbenchState(), [rawDrafts[0], rawDrafts[1]])
  state = selectDraft(state, 2)

  const next = publishDraftAndSelectNext(state, 2)

  assert.deepEqual(next.drafts.map(draft => draft.id), [1])
  assert.equal(next.selectedId, 1)
  assert.equal(next.copyState, 'idle')
})

test('does not wrap to the first draft after publishing the last item', () => {
  let state = applyDrafts(createWorkbenchState(), [rawDrafts[0], rawDrafts[1]])
  state = selectDraft(state, 1)

  const next = publishDraftAndSelectNext(state, 1)

  assert.deepEqual(next.drafts.map(draft => draft.id), [2])
  assert.equal(next.selectedId, null)
})

test('uses the current filtered result when choosing the next item', () => {
  const filteredNext = {
    id: 4,
    title: '下一条 X',
    content: 'X 2',
    status: 'ready',
    draft_type: 'x',
    updated_at: '2026-08-08T09:00:00Z',
  }
  let state = applyDrafts(createWorkbenchState(), [rawDrafts[0], rawDrafts[1], filteredNext])
  state = setWorkbenchFilter(state, { type: 'x' })
  state = selectDraft(state, 2)

  const next = publishDraftAndSelectNext(state, 2)

  assert.deepEqual(next.drafts.map(draft => draft.id), [1, 4])
  assert.equal(next.selectedId, 4)
  assert.deepEqual(getVisibleDrafts(next).map(draft => draft.id), [4])
})

test('does not remove a draft that is outside the current visible result', () => {
  let state = applyDrafts(createWorkbenchState(), [rawDrafts[0], rawDrafts[1]])
  state = setWorkbenchFilter(state, { type: 'x' })
  state = selectDraft(state, 1)

  const next = publishDraftAndSelectNext(state, 1)

  assert.equal(next, state)
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

test('fully hides the empty preview once a short draft is selected', () => {
  assert.equal(typeof workbenchRuntime.syncPreviewVisibility, 'function')

  const previewEmpty = { hidden: false, style: { display: '' } }
  const preview = { hidden: true }

  workbenchRuntime.syncPreviewVisibility({ previewEmpty, preview, hasDraft: true })

  assert.equal(previewEmpty.hidden, true)
  assert.equal(previewEmpty.style.display, 'none')
  assert.equal(preview.hidden, false)
})

test('uses the markdown renderer and rich markdown copy in the preview', async () => {
  const source = await readFile(new URL('../content/workbench-runtime.js', import.meta.url), 'utf8')

  assert.match(source, /import \{ hydrateMarkdownImages, renderMarkdown \} from ['"]\.\/markdown-renderer\.js['"]/)
  assert.match(source, /hydrateMarkdownImages\(rendered\.element/)
  assert.match(source, /import \{ copyMarkdown \} from ['"]\.\/workbench-clipboard\.js['"]/)
  assert.match(source, /<div class="sw-preview-content">/)
  assert.match(source, /<div data-role="preview-content"><\/div>/)
  assert.match(source, /复制 Markdown/)
})

test('requests API host permission before saving a custom API address', async () => {
  const source = await readFile(new URL('../content/workbench-runtime.js', import.meta.url), 'utf8')

  assert.match(source, /permissions: chromeApi\.permissions/)
  assert.match(source, /client\.requestApiPermission\(settingsDraft\)/)
  assert.match(source, /支持任意 HTTP\/HTTPS API/)
  assert.doesNotMatch(source, /只允许本机 8000 端口/)
})

test('only remounts preview markdown when the selected draft body or API base changes', () => {
  const draft = { id: 9, content: '![封面](/api/uploads/cover.png)' }
  const apiBase = 'http://localhost:8000/api'
  const key = workbenchRuntime.getPreviewMountKey(draft, apiBase)

  assert.equal(
    workbenchRuntime.getPreviewMountKey({ ...draft, title: '新标题' }, apiBase),
    key,
  )
  assert.equal(
    workbenchRuntime.shouldRemountPreview(key, workbenchRuntime.getPreviewMountKey(draft, apiBase)),
    false,
  )
  assert.equal(
    workbenchRuntime.shouldRemountPreview(
      key,
      workbenchRuntime.getPreviewMountKey({ ...draft, content: '改过的正文' }, apiBase),
    ),
    true,
  )
  assert.equal(
    workbenchRuntime.shouldRemountPreview(
      key,
      workbenchRuntime.getPreviewMountKey(draft, 'http://127.0.0.1:8000/api'),
    ),
    true,
  )
  assert.equal(workbenchRuntime.getPreviewMountKey(null, apiBase), '')
})

test('skips remounting hydrated preview images on unrelated chrome updates', async () => {
  const source = await readFile(new URL('../content/workbench-runtime.js', import.meta.url), 'utf8')

  assert.match(source, /getPreviewMountKey\(draft, state\.apiBase\)/)
  assert.match(source, /shouldRemountPreview\(previewMountKey, nextKey\)/)
  assert.match(source, /cache:\s*previewImageCache/)
})

test('provides an in-memory draft shuffle control', async () => {
  const source = await readFile(new URL('../content/workbench-runtime.js', import.meta.url), 'utf8')

  assert.match(source, /data-action="shuffle"/)
  assert.match(source, /title="按图文比例重新排序"/)
  assert.match(source, /shuffleDrafts\(state\)/)
})

test('exposes a persisted layout toggle in the side panel runtime', async () => {
  const source = await readFile(new URL('../content/workbench-runtime.js', import.meta.url), 'utf8')
  assert.match(source, /WORKBENCH_LAYOUT_STORAGE_KEY/)
  assert.match(source, /setWorkbenchLayout/)
  assert.match(source, /data-action="layout"/)
})
