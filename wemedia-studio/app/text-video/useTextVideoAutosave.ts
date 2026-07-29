'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  TextVideoApiError,
  type TextVideoProject,
  type TextVideoProjectUpdate,
} from '@/lib/api/text-videos'

export type TextVideoSaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'

export type TextVideoFlushResult = {
  project: TextVideoProject
  dirtyVersion: number
}

type SaveFunction = (
  projectId: number,
  update: TextVideoProjectUpdate,
) => Promise<TextVideoProject>

function editableProjectUpdate(
  project: TextVideoProject,
  revision: number,
): TextVideoProjectUpdate {
  return {
    revision,
    title: project.title,
    stage: project.stage,
    script: project.script,
    voice_settings: project.voice_settings,
    paragraphs: project.paragraphs.map(({ id, text }) => ({ id, text })),
    speech_split_mode: project.speech_split_mode,
    composition: project.render_input.composition,
    template: {
      templateId: project.render_input.templateId,
      templateVersion: project.render_input.templateVersion,
      templateProps: project.render_input.templateProps,
    },
    scene_plan: {
      scenes: project.scene_plan.scenes,
    },
  }
}

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
  const latestSavedProjectRef = useRef(project)
  const inFlightRef = useRef<Promise<TextVideoFlushResult> | null>(null)

  useEffect(() => {
    projectRef.current = project
    if (dirtyVersionRef.current === savedVersionRef.current) {
      revisionRef.current = project.revision
      latestSavedProjectRef.current = project
    }
  }, [project])

  const markDirty = useCallback(() => {
    dirtyVersionRef.current += 1
    setDirtyVersion(dirtyVersionRef.current)
    setSaveState('dirty')
  }, [])

  const runSaveLoop = useCallback(async (): Promise<TextVideoFlushResult> => {
    let savedProject = latestSavedProjectRef.current

    while (savedVersionRef.current < dirtyVersionRef.current) {
      const snapshot = projectRef.current
      const savingVersion = dirtyVersionRef.current
      setSaveState('saving')

      try {
        const updated = await save(
          snapshot.id,
          editableProjectUpdate(snapshot, revisionRef.current),
        )
        revisionRef.current = updated.revision
        savedVersionRef.current = savingVersion
        latestSavedProjectRef.current = updated
        savedProject = updated
        onRevision(updated.revision)
        setConflictRevision(null)
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
        throw error
      }
    }

    setSaveState('saved')
    return {
      project: savedProject,
      dirtyVersion: savedVersionRef.current,
    }
  }, [onRevision, save])

  const flush = useCallback((): Promise<TextVideoFlushResult> => {
    if (inFlightRef.current) return inFlightRef.current
    if (dirtyVersionRef.current === savedVersionRef.current) {
      return Promise.resolve({
        project: latestSavedProjectRef.current,
        dirtyVersion: savedVersionRef.current,
      })
    }

    const operation = runSaveLoop().finally(() => {
      if (inFlightRef.current === operation) inFlightRef.current = null
    })
    inFlightRef.current = operation
    return operation
  }, [runSaveLoop])

  const retry = useCallback(async () => {
    setSaveState('dirty')
    return flush()
  }, [flush])

  const acceptConflictRevision = useCallback((revision: number) => {
    revisionRef.current = revision
    setConflictRevision(null)
    setSaveState('dirty')
  }, [])

  useEffect(() => {
    if (dirtyVersion === savedVersionRef.current || saveState !== 'dirty') return
    const timer = window.setTimeout(() => {
      void flush().catch(() => undefined)
    }, debounceMs)
    return () => window.clearTimeout(timer)
  }, [debounceMs, dirtyVersion, flush, saveState])

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void flush().catch(() => undefined)
      }
    }
    window.addEventListener('keydown', handleSaveShortcut)
    return () => window.removeEventListener('keydown', handleSaveShortcut)
  }, [flush])

  return {
    saveState,
    markDirty,
    flush,
    saveNow: flush,
    isDirty: () => dirtyVersionRef.current !== savedVersionRef.current,
    getDirtyVersion: () => dirtyVersionRef.current,
    retry,
    conflictRevision,
    acceptConflictRevision,
  }
}
