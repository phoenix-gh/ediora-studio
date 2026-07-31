'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'

import { ApiError } from '@/lib/api/client'
import {
  getJob,
  retryJobStep,
  type ContentJob,
  type ContentJobStep,
} from '@/lib/api/jobs'
import {
  getTextVideoProject,
  TextVideoApiError,
  type TextVideoParagraph,
  type TextVideoProject,
} from '@/lib/api/text-videos'
import { mergeWorkerProject } from '@/lib/text-video/project-merge'

import type { TextVideoFlushResult } from './useTextVideoAutosave'

export type TextVideoJobLaunch = {
  jobs: Array<{
    id: number
    flow: string
    target_id: string | number
  }>
  project: TextVideoProject
}

export type TextVideoActionState = {
  status: 'idle' | 'running' | 'succeeded' | 'failed'
  error: string
  retryable: boolean
  jobId: number | null
  stepKey: string
  progress?: number
}

type AutosaveCoordinator = {
  flush(): Promise<TextVideoFlushResult>
  isDirty(): boolean
  getDirtyVersion(): number
  adoptServerProject?(
    server: TextVideoProject,
    editableBaseline: TextVideoProject,
    localProject?: TextVideoProject,
  ): TextVideoProject
}

type TimerWaiter = {
  timer: number
  resolve: (keepPolling: boolean) => void
}

type MergeContext = {
  editableBaseline: TextVideoProject
  dirtyVersion: number
}

type RecoveryProof = {
  proven: boolean
  jobIds: number[]
  failedError: string
}

const idleAction: TextVideoActionState = {
  status: 'idle',
  error: '',
  retryable: false,
  jobId: null,
  stepKey: '',
  progress: 0,
}

export class TextVideoActionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly jobId: number,
    readonly stepKey: string,
  ) {
    super(message)
    this.name = 'TextVideoActionError'
  }
}

class TextVideoActionOutcomeUnknownError extends TextVideoActionError {
  constructor() {
    super(
      '操作结果未知，请刷新作品状态后再决定是否重试',
      false,
      0,
      '',
    )
    this.name = 'TextVideoActionOutcomeUnknownError'
  }
}

function activeProjectJobIds(project: TextVideoProject): number[] {
  const ids = [
    ...project.paragraphs
      .filter(segment => segment.status === 'generating')
      .map(segment => segment.job_id),
    (
      project.master_audio.status === 'building'
      || project.master_audio.timeline_status === 'aligning'
    )
      ? project.master_audio.job_id
      : null,
    project.scene_plan.status === 'generating'
      ? project.scene_plan.job_id
      : null,
    (
      project.render_state.status === 'queued'
      || project.render_state.status === 'rendering'
    )
      ? project.render_state.job_id
      : null,
  ]
  return uniqueJobIds(ids)
}

function uniqueJobIds(ids: Array<number | null | undefined>): number[] {
  return [...new Set(ids.filter((id): id is number => (
    typeof id === 'number' && Number.isSafeInteger(id)
  )))]
}

function failedStep(job: ContentJob): ContentJobStep | undefined {
  return job.steps
    .filter(step => step.status === 'failed')
    .sort((left, right) => (
      right.attempt - left.attempt || right.id - left.id
    ))[0]
}

function actionError(jobs: ContentJob[]): TextVideoActionError | null {
  const failed = jobs.find(job => job.status === 'failed')
  if (failed) {
    const step = failedStep(failed)
    return new TextVideoActionError(
      step?.error || '任务执行失败',
      step?.retryable ?? false,
      failed.id,
      step?.key ?? '',
    )
  }
  const cancelled = jobs.find(job => job.status === 'cancelled')
  return cancelled
    ? new TextVideoActionError('任务已取消', false, cancelled.id, '')
    : null
}

function terminal(job: ContentJob): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(job.status)
}

function isDownstreamAction(
  upstreamKey: string,
  candidateKey: string,
): boolean {
  const isSceneAction = (key: string) => (
    key.startsWith('scene:') || key.startsWith('motion:')
  )
  if (upstreamKey.startsWith('speech:')) {
    return (
      candidateKey === 'master'
      || isSceneAction(candidateKey)
      || candidateKey.startsWith('render:')
    )
  }
  if (upstreamKey === 'master') {
    return (
      isSceneAction(candidateKey)
      || candidateKey.startsWith('render:')
    )
  }
  return (
    isSceneAction(upstreamKey)
    && candidateKey.startsWith('render:')
  )
}

