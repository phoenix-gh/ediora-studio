import { filterDrafts, selectReadyDrafts } from './draft-model.js'

export const DEFAULT_WORKBENCH_API_BASE = 'http://localhost:8000/api'

function sameId(left, right) {
  return left !== null && left !== undefined
    && right !== null && right !== undefined
    && String(left) === String(right)
}

export function createWorkbenchState({ apiBase = DEFAULT_WORKBENCH_API_BASE } = {}) {
  return {
    open: false,
    loading: false,
    error: null,
    drafts: [],
    selectedId: null,
    query: '',
    type: 'all',
    settingsOpen: false,
    apiBase,
    copyState: 'idle',
  }
}

export function applyDrafts(state, rawDrafts) {
  const drafts = selectReadyDrafts(rawDrafts)
  const selectedId = drafts.some(draft => sameId(draft.id, state.selectedId))
    ? state.selectedId
    : (drafts[0]?.id ?? null)

  return {
    ...state,
    drafts,
    selectedId,
    loading: false,
    error: null,
    copyState: 'idle',
  }
}

export function setWorkbenchFilter(state, patch = {}) {
  return {
    ...state,
    ...(patch.query === undefined ? {} : { query: String(patch.query ?? '') }),
    ...(patch.type === undefined ? {} : { type: String(patch.type || 'all') }),
  }
}

export function selectDraft(state, id) {
  if (!state.drafts.some(draft => sameId(draft.id, id))) return state
  return { ...state, selectedId: id, copyState: 'idle' }
}

export function getVisibleDrafts(state) {
  return filterDrafts(state.drafts, { query: state.query, type: state.type })
}

export function getSelectedDraft(state) {
  return state.drafts.find(draft => sameId(draft.id, state.selectedId)) || null
}

export function setWorkbenchSettingsOpen(state, open) {
  return { ...state, settingsOpen: open === true }
}
