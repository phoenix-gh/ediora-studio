// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TextVideoProject } from '@/lib/api/text-videos'

import { useTextVideoAutosave } from './useTextVideoAutosave'

const project = {
  id: 7,
  title: '自动保存作品',
  status: 'draft',
  stage: 'script',
  script: '',
  voice_settings: {},
  paragraphs: [],
  render_input: {
    templateId: 'tech-text-v1',
    templateVersion: 1,
    composition: { width: 1080, height: 1920, fps: 30 },
    audio: '',
    segments: [{ id: 's1', start: 0, end: 2.4, text: '开始', highlight: [], animation: 'fade-up' }],
    templateProps: {
      theme: 'tech-blue',
      font: 'source-han-sans',
      background: 'dark-grid',
      transition: 'soft-push',
      textDensity: 'standard',
    },
  },
  cover_asset_url: '',
  output_asset_url: '',
  revision: 1,
  duration: 2.4,
  aspect_ratio: '9:16',
  created_at: '2026-07-29T00:00:00Z',
  updated_at: '2026-07-29T00:00:00Z',
} satisfies TextVideoProject

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
