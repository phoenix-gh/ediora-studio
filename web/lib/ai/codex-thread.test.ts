import { describe, expect, it, vi } from 'vitest'

import { codexThreadId, codexThreadTurnOptions } from './codex-thread'

describe('codex thread continuity', () => {
  it('resumes a stored thread and starts a new one only when the id is absent', async () => {
    const remember = vi.fn(async () => undefined)

    expect(codexThreadId(' thr_existing ')).toBeUndefined()
    expect(codexThreadTurnOptions('thr_existing', remember)).toEqual({ threadId: 'thr_existing' })

    const started = codexThreadTurnOptions(null, remember)
    await started.onThreadId?.('thr_new')

    expect(remember).toHaveBeenCalledWith('thr_new')
    expect(started).not.toHaveProperty('threadId')
  })
})
