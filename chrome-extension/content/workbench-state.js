import { draftHasMedia, filterDrafts, selectReadyDrafts } from './draft-model.js'

export const DEFAULT_WORKBENCH_API_BASE = 'http://localhost:8000/api'
export const WORKBENCH_LAYOUT_STORAGE_KEY = 'shuceWorkbenchLayout'

function sameId(left, right) {
  return left !== null && left !== undefined
    && right !== null && right !== undefined
    && String(left) === String(right)
}

export function normalizeWorkbenchLayout(value) {
  return value === 'split' ? 'split' : 'stack'
}

export function setWorkbenchLayout(state, layout) {
  return { ...state, layout: normalizeWorkbenchLayout(layout) }
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
    publishingId: null,
    layout: 'stack',
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

function shuffleInPlace(items, random) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[items[index], items[target]] = [items[target], items[index]]
  }
  return items
}

function interleaveByExistingRatio(media, text) {
  const result = []
  let mediaUsed = 0
  let textUsed = 0
  const mediaTotal = media.length
  const textTotal = text.length
  const total = mediaTotal + textTotal

  for (let index = 0; index < total; index += 1) {
    const mediaLeft = mediaTotal - mediaUsed
    const textLeft = textTotal - textUsed
    if (mediaLeft === 0) {
      result.push(text[textUsed])
      textUsed += 1
      continue
    }
    if (textLeft === 0) {
      result.push(media[mediaUsed])
      mediaUsed += 1
      continue
    }

    const mediaShare = mediaUsed / mediaTotal
    const textShare = textUsed / textTotal
    const pickMedia = mediaShare < textShare
      || (mediaShare === textShare && mediaLeft > textLeft)

    if (pickMedia) {
      result.push(media[mediaUsed])
      mediaUsed += 1
    } else {
      result.push(text[textUsed])
      textUsed += 1
    }
  }

  return result
}

export function shuffleDrafts(state, random = Math.random) {
  const media = []
  const text = []
  for (const draft of state.drafts) {
    if (draftHasMedia(draft)) media.push(draft)
    else text.push(draft)
  }
  shuffleInPlace(media, random)
  shuffleInPlace(text, random)
  return { ...state, drafts: interleaveByExistingRatio(media, text) }
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

export function publishDraftAndSelectNext(state, draftId) {
  const visible = getVisibleDrafts(state)
  const index = visible.findIndex(draft => sameId(draft.id, draftId))
  if (index < 0) return state

  return {
    ...state,
    drafts: state.drafts.filter(draft => !sameId(draft.id, draftId)),
    selectedId: visible[index + 1]?.id ?? null,
    copyState: 'idle',
    publishingId: null,
    error: null,
  }
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
