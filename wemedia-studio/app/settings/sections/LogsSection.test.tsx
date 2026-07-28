// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LogsSection } from './LogsSection'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function response(logs: Array<{
  id: number
  job: string
  status: string
  message: string
  detail: string
  created_at: string
}>) {
  return {
    ok: true,
    json: async () => logs,
  }
}

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
    const fetchMock = vi.fn().mockResolvedValue(response([{
        id: 1,
        job: 'collect',
        status: 'ok',
        message: '采集完成',
        detail: '',
        created_at: '2026-07-28T00:00:00',
      }]))
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

  it('keeps visible and accessible semantic meaning for every severity and wires detail disclosure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([
      {
        id: 1,
        job: 'collect',
        status: 'ok',
        message: '采集完成',
        detail: '',
        created_at: '2026-07-28T00:00:00Z',
      },
      {
        id: 2,
        job: 'github',
        status: 'warn',
        message: '速率受限',
        detail: '稍后重试',
        created_at: '2026-07-28T00:01:00Z',
      },
      {
        id: 3,
        job: 'analyze',
        status: 'error',
        message: '分析失败',
        detail: '',
        created_at: '2026-07-28T00:02:00Z',
      },
    ])))

    render(<LogsSection />)

    expect(await screen.findByLabelText('状态：成功')).toHaveClass('text-success')
    expect(screen.getByLabelText('状态：警告')).toHaveClass('text-warning')
    expect(screen.getByLabelText('状态：错误')).toHaveClass('text-destructive')

    const warningRow = screen.getByRole('button', { name: /速率受限/ })
    expect(warningRow).toHaveAttribute('aria-expanded', 'false')
    const detailId = warningRow.getAttribute('aria-controls')
    expect(detailId).toBeTruthy()

    fireEvent.click(warningRow)
    expect(warningRow).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('稍后重试')).toHaveAttribute('id', detailId)
  })

  it('keeps a newer refresh result when an older request resolves later', async () => {
    const older = deferred<ReturnType<typeof response>>()
    const newer = deferred<ReturnType<typeof response>>()
    const fetchMock = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    vi.stubGlobal('fetch', fetchMock)

    render(<LogsSection />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    await act(async () => {
      newer.resolve(response([{
        id: 2,
        job: 'collect',
        status: 'ok',
        message: '较新的日志',
        detail: '',
        created_at: '2026-07-28T00:02:00Z',
      }]))
      await newer.promise
    })
    expect(await screen.findByText('较新的日志')).toBeInTheDocument()

    await act(async () => {
      older.resolve(response([{
        id: 1,
        job: 'collect',
        status: 'warn',
        message: '较旧的日志',
        detail: '',
        created_at: '2026-07-28T00:01:00Z',
      }]))
      await older.promise
    })

    expect(screen.getByText('较新的日志')).toBeInTheDocument()
    expect(screen.queryByText('较旧的日志')).not.toBeInTheDocument()
  })

  it('shows a recoverable error when loading logs rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    render(<LogsSection />)

    expect(await screen.findByRole('alert')).toHaveTextContent('日志加载失败，请稍后重试')
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
  })
})