function statusForError(error: unknown): number | null {
  if (error instanceof TextVideoApiError || error instanceof ApiError) {
    return error.status
  }
  return null
}

function ambiguousRequestError(error: unknown): boolean {
  const status = statusForError(error)
  return error instanceof TypeError || (status !== null && status >= 500)
}

function retryableRequestError(error: unknown): boolean {
  if (error instanceof TextVideoActionError) return error.retryable
  if (error instanceof TypeError) return true
  const status = statusForError(error)
  return status !== null && (
    status >= 500
    || status === 408
    || status === 429
  )
}

function actionStateForFailure(error: unknown): TextVideoActionState {
  return {
    status: 'failed',
    error: error instanceof Error ? error.message : '操作失败',
    retryable: retryableRequestError(error),
    jobId: error instanceof TextVideoActionError && error.jobId > 0
      ? error.jobId
      : null,
    stepKey: error instanceof TextVideoActionError ? error.stepKey : '',
  }
}

function speechTransitioned(
  before: TextVideoParagraph,
  after: TextVideoParagraph,
): boolean {
  if (before.text !== after.text) return false
  const identityChanged = (
    before.status !== after.status
    || before.job_id !== after.job_id
    || before.generation_revision !== after.generation_revision
    || before.source_hash !== after.source_hash
    || before.audio_url !== after.audio_url
  )
  return identityChanged && (
    (
      after.status === 'generating'
      && after.job_id !== null
      && after.source_hash.length > 0
    )
    || (
      ['ready', 'confirmed'].includes(after.status)
      && after.audio_url.length > 0
      && after.source_hash.length > 0
    )
    || (
      after.status === 'failed'
      && after.error.length > 0
      && after.source_hash.length > 0
    )
  )
}

function speechFingerprint(segment: TextVideoParagraph | undefined) {
  if (!segment) return null
  return {
    id: segment.id,
    text: segment.text,
    status: segment.status,
    audio_url: segment.audio_url,
    source_hash: segment.source_hash,
    generation_revision: segment.generation_revision,
    error: segment.error,
    job_id: segment.job_id,
  }
}

function requestStateUnchanged(
  key: string,
  before: TextVideoProject,
  after: TextVideoProject,
): boolean {
  if (key === 'speech:pending') {
    const pendingIds = before.paragraphs
      .filter(segment => (
        segment.text.trim()
        && (segment.status === 'draft' || segment.status === 'failed')
      ))
      .map(segment => segment.id)
    return pendingIds.every(id => (
      JSON.stringify(speechFingerprint(
        before.paragraphs.find(segment => segment.id === id),
      )) === JSON.stringify(speechFingerprint(
        after.paragraphs.find(segment => segment.id === id),
      ))
    ))
  }
  if (key.startsWith('speech:')) {
    const segmentId = key.slice('speech:'.length)
    return JSON.stringify(speechFingerprint(
      before.paragraphs.find(segment => segment.id === segmentId),
    )) === JSON.stringify(speechFingerprint(
      after.paragraphs.find(segment => segment.id === segmentId),
    ))
  }
  if (key === 'master') {
    return JSON.stringify(before.master_audio) === JSON.stringify(
      after.master_audio,
    )
  }
  if (key.startsWith('scene:') || key.startsWith('motion:')) {
    return JSON.stringify(before.scene_plan) === JSON.stringify(
      after.scene_plan,
    )
  }
  if (key.startsWith('split:')) {
    return (
      before.revision === after.revision
      && before.script === after.script
      && JSON.stringify(before.paragraphs.map(({ id, text }) => ({ id, text })))
        === JSON.stringify(after.paragraphs.map(({ id, text }) => ({ id, text })))
    )
  }
  if (key.startsWith('render:')) {
    return JSON.stringify(before.render_state) === JSON.stringify(
      after.render_state,
    )
  }
  return false
}

