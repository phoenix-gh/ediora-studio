'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  TextVideoApiError,
  type TextVideoProject,
  type TextVideoProjectUpdate,
} from '@/lib/api/text-videos'

export type TextVideoSaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

type SaveFunction = (
  projectId: number,
  update: TextVideoProjectUpdate,
) => Promise<TextVideoProject>

export function useTextVideoAutosave({
  project,
  save,
  onRevision,
  debounceMs = 800,
}: {
  project: TextVideoProject
  save: SaveFunction
  onRevision: (revision: number) => void
  debounceMs?: number
}) {
  const [saveState, setSaveState] = useState<TextVideoSaveState>('saved')
  const [dirtyVersion, setDirtyVersion] = useState(0)
  const [conflictRevision, setConflictRevision] = useState<number | null>(null)
  const projectRef = useRef(project)
  const revisionRef = useRef(project.revision)
  const dirtyVersionRef = useRef(0)
  const savedVersionRef = useRef(0)
  const savingRef = useRef(false)

  useEffect(() => {
    projectRef.current = project
    if (saveState === 'saved') revisionRef.current = project.revision
  }, [project, saveState])

  const markDirty = useCallback(() => {
    dirtyVersionRef.current += 1
    setDirtyVersion(dirtyVersionRef.current)
    setSaveState('dirty')
  }, [])

  const saveNow = useCallback(async () => {
    if (savingRef.current || dirtyVersionRef.current === savedVersionRef.current) return
    const snapshot = projectRef.current
    const savingVersion = dirtyVersionRef.current
    savingRef.current = true
    setSaveState('saving')
    try {
      const updated = await save(snapshot.id, {
        revision: revisionRef.current,
        title: snapshot.title,
        status: snapshot.status,
        stage: snapshot.stage,
        script: snapshot.script,
        voice_settings: snapshot.voice_settings,
        paragraphs: snapshot.paragraphs,
        render_input: snapshot.render_input,
        cover_asset_url: snapshot.cover_asset_url,
        output_asset_url: snapshot.output_asset_url,
      })
      revisionRef.current = updated.revision
      savedVersionRef.current = savingVersion
      onRevision(updated.revision)
      setConflictRevision(null)
      setSaveState(
        dirtyVersionRef.current === savingVersion ? 'saved' : 'dirty',
      )
    } catch (error) {
      if (error instanceof TextVideoApiError && error.status === 409) {
        const detail = error.detail
        const revision = typeof detail === 'object' && detail && 'revision' in detail
          ? Number(detail.revision)
          : null
        setConflictRevision(Number.isSafeInteger(revision) ? revision : null)
        setSaveState('conflict')
      } else {
        setSaveState('error')
      }
    } finally {
      savingRef.current = false
    }
  }, [onRevision, save])

  const retry = useCallback(async () => {
    setSaveState('dirty')
    await saveNow()
  }, [saveNow])

  const acceptConflictRevision = useCallback((revision: number) => {
    revisionRef.current = revision
    setConflictRevision(null)
    setSaveState('dirty')
  }, [])

  useEffect(() => {
    if (dirtyVersion === savedVersionRef.current || saveState !== 'dirty') return
    const timer = window.setTimeout(() => {
      void saveNow()
    }, debounceMs)
    return () => window.clearTimeout(timer)
  }, [debounceMs, dirtyVersion, project, saveNow, saveState])

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveNow()
      }
    }
    window.addEventListener('keydown', handleSaveShortcut)
    return () => window.removeEventListener('keydown', handleSaveShortcut)
  }, [saveNow])

  return {
    saveState,
    markDirty,
    saveNow,
    retry,
    conflictRevision,
    acceptConflictRevision,
  }
}
