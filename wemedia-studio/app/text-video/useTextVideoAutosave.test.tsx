// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TextVideoApiError,
  type TextVideoProject,
} from '@/lib/api/text-videos'
import {
  makeSpeechSegment,
  makeTextVideoProject,
} from '@/lib/text-video/test-fixtures'

import { useTextVideoAutosave } from './useTextVideoAutosave'

const project = makeTextVideoProject({
  id: 7,
  title: '自动保存作品',
  duration: 2.4,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('useTextVideoAutosave', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces a title edit and sends only the title delta', async () => {
    vi.useFakeTimers()
    const edited = { ...project, title: '只改标题' }
    const save = vi.fn().mockResolvedValue({ ...edited, revision: 2 })
    const onRevision = vi.fn()
    const { result, rerender } = renderHook(
      ({ value }) => useTextVideoAutosave({
        project: value,
        save,
        onRevision,
      }),
      { initialProps: { value: project } },
    )

    act(() => {
      result.current.markDirty()
      rerender({ value: edited })
    })
    expect(result.current.saveState).toBe('dirty')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(799)
    })
    expect(save).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(save).toHaveBeenCalledWith(7, {
      revision: 1,
      title: '只改标题',
    })
    expect(onRevision).toHaveBeenCalledWith(2)
    expect(result.current.saveState).toBe('saved')
  })

  it('supports immediate retry after a failed save', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new Error('网络失败'))
      .mockResolvedValueOnce({ ...project, revision: 2 })
    const { result } = renderHook(() => useTextVideoAutosave({
      project,
      save,
      onRevision: vi.fn(),
    }))

    act(() => result.current.markDirty())
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow('网络失败')
    })
    expect(result.current.saveState).toBe('error')

    await act(async () => {
      await result.current.retry()
    })
    expect(result.current.saveState).toBe('saved')
  })

  it('returns a clean saved snapshot without issuing a request', async () => {
    const save = vi.fn()
    const { result } = renderHook(() => useTextVideoAutosave({
      project,
      save,
      onRevision: vi.fn(),
    }))

    await expect(result.current.flush()).resolves.toEqual({
      project,
      dirtyVersion: 0,
    })
    expect(save).not.toHaveBeenCalled()
  })

  it('serializes concurrent flushes and saves edits that arrive in flight', async () => {
    const first = deferred<typeof project>()
    const second = deferred<typeof project>()
    const save = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const { result, rerender } = renderHook(
      ({ value }) => useTextVideoAutosave({
        project: value,
        save,
        onRevision: vi.fn(),
        debounceMs: 60_000,
      }),
      { initialProps: { value: project } },
    )

    act(() => result.current.markDirty())
    let firstFlush!: ReturnType<typeof result.current.flush>
    let concurrentFlush!: ReturnType<typeof result.current.flush>
    act(() => {
      firstFlush = result.current.flush()
      concurrentFlush = result.current.flush()
    })
    expect(save).toHaveBeenCalledTimes(1)

    const edited = {
      ...project,
      title: '保存中的新标题',
    }
    rerender({ value: edited })
    act(() => result.current.markDirty())
    await act(async () => {
      first.resolve({ ...project, revision: 2 })
      await Promise.resolve()
    })
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][1]).toMatchObject({
      revision: 2,
      title: '保存中的新标题',
    })

    await act(async () => {
      second.resolve({ ...edited, revision: 3 })
    })
    await expect(firstFlush).resolves.toMatchObject({
      project: { revision: 3, title: '保存中的新标题' },
      dirtyVersion: 2,
    })
    await expect(concurrentFlush).resolves.toMatchObject({
      project: { revision: 3 },
      dirtyVersion: 2,
    })
  })

  it('sends only changed editable narration fields and exact slices', async () => {
    const generated = makeTextVideoProject({
      title: project.title,
      script: '甲。乙。',
      paragraphs: [
        makeSpeechSegment('a', '甲。', {
          status: 'confirmed',
          audio_url: '/api/uploads/a.mp3',
          source_hash: 'a'.repeat(64),
          job_id: 9,
        }),
        makeSpeechSegment('b', '乙。'),
      ],
      speech_split_mode: 'auto',
      master_audio: {
        ...project.master_audio,
        status: 'ready',
        audio_url: '/api/uploads/master.mp3',
      },
      render_input: {
        ...project.render_input,
        audio: '/api/uploads/master.mp3',
      },
    })
    const save = vi.fn().mockResolvedValue({
      ...generated,
      revision: 2,
    })
    const { result, rerender } = renderHook(
      ({ value }) => useTextVideoAutosave({
        project: value,
        save,
        onRevision: vi.fn(),
        debounceMs: 60_000,
      }),
      { initialProps: { value: project } },
    )

    act(() => {
      result.current.markDirty()
      rerender({ value: generated })
    })
    await act(async () => {
      await result.current.flush()
    })

    expect(save).toHaveBeenCalledWith(generated.id, {
      revision: 1,
      script: '甲。乙。',
      paragraphs: [
        { id: 'a', text: '甲。' },
        { id: 'b', text: '乙。' },
      ],
      speech_split_mode: 'auto',
    })
  })

  it('sends the last-saved scene generation with an actual scene edit', async () => {
    const baseline = makeTextVideoProject({
      scene_plan: {
        ...project.scene_plan,
        status: 'ready',
        generation_revision: 5,
        scenes: [{
          id: 'scene-1',
          fromWordId: 'word-1',
          throughWordId: 'word-2',
          displayText: '原分镜',
          highlight: [],
          animation: 'fade-up',
        }],
      },
    })
    const edited = {
      ...baseline,
      scene_plan: {
        ...baseline.scene_plan,
        scenes: [{
          ...baseline.scene_plan.scenes[0],
          displayText: '手工修改',
        }],
      },
    }
    const save = vi.fn().mockResolvedValue({
      ...edited,
      revision: 2,
      scene_plan: {
        ...edited.scene_plan,
        generation_revision: 6,
      },
    })
    const { result, rerender } = renderHook(
      ({ value }) => useTextVideoAutosave({
        project: value,
        save,
        onRevision: vi.fn(),
        debounceMs: 60_000,
      }),
      { initialProps: { value: baseline } },
    )

    act(() => {
      result.current.markDirty()
      rerender({ value: edited })
    })
    await act(async () => {
      await result.current.flush()
    })

    expect(save).toHaveBeenCalledWith(baseline.id, {
      revision: 1,
      scene_plan: {
        generation_revision: 5,
        scenes: edited.scene_plan.scenes,
      },
    })
  })

  it('includes changed lifecycle and asset fields in the delta', async () => {
    const edited = {
      ...project,
      status: 'video_ready' as const,
      cover_asset_url: '/api/uploads/cover.png',
      output_asset_url: '/api/uploads/video.mp4',
    }
    const save = vi.fn().mockResolvedValue({
      ...edited,
      revision: 2,
    })
    const { result, rerender } = renderHook(
      ({ value }) => useTextVideoAutosave({
        project: value,
        save,
        onRevision: vi.fn(),
        debounceMs: 60_000,
      }),
      { initialProps: { value: project } },
    )

    act(() => {
      result.current.markDirty()
      rerender({ value: edited })
    })
    await act(async () => {
      await result.current.flush()
    })

    expect(save).toHaveBeenCalledWith(project.id, {
      revision: 1,
      status: 'video_ready',
      cover_asset_url: '/api/uploads/cover.png',
      output_asset_url: '/api/uploads/video.mp4',
    })
  })

  it('adopts worker scenes into the baseline while preserving a dirty title delta', async () => {
    const generating = makeTextVideoProject({
      scene_plan: {
        ...project.scene_plan,
        status: 'generating',
        generation_revision: 3,
        job_id: 44,
      },
    })
    const worker = {
      ...generating,
      scene_plan: {
        ...generating.scene_plan,
        status: 'ready' as const,
        generation_revision: 4,
        job_id: null,
        applied_job_id: 44,
        scenes: [{
          id: 'scene-ai',
          fromWordId: 'word-1',
          throughWordId: 'word-2',
          displayText: 'AI 分镜',
          highlight: ['AI'],
          animation: 'scale',
        }],
      },
    }
    const save = vi.fn().mockImplementation(async (
      _id: number,
      update: { title?: string },
    ) => ({
      ...worker,
      title: update.title ?? worker.title,
      revision: 2,
    }))
    const { result, rerender } = renderHook(
      ({ value }) => useTextVideoAutosave({
        project: value,
        save,
        onRevision: vi.fn(),
        debounceMs: 60_000,
      }),
      { initialProps: { value: generating } },
    )

    let adopted!: TextVideoProject
    act(() => {
      adopted = result.current.adoptServerProject(
        worker,
        generating,
      )
    })
    const dirtyTitle = { ...adopted, title: '分镜生成期间的新标题' }
    act(() => {
      result.current.markDirty()
      rerender({ value: dirtyTitle })
    })
    await act(async () => {
      await result.current.flush()
    })

    expect(adopted.scene_plan).toEqual(worker.scene_plan)
    expect(save).toHaveBeenCalledWith(generating.id, {
      revision: 1,
      title: '分镜生成期间的新标题',
    })
  })

  it('merges canonical worker state from a save response without overwriting in-flight edits', async () => {
    const generating = makeTextVideoProject({
      scene_plan: {
        ...project.scene_plan,
        status: 'generating',
        generation_revision: 8,
        job_id: 55,
      },
    })
    const first = deferred<typeof generating>()
    const second = deferred<typeof generating>()
    const save = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const onSavedProject = vi.fn()
    const { result, rerender } = renderHook(
      ({ value }) => useTextVideoAutosave({
        project: value,
        save,
        onRevision: vi.fn(),
        onSavedProject,
        debounceMs: 60_000,
      }),
      { initialProps: { value: generating } },
    )
    const saving = { ...generating, title: '正在保存的标题' }
    act(() => {
      result.current.markDirty()
      rerender({ value: saving })
    })
    let flush!: ReturnType<typeof result.current.flush>
    act(() => {
      flush = result.current.flush()
    })
    const inFlight = { ...saving, title: '请求期间继续编辑' }
    rerender({ value: inFlight })
    act(() => result.current.markDirty())
    const server = {
      ...saving,
      revision: 2,
      scene_plan: {
        ...saving.scene_plan,
        status: 'ready' as const,
        generation_revision: 9,
        job_id: null,
        applied_job_id: 55,
        scenes: [{
          id: 'scene-ai',
          fromWordId: 'word-1',
          throughWordId: 'word-2',
          displayText: 'AI 新分镜',
          highlight: [],
          animation: 'fade-up',
        }],
      },
    }

    await act(async () => {
      first.resolve(server)
      await Promise.resolve()
    })

    expect(onSavedProject).toHaveBeenCalledWith(expect.objectContaining({
      title: '请求期间继续编辑',
      scene_plan: server.scene_plan,
    }))
    expect(save.mock.calls[1][1]).toEqual({
      revision: 2,
      title: '请求期间继续编辑',
    })

    await act(async () => {
      second.resolve({
        ...server,
        title: '请求期间继续编辑',
        revision: 3,
      })
      await flush
    })
  })

  it('rejects a revision conflict and exposes the server revision', async () => {
    const save = vi.fn().mockRejectedValue(new TextVideoApiError(
      '作品已更新',
      409,
      { message: '作品已更新', revision: 7 },
    ))
    const { result } = renderHook(() => useTextVideoAutosave({
      project,
      save,
      onRevision: vi.fn(),
      debounceMs: 60_000,
    }))

    act(() => result.current.markDirty())
    await act(async () => {
      await expect(result.current.flush()).rejects.toThrow('作品已更新')
    })
    expect(result.current.saveState).toBe('conflict')
    expect(result.current.conflictRevision).toBe(7)
  })
})