function requestSpecificRecoveryProof(
  key: string,
  before: TextVideoProject,
  after: TextVideoProject,
): RecoveryProof {
  if (key === 'speech:pending') {
    const pending = before.paragraphs.filter(segment => (
      segment.text.trim()
      && (segment.status === 'draft' || segment.status === 'failed')
    ))
    const transitioned = pending.map(segment => {
      const current = after.paragraphs.find(item => item.id === segment.id)
      return current && speechTransitioned(segment, current) ? current : null
    })
    return {
      proven: pending.length > 0 && transitioned.every(Boolean),
      jobIds: uniqueJobIds(transitioned.map(segment => segment?.job_id)),
      failedError: transitioned.find(
        segment => segment?.status === 'failed',
      )?.error ?? '',
    }
  }

  if (key.startsWith('speech:')) {
    const segmentId = key.slice('speech:'.length)
    const prior = before.paragraphs.find(segment => segment.id === segmentId)
    const current = after.paragraphs.find(segment => segment.id === segmentId)
    return {
      proven: Boolean(
        prior
        && current
        && speechTransitioned(prior, current),
      ),
      jobIds: uniqueJobIds([current?.job_id]),
      failedError: current?.status === 'failed' ? current.error : '',
    }
  }

  if (key === 'master') {
    const prior = before.master_audio
    const current = after.master_audio
    const identityChanged = JSON.stringify({
      status: prior.status,
      timeline_status: prior.timeline_status,
      source_hash: prior.source_hash,
      job_id: prior.job_id,
      repair_generation: prior.repair_generation,
      audio_url: prior.audio_url,
    }) !== JSON.stringify({
      status: current.status,
      timeline_status: current.timeline_status,
      source_hash: current.source_hash,
      job_id: current.job_id,
      repair_generation: current.repair_generation,
      audio_url: current.audio_url,
    })
    return {
      proven: identityChanged && (
        (current.status === 'building' && current.job_id !== null)
        || (
          current.status === 'ready'
          && current.audio_url.length > 0
        )
        || current.status === 'failed'
        || current.timeline_status === 'failed'
      ),
      jobIds: uniqueJobIds([current.job_id]),
      failedError: current.status === 'failed'
        ? current.error || '主音频生成失败'
        : current.timeline_status === 'failed'
          ? current.timeline_error || '时间轴生成失败'
          : '',
    }
  }

  if (key.startsWith('scene:') || key.startsWith('motion:')) {
    const prior = before.scene_plan
    const current = after.scene_plan
    return {
      proven: (
        (
          prior.generation_revision !== current.generation_revision
          || prior.job_id !== current.job_id
          || prior.status !== current.status
        )
        && (
          (current.status === 'generating' && current.job_id !== null)
          || current.status === 'ready'
          || current.status === 'failed'
        )
      ),
      jobIds: uniqueJobIds([current.job_id]),
      failedError: current.status === 'failed'
        ? current.error || '分镜生成失败'
        : '',
    }
  }

  if (key.startsWith('render:')) {
    const prior = before.render_state
    const current = after.render_state
    const identityChanged = JSON.stringify({
      status: prior.status,
      generation: prior.generation,
      job_id: prior.job_id,
      applied_job_id: prior.applied_job_id,
      source_hash: prior.source_hash,
      asset_id: prior.asset_id,
    }) !== JSON.stringify({
      status: current.status,
      generation: current.generation,
      job_id: current.job_id,
      applied_job_id: current.applied_job_id,
      source_hash: current.source_hash,
      asset_id: current.asset_id,
    })
    return {
      proven: identityChanged && (
        (
          ['queued', 'rendering'].includes(current.status)
          && current.job_id !== null
        )
        || current.status === 'ready'
        || current.status === 'failed'
      ),
      jobIds: uniqueJobIds([current.job_id]),
      failedError: current.status === 'failed'
        ? current.error || '视频渲染失败'
        : '',
    }
  }

  return { proven: false, jobIds: [], failedError: '' }
}

function textVideoRenderProgress(jobs: ContentJob[]): number | null {
  const renderJobs = jobs.filter(job => job.flow === 'text_video_render')
  if (renderJobs.length === 0) return null
  let progress = 0
  for (const job of renderJobs) {
    for (const step of job.steps) {
      const value = Number(step.output.progress)
      if (Number.isFinite(value)) {
        progress = Math.max(progress, Math.min(100, Math.floor(value)))
      }
    }
  }
  return progress
}

