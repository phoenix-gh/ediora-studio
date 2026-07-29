// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '@/lib/api/client'
import type { ContentJob } from '@/lib/api/jobs'
import {
  TextVideoApiError,
  type TextVideoProject,
} from '@/lib/api/text-videos'
import {
  makeSpeechSegment,
  makeTextVideoProject,
} from '@/lib/text-video/test-fixtures'
import { editSpeechSegment } from '@/lib/text-video/speech-segments'

import {
  TextVideoActionError,
  useTextVideoProjectActions,
} from './useTextVideoProjectActions'
import type { TextVideoFlushResult } from './useTextVideoAutosave'

function makeJob(overrides: Partial<ContentJob> = {}): ContentJob {
  return {
    id: 41,
    flow: 'text_video_speech',
    title: '生成配音',
    status: 'succeeded',
    created_at: '',
    started_at: '',
    completed_at: '',
    steps: [],
    events: [],
    ...overrides,
  }
}

function useHarness({
  initialProject,
  flush,
  readProject,
  readJob,
  recoverOnMount = false,
}: {
  initialProject: TextVideoProject
  flush: () => Promise<TextVideoFlushResult>
  readProject: (projectId: number) => Promise<TextVideoProject>
  readJob: (jobId: number) => Promise<ContentJob>
  recoverOnMount?: boolean
}) {
  const [project, setProject] = useState(initialProject)
  const dirtyVersion = useRef(0)
  const savedVersion = useRef(0)
  const actions = useTextVideoProjectActions({
    project,
    setProject,
    autosave: {
      flush,
      isDirty: () => dirtyVersion.current !== savedVersion.current,
      getDirtyVersion: () => dirtyVersion.current,
    },
    readProject,
    readJob,
    pollIntervalMs: 1,
    recoverOnMount,
  })

  return {
    project,
    actions,
    edit(segmentId: string, text: string) {
      dirtyVersion.current += 1
      setProject(current => editSpeechSegment(current, segmentId, text))
    },
  }
}

