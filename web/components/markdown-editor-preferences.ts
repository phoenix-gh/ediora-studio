'use client'

import { useSyncExternalStore } from 'react'

export type MarkdownEditorMode = 'visual' | 'source'
export type MarkdownEditorContentWidth = 30 | 50 | 100
export type MarkdownEditorContentAlign = 'left' | 'center' | 'right'

export type MarkdownEditorPreferences = {
  mode: MarkdownEditorMode
  width: MarkdownEditorContentWidth
  alignment: MarkdownEditorContentAlign
}

const STORAGE_KEY = 'ediora:markdown-editor-preferences:v1'
const DEFAULT_PREFERENCES: MarkdownEditorPreferences = {
  mode: 'visual',
  width: 100,
  alignment: 'left',
}
const listeners = new Set<() => void>()
let cachedStorage: Storage | undefined
let cachedRaw: string | null | undefined
let cachedPreferences = DEFAULT_PREFERENCES
let volatileBackingRaw: string | null | undefined
let volatilePreferences: MarkdownEditorPreferences | undefined

function parsePreferences(raw: string | null): MarkdownEditorPreferences {
  if (!raw) return DEFAULT_PREFERENCES
  try {
    const value = JSON.parse(raw) as Partial<MarkdownEditorPreferences>
    if ((value.mode !== 'visual' && value.mode !== 'source')
      || (value.width !== 30 && value.width !== 50 && value.width !== 100)
      || (value.alignment !== 'left' && value.alignment !== 'center' && value.alignment !== 'right')) {
      return DEFAULT_PREFERENCES
    }
    return {
      mode: value.mode,
      width: value.width,
      alignment: value.alignment,
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

function readStoredPreferences() {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCES
  let raw: string | null = null
  try {
    const storage = window.localStorage
    if (storage !== cachedStorage) {
      cachedStorage = storage
      cachedRaw = undefined
      cachedPreferences = DEFAULT_PREFERENCES
      volatileBackingRaw = undefined
      volatilePreferences = undefined
    }
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return cachedPreferences
  }
  if (volatilePreferences && raw === volatileBackingRaw) return volatilePreferences
  volatileBackingRaw = undefined
  volatilePreferences = undefined
  if (raw === cachedRaw) return cachedPreferences
  cachedRaw = raw
  cachedPreferences = parsePreferences(raw)
  return cachedPreferences
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function updatePreferences(
  update: MarkdownEditorPreferences | ((current: MarkdownEditorPreferences) => MarkdownEditorPreferences),
) {
  const current = cachedPreferences
  const next = typeof update === 'function' ? update(current) : update
  const raw = JSON.stringify(next)
  if (raw === JSON.stringify(current)) return
  try {
    const storage = window.localStorage
    storage.setItem(STORAGE_KEY, raw)
    cachedStorage = storage
    cachedRaw = raw
    volatileBackingRaw = undefined
    volatilePreferences = undefined
  } catch {
    volatileBackingRaw = cachedRaw ?? null
    volatilePreferences = next
  }
  cachedPreferences = next
  listeners.forEach(listener => listener())
}

export function useMarkdownEditorPreferences() {
  const preferences = useSyncExternalStore(
    subscribe,
    readStoredPreferences,
    () => DEFAULT_PREFERENCES,
  )
  return [preferences, updatePreferences] as const
}
