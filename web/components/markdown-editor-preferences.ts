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
let cachedRaw: string | null | undefined
let cachedPreferences = DEFAULT_PREFERENCES

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
    raw = window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return cachedPreferences
  }
  if (raw === cachedRaw) return cachedPreferences
  cachedRaw = raw
  cachedPreferences = parsePreferences(raw)
  return cachedPreferences
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return
    cachedRaw = undefined
    listener()
  }
  window.addEventListener('storage', handleStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', handleStorage)
  }
}

function updatePreferences(
  update: MarkdownEditorPreferences | ((current: MarkdownEditorPreferences) => MarkdownEditorPreferences),
) {
  const current = readStoredPreferences()
  const next = typeof update === 'function' ? update(current) : update
  const raw = JSON.stringify(next)
  if (raw === cachedRaw) return
  try {
    window.localStorage.setItem(STORAGE_KEY, raw)
  } catch {
    // Keep the preference for this session when storage is unavailable.
  }
  cachedRaw = raw
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