describe('useTextVideoProjectActions', () => {
  it('flushes before launch and three-way merges worker results with later edits', async () => {
    const baseline = makeTextVideoProject({
      revision: 2,
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('a', '甲。'),
        makeSpeechSegment('b', '乙。'),
      ],
    })
    const generating = {
      ...baseline,
      paragraphs: baseline.paragraphs.map(segment => (
        segment.id === 'a'
          ? { ...segment, status: 'generating' as const, job_id: 41 }
          : segment
      )),
    }
    const ready = {
      ...baseline,
      paragraphs: baseline.paragraphs.map(segment => (
        segment.id === 'a'
          ? {
              ...segment,
              status: 'ready' as const,
              job_id: null,
              audio_url: '/api/uploads/a.mp3',
              source_hash: 'a'.repeat(64),
            }
          : segment
      )),
    }
    const flush = vi.fn().mockResolvedValue({
      project: baseline,
      dirtyVersion: 0,
    })
    const launch = vi.fn().mockResolvedValue({
      jobs: [{ id: 41, flow: 'text_video_speech', target_id: 'a' }],
      project: generating,
    })
    const readProject = vi.fn().mockResolvedValue(ready)
    const readJob = vi.fn().mockResolvedValue(makeJob())
    const { result } = renderHook(() => useHarness({
      initialProject: baseline,
      flush,
      readProject,
      readJob,
    }))

    let action!: Promise<void>
    await act(async () => {
      action = result.current.actions.runProjectAction('speech:a', launch)
      await Promise.resolve()
      result.current.edit('b', '本地乙。')
      await action
    })

    expect(flush).toHaveBeenCalledBefore(launch)
    expect(launch).toHaveBeenCalledWith(baseline)
    expect(result.current.project.paragraphs.find(item => item.id === 'a'))
      .toMatchObject({
        status: 'ready',
        audio_url: '/api/uploads/a.mp3',
      })
    expect(result.current.project.paragraphs.find(item => item.id === 'b')?.text)
      .toBe('本地乙。')
  })

  it('performs one final authoritative refresh when reusable speech creates no jobs', async () => {
    const project = makeTextVideoProject({
      paragraphs: [makeSpeechSegment('a', '甲。')],
      script: '甲。',
    })
    const reused = {
      ...project,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'ready',
        audio_url: '/api/uploads/reused.mp3',
      })],
    }
    const readProject = vi.fn().mockResolvedValue(reused)
    const { result } = renderHook(() => useHarness({
      initialProject: project,
      flush: vi.fn().mockResolvedValue({ project, dirtyVersion: 0 }),
      readProject,
      readJob: vi.fn(),
    }))

    await act(async () => {
      await result.current.actions.runProjectAction(
        'speech:a',
        vi.fn().mockResolvedValue({ jobs: [], project: reused }),
      )
    })

    expect(result.current.project.paragraphs[0].audio_url)
      .toBe('/api/uploads/reused.mp3')
    expect(readProject).toHaveBeenCalledTimes(1)
  })

  it('shares one same-key in-flight action and never launches twice', async () => {
    const project = makeTextVideoProject()
    let resolveLaunch!: (value: {
      jobs: []
      project: TextVideoProject
    }) => void
    const launchResult = new Promise<{
      jobs: []
      project: TextVideoProject
    }>(resolve => {
      resolveLaunch = resolve
    })
    const launch = vi.fn().mockReturnValue(launchResult)
    const { result } = renderHook(() => useHarness({
      initialProject: project,
      flush: vi.fn().mockResolvedValue({ project, dirtyVersion: 0 }),
      readProject: vi.fn().mockResolvedValue(project),
      readJob: vi.fn(),
    }))

    let first!: Promise<void>
    let second!: Promise<void>
    act(() => {
      first = result.current.actions.runProjectAction('speech:a', launch)
      second = result.current.actions.runProjectAction('speech:a', launch)
    })
    expect(second).toBe(first)
    await waitFor(() => expect(launch).toHaveBeenCalledTimes(1))
    await act(async () => {
      resolveLaunch({ jobs: [], project })
      await first
    })
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('keeps an independent merge baseline for concurrently running keys', async () => {
    const baseline = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('a', '甲。'),
        makeSpeechSegment('b', '乙。'),
      ],
    })
    const localSaved = editSpeechSegment(baseline, 'b', '本地乙。')
    const workerReady = {
      ...baseline,
      paragraphs: baseline.paragraphs.map(segment => (
        segment.id === 'a'
          ? makeSpeechSegment('a', '甲。', {
              status: 'ready',
              audio_url: '/api/uploads/a.mp3',
              source_hash: 'a'.repeat(64),
            })
          : segment
      )),
    }
    let resolveFirstLaunch!: (value: {
      jobs: Array<{ id: number; flow: string; target_id: string }>
      project: TextVideoProject
    }) => void
    const firstLaunch = vi.fn().mockReturnValue(new Promise(resolve => {
      resolveFirstLaunch = resolve
    }))
    const flush = vi.fn()
      .mockResolvedValueOnce({ project: baseline, dirtyVersion: 0 })
      .mockResolvedValueOnce({ project: localSaved, dirtyVersion: 1 })
    const readProject = vi.fn()
      .mockResolvedValueOnce(localSaved)
      .mockResolvedValueOnce(workerReady)
    const { result } = renderHook(() => useHarness({
      initialProject: baseline,
      flush,
      readProject,
      readJob: vi.fn().mockResolvedValue(makeJob()),
    }))

    let first!: Promise<void>
    await act(async () => {
      first = result.current.actions.runProjectAction(
        'speech:a',
        firstLaunch,
      )
      await Promise.resolve()
    })
    act(() => result.current.edit('b', '本地乙。'))
    await act(async () => {
      await result.current.actions.runProjectAction(
        'master',
        vi.fn().mockResolvedValue({ jobs: [], project: localSaved }),
      )
    })
    await act(async () => {
      resolveFirstLaunch({
        jobs: [{ id: 41, flow: 'text_video_speech', target_id: 'a' }],
        project: {
          ...baseline,
          paragraphs: baseline.paragraphs.map(segment => (
            segment.id === 'a'
              ? { ...segment, status: 'generating' as const, job_id: 41 }
              : segment
          )),
        },
      })
      await first
    })

    expect(result.current.project.paragraphs.find(item => item.id === 'a'))
      .toMatchObject({ audio_url: '/api/uploads/a.mp3' })
    expect(result.current.project.paragraphs.find(item => item.id === 'b')?.text)
      .toBe('本地乙。')
  })

  it('does not roll back a newer job when different action responses arrive out of order', async () => {
    const baseline = makeTextVideoProject({
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('a', '甲。'),
        makeSpeechSegment('b', '乙。'),
      ],
    })
    const serverA = {
      ...baseline,
      paragraphs: [
        makeSpeechSegment('a', '甲。', {
          status: 'generating',
          source_hash: 'a'.repeat(64),
          job_id: 11,
        }),
        baseline.paragraphs[1],
      ],
    }
    const serverB = {
      ...serverA,
      paragraphs: [
        serverA.paragraphs[0],
        makeSpeechSegment('b', '乙。', {
          status: 'generating',
          source_hash: 'b'.repeat(64),
          job_id: 22,
        }),
      ],
    }
    let resolveA!: (value: {
      jobs: []
      project: TextVideoProject
    }) => void
    const launchA = vi.fn().mockReturnValue(new Promise(resolve => {
      resolveA = resolve
    }))
    const readProject = vi.fn()
      .mockResolvedValueOnce(serverB)
      .mockResolvedValueOnce(serverA)
    const { result } = renderHook(() => useHarness({
      initialProject: baseline,
      flush: vi.fn().mockResolvedValue({
        project: baseline,
        dirtyVersion: 0,
      }),
      readProject,
      readJob: vi.fn(),
    }))

    let actionA!: Promise<void>
    act(() => {
      actionA = result.current.actions.runProjectAction(
        'speech:a',
        launchA,
      )
    })
    await waitFor(() => expect(launchA).toHaveBeenCalledOnce())
    await act(async () => {
      await result.current.actions.runProjectAction(
        'speech:b',
        vi.fn().mockResolvedValue({ jobs: [], project: serverB }),
      )
    })
    await act(async () => {
      resolveA({ jobs: [], project: serverA })
      await actionA
    })

    expect(result.current.project.paragraphs).toMatchObject([
      { id: 'a', status: 'generating', job_id: 11 },
      { id: 'b', status: 'generating', job_id: 22 },
    ])
  })

  it('rejects with the latest failed step error and retryability', async () => {
    const project = makeTextVideoProject()
    const failedJob = makeJob({
      status: 'failed',
      steps: [{
        id: 1,
        key: 'generate_speech',
        attempt: 2,
        status: 'failed',
        output: {},
        error: 'MiMo 额度不足',
        retryable: false,
        created_at: '',
        started_at: '',
        completed_at: '',
      }],
    })
    const { result } = renderHook(() => useHarness({
      initialProject: project,
      flush: vi.fn().mockResolvedValue({ project, dirtyVersion: 0 }),
      readProject: vi.fn().mockResolvedValue(project),
      readJob: vi.fn().mockResolvedValue(failedJob),
    }))

    let thrown: unknown
    await act(async () => {
      try {
        await result.current.actions.runProjectAction(
          'speech:a',
          vi.fn().mockResolvedValue({
            jobs: [{ id: 41, flow: 'text_video_speech', target_id: 'a' }],
            project,
          }),
        )
      } catch (error) {
        thrown = error
      }
    })

    expect(thrown).toBeInstanceOf(TextVideoActionError)
    expect(thrown).toMatchObject({
      message: 'MiMo 额度不足',
      retryable: false,
      stepKey: 'generate_speech',
      jobId: 41,
    })
    expect(result.current.actions.actionStates['speech:a']).toMatchObject({
      status: 'failed',
      error: 'MiMo 额度不足',
      retryable: false,
    })
  })

  it('recovers an active job from persisted project state after reload', async () => {
    const active = makeTextVideoProject({
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'generating',
        job_id: 91,
      })],
      script: '甲。',
    })
    const ready = {
      ...active,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'ready',
        audio_url: '/api/uploads/a.mp3',
      })],
    }
    const readProject = vi.fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(ready)
    const readJob = vi.fn().mockResolvedValue(makeJob({ id: 91 }))
    const { result } = renderHook(() => useHarness({
      initialProject: active,
      flush: vi.fn(),
      readProject,
      readJob,
      recoverOnMount: true,
    }))

    await waitFor(() => {
      expect(result.current.project.paragraphs[0].audio_url)
        .toBe('/api/uploads/a.mp3')
    })
    expect(readJob).toHaveBeenCalledWith(91)
  })

  it('continues reload recovery after React StrictMode replays effects', async () => {
    const active = makeTextVideoProject({
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'generating',
        job_id: 92,
      })],
      script: '甲。',
    })
    const ready = {
      ...active,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'ready',
        audio_url: '/api/uploads/strict-ready.mp3',
      })],
    }
    const readProject = vi.fn()
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(active)
      .mockResolvedValue(ready)
    const readJob = vi.fn().mockResolvedValue(makeJob({ id: 92 }))
    const { result } = renderHook(() => useHarness({
      initialProject: active,
      flush: vi.fn(),
      readProject,
      readJob,
      recoverOnMount: true,
    }), { reactStrictMode: true })

    await waitFor(() => {
      expect(result.current.project.paragraphs[0].audio_url)
        .toBe('/api/uploads/strict-ready.mp3')
    })
    expect(readJob).toHaveBeenCalledWith(92)
  })

  it('recovers a launched job when the action response is lost', async () => {
    const project = makeTextVideoProject({
      paragraphs: [makeSpeechSegment('a', '甲。')],
      script: '甲。',
    })
    const active = {
      ...project,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'generating',
        job_id: 51,
      })],
    }
    const ready = {
      ...project,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'ready',
        audio_url: '/api/uploads/a.mp3',
      })],
    }
    const readProject = vi.fn()
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(ready)
    const launch = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        jobs: [{ id: 51, flow: 'text_video_speech', target_id: 'a' }],
        project: active,
      })
    const { result } = renderHook(() => useHarness({
      initialProject: project,
      flush: vi.fn().mockResolvedValue({ project, dirtyVersion: 0 }),
      readProject,
      readJob: vi.fn().mockResolvedValue(makeJob({ id: 51 })),
    }))

    await act(async () => {
      await result.current.actions.runProjectAction(
        'speech:a',
        launch,
      )
    })

    expect(launch).toHaveBeenCalledTimes(2)
    expect(result.current.project.paragraphs[0].audio_url)
      .toBe('/api/uploads/a.mp3')
  })

  it('fails closed when one exact replay also has an unknown outcome', async () => {
    const project = makeTextVideoProject()
    const launch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const { result } = renderHook(() => useHarness({
      initialProject: project,
      flush: vi.fn().mockResolvedValue({ project, dirtyVersion: 0 }),
      readProject: vi.fn().mockResolvedValue(project),
      readJob: vi.fn(),
    }))

    await act(async () => {
      await expect(result.current.actions.runProjectAction(
        'speech:a',
        launch,
      )).rejects.toThrow('操作结果未知')
    })

    expect(launch).toHaveBeenCalledTimes(2)
    expect(result.current.actions.actionStates['speech:a']).toMatchObject({
      status: 'failed',
      retryable: true,
    })
  })

  it('does not replay a paid speech launch already proven ready', async () => {
    const project = makeTextVideoProject({
      script: '甲。',
      paragraphs: [makeSpeechSegment('a', '甲。')],
    })
    const ready = {
      ...project,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'ready',
        source_hash: 'a'.repeat(64),
        audio_url: '/api/uploads/a.mp3',
      })],
    }
    const launch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const { result } = renderHook(() => useHarness({
      initialProject: project,
      flush: vi.fn().mockResolvedValue({ project, dirtyVersion: 0 }),
      readProject: vi.fn().mockResolvedValue(ready),
      readJob: vi.fn(),
    }))

    await act(async () => {
      await result.current.actions.runProjectAction('speech:a', launch)
    })

    expect(launch).toHaveBeenCalledTimes(1)
    expect(result.current.project.paragraphs[0]).toMatchObject({
      status: 'ready',
      audio_url: '/api/uploads/a.mp3',
    })
  })

  it('does not replay a paid speech launch already proven failed', async () => {
    const project = makeTextVideoProject({
      script: '甲。',
      paragraphs: [makeSpeechSegment('a', '甲。')],
    })
    const failed = {
      ...project,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'failed',
        source_hash: 'a'.repeat(64),
        error: 'MiMo 余额不足',
      })],
    }
    const launch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const { result } = renderHook(() => useHarness({
      initialProject: project,
      flush: vi.fn().mockResolvedValue({ project, dirtyVersion: 0 }),
      readProject: vi.fn().mockResolvedValue(failed),
      readJob: vi.fn(),
    }))

    await act(async () => {
      await expect(result.current.actions.runProjectAction(
        'speech:a',
        launch,
      )).rejects.toThrow('MiMo 余额不足')
    })

    expect(launch).toHaveBeenCalledTimes(1)
    expect(result.current.actions.actionStates['speech:a']).toMatchObject({
      status: 'failed',
      error: 'MiMo 余额不足',
    })
  })

  it('refreshes on 409 and classifies client errors as non-retryable', async () => {
    const project = makeTextVideoProject()
    const latest = { ...project, revision: 7, title: '服务端新标题' }
    const readProject = vi.fn().mockResolvedValue(latest)
    const { result } = renderHook(() => useHarness({
      initialProject: project,
      flush: vi.fn().mockResolvedValue({ project, dirtyVersion: 0 }),
      readProject,
      readJob: vi.fn(),
    }))

    await act(async () => {
      await expect(result.current.actions.runProjectAction(
        'speech:a',
        vi.fn().mockRejectedValue(new TextVideoApiError(
          '作品已更新',
          409,
          { revision: 7 },
        )),
      )).rejects.toThrow('作品已更新')
    })

    expect(readProject).toHaveBeenCalledTimes(1)
    expect(result.current.project).toMatchObject({
      revision: 7,
      title: '服务端新标题',
    })
    expect(result.current.actions.actionStates['speech:a']).toMatchObject({
      status: 'failed',
      retryable: false,
    })
  })

  it('does not loop or claim success when a persisted job returns 404', async () => {
    const project = makeTextVideoProject()
    const active = {
      ...project,
      paragraphs: [makeSpeechSegment('a', '甲。', {
        status: 'generating',
        job_id: 61,
      })],
      script: '甲。',
    }
    const readJob = vi.fn().mockRejectedValue(new ApiError(
      '任务不存在',
      404,
      '任务不存在',
    ))
    const { result } = renderHook(() => useHarness({
      initialProject: project,
      flush: vi.fn().mockResolvedValue({ project, dirtyVersion: 0 }),
      readProject: vi.fn().mockResolvedValue(active),
      readJob,
    }))

    await act(async () => {
      await expect(result.current.actions.runProjectAction(
        'speech:a',
        vi.fn().mockResolvedValue({
          jobs: [{ id: 61, flow: 'text_video_speech', target_id: 'a' }],
          project: active,
        }),
      )).rejects.toThrow('任务不存在')
    })

    expect(readJob).toHaveBeenCalledTimes(1)
    expect(result.current.actions.actionStates['speech:a']).toMatchObject({
      status: 'failed',
      retryable: false,
    })
  })
})
