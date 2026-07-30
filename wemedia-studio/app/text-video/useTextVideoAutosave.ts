'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import {
  TextVideoApiError,
  type TextVideoProject,
  type TextVideoProjectUpdate,
} from '@/lib/api/text-videos'
import { mergeWorkerProject } from '@/lib/text-video/project-merge'

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
  baseline: TextVideoProject,
  revision: number,
): TextVideoProjectUpdate {
  const update: TextVideoProjectUpdate = { revision }
  const equal = (left: unknown, right: unknown) => (
    JSON.stringify(left) === JSON.stringify(right)
  )
  const paragraphs = project.paragraphs.map(
    ({ id, text }) => ({ id, text }),
  )
  const baselineParagraphs = baseline.paragraphs.map(
    ({ id, text }) => ({ id, text }),
  )
  const template = {
    templateId: project.render_input.templateId,
    templateVersion: project.render_input.templateVersion,
    templateProps: project.render_input.templateProps,
  }
  const baselineTemplate = {
    templateId: baseline.render_input.templateId,
    templateVersion: baseline.render_input.templateVersion,
    templateProps: baseline.render_input.templateProps,
  }

  if (project.title !== baseline.title) update.title = project.title
  if (project.status !== baseline.status) update.status = project.status
  if (project.stage !== baseline.stage) update.stage = project.stage
  if (project.script !== baseline.script) update.script = project.script
  if (!equal(project.voice_settings, baseline.voice_settings)) {
    update.voice_settings = project.voice_settings
  }
  if (!equal(paragraphs, baselineParagraphs)) {
    update.paragraphs = paragraphs
  }
  if (project.speech_split_mode !== baseline.speech_split_mode) {
    update.speech_split_mode = project.speech_split_mode
  }
  if (!equal(
    project.render_input.composition,
    baseline.render_input.composition,
  )) {
    update.composition = project.render_input.composition
  }
  if (!equal(template, baselineTemplate)) update.template = template
  if (!equal(project.scene_plan.scenes, baseline.scene_plan.scenes)) {
    update.scene_plan = {
      generation_revision: baseline.scene_plan.generation_revision,
      scenes: project.scene_plan.scenes,
    }
  }
  if (project.cover_asset_url !== baseline.cover_asset_url) {
    update.cover_asset_url = project.cover_asset_url
  }
  if (project.output_asset_url !== baseline.output_asset_url) {
    update.output_asset_url = project.output_asset_url
  }
  return update
}

export function useTextVideoAutosave({
  project,
  save,
  onRevision,
  onSavedProject,
  debounceMs = 800,
}: {
  project: TextVideoProject
  save: SaveFunction
  onRevision?: (revision: number) => void
  onSavedProject?: (project: TextVideoProject) => void
  debounceMs?: number
}) {
  const [saveState, setSaveState] = useState<TextVideoSaveState>('saved')
  const [dirtyVersion, setDirtyVersion] = useState(0)
  const [conflictRevision, setConflictRevision] = useState<number | null>(null)
  const projectRef = useRef(project)
  const revisionRef = useRef(project.revision)
  const dirtyVersionRef = useRef(0)
  const savedVersionRef = useRef(0)
  const editableBaselineRef = useRef(project)
  const latestSavedProjectRef = useRef(project)
  const pendingSavedEchoRef = useRef<{
    canonical: TextVideoProject
    editableBaseline: TextVideoProject
  } | null>(null)
  const inFlightRef = useRef<Promise<TextVideoFlushResult> | null>(null)

  useEffect(() => {
    const pending = pendingSavedEchoRef.current
    if (pending && project.revision === pending.canonical.revision) {
      projectRef.current = mergeWorkerProject(
        project,
        pending.canonical,
        {
          editableBaseline: pending.editableBaseline,
          localDirty: (
            dirtyVersionRef.current !== savedVersionRef.current
          ),
        },
      )
      pendingSavedEchoRef.current = null
      if (dirtyVersionRef.current === savedVersionRef.current) {
        revisionRef.current = pending.canonical.revision
        editableBaselineRef.current = pending.canonical
        latestSavedProjectRef.current = pending.canonical
      }
      return
    }

    projectRef.current = project
    if (dirtyVersionRef.current === savedVersionRef.current) {
      revisionRef.current = project.revision
      editableBaselineRef.current = project
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
      const editableBaseline = editableBaselineRef.current
      const savingVersion = dirtyVersionRef.current
      setSaveState('saving')

      try {
        const updated = await save(
          snapshot.id,
          editableProjectUpdate(
            snapshot,
            editableBaseline,
            revisionRef.current,
          ),
        )
        const canonical = mergeWorkerProject(
          snapshot,
          updated,
          {
            editableBaseline: snapshot,
            localDirty: false,
          },
        )
        const merged = mergeWorkerProject(
          projectRef.current,
          updated,
          {
            editableBaseline: snapshot,
            localDirty: (
              dirtyVersionRef.current > savingVersion
            ),
          },
        )
        revisionRef.current = updated.revision
        savedVersionRef.current = savingVersion
        editableBaselineRef.current = canonical
        latestSavedProjectRef.current = canonical
        projectRef.current = merged
        pendingSavedEchoRef.current = {
          canonical,
          editableBaseline: snapshot,
        }
        savedProject = canonical
        onSavedProject?.(merged)
        onRevision?.(updated.revision)
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
  }, [onRevision, onSavedProject, save])

  const adoptServerProject = useCallback((
    server: TextVideoProject,
    editableBaseline: TextVideoProject,
    localProject: TextVideoProject = projectRef.current,
  ): TextVideoProject => {
    const canonical = mergeWorkerProject(
      latestSavedProjectRef.current,
      server,
      {
        editableBaseline,
        localDirty: false,
      },
    )
    const merged = mergeWorkerProject(
      localProject,
      server,
      {
        editableBaseline,
        localDirty: (
          dirtyVersionRef.current !== savedVersionRef.current
        ),
      },
    )
    editableBaselineRef.current = canonical
    latestSavedProjectRef.current = canonical
    projectRef.current = merged
    revisionRef.current = Math.max(
      revisionRef.current,
      server.revision,
    )
    return merged
  }, [])

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
    adoptServerProject,
  }
}