export function useTextVideoProjectActions({
  project,
  autosave,
  setProject,
  readProject = getTextVideoProject,
  readJob = getJob,
  retryStep = retryJobStep,
  pollIntervalMs = 1_500,
  recoverOnMount = true,
}: {
  project: TextVideoProject
  autosave: AutosaveCoordinator
  setProject: Dispatch<SetStateAction<TextVideoProject>>
  readProject?: (projectId: number) => Promise<TextVideoProject>
  readJob?: (jobId: number) => Promise<ContentJob>
  retryStep?: (jobId: number, stepKey: string) => Promise<ContentJob>
  pollIntervalMs?: number
  recoverOnMount?: boolean
}) {
  const [jobs, setJobs] = useState<Record<string, ContentJob>>({})
  const [actionStates, setActionStates] = useState<
    Record<string, TextVideoActionState>
  >({})
  const projectRef = useRef(project)
  const autosaveRef = useRef(autosave)
  const mountedRef = useRef(true)
  const generationsRef = useRef<Record<string, number>>({})
  const waitersRef = useRef<Record<string, TimerWaiter>>({})
  const operationsRef = useRef<Record<string, Promise<void>>>({})

  useEffect(() => {
    projectRef.current = project
  }, [project])
  useEffect(() => {
    autosaveRef.current = autosave
  }, [autosave])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      Object.keys(generationsRef.current).forEach(key => {
        generationsRef.current[key] += 1
      })
      Object.values(waitersRef.current).forEach(waiter => {
        window.clearTimeout(waiter.timer)
        waiter.resolve(false)
      })
      waitersRef.current = {}
      operationsRef.current = {}
    }
  }, [])

  const currentGeneration = useCallback((
    key: string,
    generation: number,
  ): boolean => (
    mountedRef.current
    && generationsRef.current[key] === generation
  ), [])

  const updateActionState = useCallback((
    key: string,
    generation: number,
    state: TextVideoActionState,
  ) => {
    if (!currentGeneration(key, generation)) return
    setActionStates(current => ({ ...current, [key]: state }))
  }, [currentGeneration])

  const mergeServerProject = useCallback((
    key: string,
    generation: number,
    server: TextVideoProject,
    context: MergeContext,
  ) => {
    if (!currentGeneration(key, generation)) return
    setProject(local => {
      if (!currentGeneration(key, generation)) return local
      const localDirty = (
        autosaveRef.current.isDirty()
        || autosaveRef.current.getDirtyVersion() > context.dirtyVersion
      )
      const merged = (
        autosaveRef.current.adoptServerProject?.(
          server,
          context.editableBaseline,
          local,
        )
        ?? mergeWorkerProject(local, server, {
          editableBaseline: context.editableBaseline,
          localDirty,
        })
      )
      projectRef.current = merged
      return merged
    })
  }, [currentGeneration, setProject])

  const beginGeneration = useCallback((key: string): number => {
    const prior = waitersRef.current[key]
    if (prior) {
      window.clearTimeout(prior.timer)
      prior.resolve(false)
      delete waitersRef.current[key]
    }
    const generation = (generationsRef.current[key] ?? 0) + 1
    generationsRef.current[key] = generation
    return generation
  }, [])

  const supersedeDownstreamActions = useCallback((key: string) => {
    const knownKeys = new Set([
      ...Object.keys(generationsRef.current),
      ...Object.keys(waitersRef.current),
      ...Object.keys(operationsRef.current),
    ])
    if (key.startsWith('speech:')) knownKeys.add('master')
    const downstreamKeys = [...knownKeys].filter(candidate => (
      isDownstreamAction(key, candidate)
    ))
    if (downstreamKeys.length === 0) return

    downstreamKeys.forEach(candidate => {
      const waiter = waitersRef.current[candidate]
      if (waiter) {
        window.clearTimeout(waiter.timer)
        waiter.resolve(false)
        delete waitersRef.current[candidate]
      }
      generationsRef.current[candidate] = (
        generationsRef.current[candidate] ?? 0
      ) + 1
      delete operationsRef.current[candidate]
    })
    setActionStates(current => {
      const next = { ...current }
      downstreamKeys.forEach(candidate => {
        if (candidate in next) next[candidate] = idleAction
      })
      return next
    })
  }, [])

  const waitForNextPoll = useCallback((
    key: string,
    generation: number,
  ): Promise<boolean> => new Promise(resolve => {
    if (!currentGeneration(key, generation)) {
      resolve(false)
      return
    }
    const timer = window.setTimeout(() => {
      delete waitersRef.current[key]
      resolve(currentGeneration(key, generation))
    }, pollIntervalMs)
    waitersRef.current[key] = { timer, resolve }
  }), [currentGeneration, pollIntervalMs])

  const readAndMergeLatest = useCallback(async (
    key: string,
    generation: number,
    context: MergeContext,
  ): Promise<TextVideoProject | null> => {
    const latest = await readProject(projectRef.current.id)
    if (!currentGeneration(key, generation)) return null
    mergeServerProject(key, generation, latest, context)
    return latest
  }, [currentGeneration, mergeServerProject, readProject])

  const pollProjectJobs = useCallback(async ({
    key,
    jobIds,
    context,
    generation,
    recoveredFailure = null,
  }: {
    key: string
    jobIds: number[]
    context: MergeContext
    generation: number
    recoveredFailure?: TextVideoActionError | null
  }): Promise<void> => {
    let currentIds = uniqueJobIds(jobIds)
    let pendingFailure = recoveredFailure
    while (currentGeneration(key, generation) && currentIds.length > 0) {
      let currentJobs: ContentJob[]
      try {
        currentJobs = await Promise.all(
          currentIds.map(id => readJob(id)),
        )
      } catch (error) {
        if (!currentGeneration(key, generation)) return
        if (!ambiguousRequestError(error)) {
          if (statusForError(error) === 404) {
            await readAndMergeLatest(key, generation, context)
          }
          throw error
        }

        const recovered = await readAndMergeLatest(
          key,
          generation,
          context,
        )
        if (!recovered || !currentGeneration(key, generation)) return
        const proof = requestSpecificRecoveryProof(
          key,
          context.editableBaseline,
          recovered,
        )
        if (!proof.proven) throw new TextVideoActionOutcomeUnknownError()
        if (proof.failedError) {
          pendingFailure = new TextVideoActionError(
            proof.failedError,
            false,
            0,
            '',
          )
        }
        if (proof.jobIds.length === 0) {
          if (pendingFailure) throw pendingFailure
          updateActionState(key, generation, {
            ...idleAction,
            status: 'succeeded',
          })
          return
        }
        currentIds = proof.jobIds
        if (!await waitForNextPoll(key, generation)) return
        continue
      }

      if (!currentGeneration(key, generation)) return
      setJobs(current => ({
        ...current,
        ...Object.fromEntries(currentJobs.map(job => [String(job.id), job])),
      }))
      const renderProgress = textVideoRenderProgress(currentJobs)
      if (
        renderProgress !== null
        && currentJobs.some(job => !terminal(job))
      ) {
        updateActionState(key, generation, {
          ...idleAction,
          status: 'running',
          jobId: currentJobs.find(
            job => job.flow === 'text_video_render',
          )?.id ?? null,
          progress: renderProgress,
        })
      }

      if (currentJobs.every(terminal)) {
        await readAndMergeLatest(key, generation, context)
        if (!currentGeneration(key, generation)) return
        const failure = actionError(currentJobs)
        if (failure) throw failure
        if (pendingFailure) throw pendingFailure
        updateActionState(key, generation, {
          ...idleAction,
          status: 'succeeded',
        })
        return
      }

      if (!await waitForNextPoll(key, generation)) return
    }
  }, [
    currentGeneration,
    readAndMergeLatest,
    readJob,
    updateActionState,
    waitForNextPoll,
  ])

  const refreshAfterConflict = useCallback(async (
    key: string,
    generation: number,
    context: MergeContext,
  ) => {
    try {
      await readAndMergeLatest(key, generation, context)
    } catch {
      // The original conflict remains the actionable failure.
    }
  }, [readAndMergeLatest])

  const launchWithOneReplay = useCallback(async ({
    key,
    generation,
    context,
    launch,
  }: {
    key: string
    generation: number
    context: MergeContext
    launch: (saved: TextVideoProject) => Promise<TextVideoJobLaunch>
  }): Promise<TextVideoJobLaunch | null> => {
    try {
      return await launch(context.editableBaseline)
    } catch (firstError) {
      if (!currentGeneration(key, generation)) return null
      if (statusForError(firstError) === 409) {
        await refreshAfterConflict(key, generation, context)
        throw firstError
      }
      if (!ambiguousRequestError(firstError)) throw firstError

      const observed = await readAndMergeLatest(
        key,
        generation,
        context,
      )
      if (!observed || !currentGeneration(key, generation)) return null
      const observedProof = requestSpecificRecoveryProof(
        key,
        context.editableBaseline,
        observed,
      )
      if (observedProof.proven) {
        const recoveredFailure = observedProof.failedError
          ? new TextVideoActionError(
            observedProof.failedError,
            false,
            0,
            '',
          )
          : null
        if (observedProof.jobIds.length > 0) {
          await pollProjectJobs({
            key,
            jobIds: observedProof.jobIds,
            context,
            generation,
            recoveredFailure,
          })
        } else if (recoveredFailure) {
          throw recoveredFailure
        } else {
          updateActionState(key, generation, {
            ...idleAction,
            status: 'succeeded',
          })
        }
        return null
      }
      if (!requestStateUnchanged(
        key,
        context.editableBaseline,
        observed,
      )) {
        throw new TextVideoActionOutcomeUnknownError()
      }

      try {
        return await launch(context.editableBaseline)
      } catch (replayError) {
        if (!currentGeneration(key, generation)) return null
        if (statusForError(replayError) === 409) {
          await refreshAfterConflict(key, generation, context)
          throw replayError
        }
        if (!ambiguousRequestError(replayError)) throw replayError

        const recovered = await readAndMergeLatest(
          key,
          generation,
          context,
        )
        if (!recovered || !currentGeneration(key, generation)) return null
        const proof = requestSpecificRecoveryProof(
          key,
          context.editableBaseline,
          recovered,
        )
        if (!proof.proven) throw new TextVideoActionOutcomeUnknownError()
        const recoveredFailure = proof.failedError
          ? new TextVideoActionError(
            proof.failedError,
            false,
            0,
            '',
          )
          : null
        if (proof.jobIds.length > 0) {
          await pollProjectJobs({
            key,
            jobIds: proof.jobIds,
            context,
            generation,
            recoveredFailure,
          })
        } else if (recoveredFailure) {
          throw recoveredFailure
        } else {
          updateActionState(key, generation, {
            ...idleAction,
            status: 'succeeded',
          })
        }
        return null
      }
    }
  }, [
    currentGeneration,
    pollProjectJobs,
    readAndMergeLatest,
    refreshAfterConflict,
    updateActionState,
  ])

  const executeProjectAction = useCallback(async (
    key: string,
    generation: number,
    launch: (saved: TextVideoProject) => Promise<TextVideoJobLaunch>,
  ): Promise<void> => {
    updateActionState(key, generation, {
      ...idleAction,
      status: 'running',
    })
    try {
      const saved = await autosaveRef.current.flush()
      if (!currentGeneration(key, generation)) return
      const context: MergeContext = {
        editableBaseline: saved.project,
        dirtyVersion: saved.dirtyVersion,
      }
      projectRef.current = {
        ...projectRef.current,
        revision: saved.project.revision,
      }

      const result = await launchWithOneReplay({
        key,
        generation,
        context,
        launch,
      })
      if (!result || !currentGeneration(key, generation)) return

      mergeServerProject(key, generation, result.project, context)
      const jobIds = result.jobs.map(job => job.id)
      if (jobIds.length === 0) {
        await readAndMergeLatest(key, generation, context)
        if (!currentGeneration(key, generation)) return
        updateActionState(key, generation, {
          ...idleAction,
          status: 'succeeded',
        })
        return
      }
      await pollProjectJobs({ key, jobIds, context, generation })
    } catch (error) {
      updateActionState(
        key,
        generation,
        actionStateForFailure(error),
      )
      throw error
    }
  }, [
    currentGeneration,
    launchWithOneReplay,
    mergeServerProject,
    pollProjectJobs,
    readAndMergeLatest,
    updateActionState,
  ])

  const runProjectAction = useCallback((
    key: string,
    launch: (saved: TextVideoProject) => Promise<TextVideoJobLaunch>,
  ): Promise<void> => {
    const current = operationsRef.current[key]
    if (current) return current

    supersedeDownstreamActions(key)
    const generation = beginGeneration(key)
    const operation = executeProjectAction(key, generation, launch)
      .finally(() => {
        if (operationsRef.current[key] === operation) {
          delete operationsRef.current[key]
        }
      })
    operationsRef.current[key] = operation
    return operation
  }, [
    beginGeneration,
    executeProjectAction,
    supersedeDownstreamActions,
  ])

  const executeRetry = useCallback(async (
    key: string,
    generation: number,
    jobId: number,
    stepKey: string,
  ): Promise<void> => {
    updateActionState(key, generation, {
      ...idleAction,
      status: 'running',
      jobId,
      stepKey,
    })
    try {
      const saved = await autosaveRef.current.flush()
      if (!currentGeneration(key, generation)) return
      const context: MergeContext = {
        editableBaseline: saved.project,
        dirtyVersion: saved.dirtyVersion,
      }
      const retried = await retryStep(jobId, stepKey)
      if (!currentGeneration(key, generation)) return
      setJobs(current => ({ ...current, [String(jobId)]: retried }))
      await pollProjectJobs({
        key,
        jobIds: [jobId],
        context,
        generation,
      })
    } catch (error) {
      updateActionState(
        key,
        generation,
        actionStateForFailure(error),
      )
      throw error
    }
  }, [
    currentGeneration,
    pollProjectJobs,
    retryStep,
    updateActionState,
  ])

  const retryProjectJob = useCallback((
    key: string,
    jobId: number,
    stepKey: string,
  ): Promise<void> => {
    const current = operationsRef.current[key]
    if (current) return current
    supersedeDownstreamActions(key)
    const generation = beginGeneration(key)
    const operation = executeRetry(key, generation, jobId, stepKey)
      .finally(() => {
        if (operationsRef.current[key] === operation) {
          delete operationsRef.current[key]
        }
      })
    operationsRef.current[key] = operation
    return operation
  }, [
    beginGeneration,
    executeRetry,
    supersedeDownstreamActions,
  ])

  const executeRefresh = useCallback(async (
    key: string,
    generation: number,
  ): Promise<void> => {
    const context: MergeContext = {
      editableBaseline: projectRef.current,
      dirtyVersion: autosaveRef.current.getDirtyVersion(),
    }
    try {
      const latest = await readAndMergeLatest(key, generation, context)
      if (!latest || !currentGeneration(key, generation)) return
      const jobIds = activeProjectJobIds(latest)
      if (jobIds.length === 0) return
      updateActionState(key, generation, {
        ...idleAction,
        status: 'running',
      })
      await pollProjectJobs({ key, jobIds, context, generation })
    } catch (error) {
      updateActionState(
        key,
        generation,
        actionStateForFailure(error),
      )
      throw error
    }
  }, [
    currentGeneration,
    pollProjectJobs,
    readAndMergeLatest,
    updateActionState,
  ])

  const refreshWorkerState = useCallback((): Promise<void> => {
    const key = 'recovery'
    const current = operationsRef.current[key]
    if (current) return current
    const generation = beginGeneration(key)
    const operation = executeRefresh(key, generation).finally(() => {
      if (operationsRef.current[key] === operation) {
        delete operationsRef.current[key]
      }
    })
    operationsRef.current[key] = operation
    return operation
  }, [beginGeneration, executeRefresh])

  useEffect(() => {
    if (!recoverOnMount) return
    void refreshWorkerState().catch(() => undefined)
  }, [recoverOnMount, refreshWorkerState])

  return {
    jobs,
    actionStates,
    runProjectAction,
    retryProjectJob,
    refreshWorkerState,
  }
}
