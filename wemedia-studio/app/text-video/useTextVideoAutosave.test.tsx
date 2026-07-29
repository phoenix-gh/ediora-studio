// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeTextVideoProject } from '@/lib/text-video/test-fixtures'

import { useTextVideoAutosave } from './useTextVideoAutosave'

const project = makeTextVideoProject({
  id: 7,
  title: '自动保存作品',
  duration: 2.4,
})

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
      await result.current.saveNow()
    })
    expect(result.current.saveState).toBe('error')

    await act(async () => {
      await result.current.retry()
    })
    expect(result.current.saveState).toBe('saved')
  })
})
