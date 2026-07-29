// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TextVideoApiError } from '@/lib/api/text-videos'
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

  it('debounces dirty projects for 800ms and reports saved revision', async () => {
    vi.useFakeTimers()
    const save = vi.fn().mockResolvedValue({ ...project, revision: 2 })
    const onRevision = vi.fn()
    const { result } = renderHook(() => useTextVideoAutosave({
      project,
      save,
      onRevision,
    }))

    act(() => result.current.markDirty())
    expect(result.current.saveState).toBe('dirty')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(799)
    })
    expect(save).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(save).toHaveBeenCalledWith(7, expect.objectContaining({ revision: 1 }))
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

  it('sends only editable fields and exact segment slices', async () => {
    const generated = makeTextVideoProject({
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
    const { result } = renderHook(() => useTextVideoAutosave({
      project: generated,
      save,
      onRevision: vi.fn(),
      debounceMs: 60_000,
    }))

    act(() => result.current.markDirty())
    await act(async () => {
      await result.current.flush()
    })

    expect(save).toHaveBeenCalledWith(generated.id, {
      revision: 1,
      title: generated.title,
      stage: generated.stage,
      script: '甲。乙。',
      voice_settings: generated.voice_settings,
      paragraphs: [
        { id: 'a', text: '甲。' },
        { id: 'b', text: '乙。' },
      ],
      speech_split_mode: 'auto',
      composition: generated.render_input.composition,
      template: {
        templateId: generated.render_input.templateId,
        templateVersion: generated.render_input.templateVersion,
        templateProps: generated.render_input.templateProps,
      },
      scene_plan: {
        scenes: generated.scene_plan.scenes,
      },
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
