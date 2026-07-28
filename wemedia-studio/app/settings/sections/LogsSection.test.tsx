// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LogsSection } from './LogsSection'

describe('LogsSection', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses the direct logs URL, treats naive timestamps as UTC, and polls every 30 seconds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{
        id: 1,
        job: 'collect',
        status: 'ok',
        message: '采集完成',
        detail: '',
        created_at: '2026-07-28T00:00:00',
      }],
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<LogsSection />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8000/api/settings/logs?limit=100'
    ))
    expect(screen.getByRole('heading', { level: 2, name: '运行日志' })).toBeInTheDocument()
    expect(await screen.findByText('采集完成')).toBeInTheDocument()
    expect(screen.getByText(
      new Date('2026-07-28T00:00:00Z').toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    )).toBeInTheDocument()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
