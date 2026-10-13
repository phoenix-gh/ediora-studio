import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  deleteCodexThread: vi.fn(),
}))

vi.mock('@/lib/ai/codex-app-server-client', () => ({
  deleteCodexThread: api.deleteCodexThread,
}))

import { DELETE } from './route'

const token = 'test-worker-token-at-least-32-characters'

function deleteThread(threadId: string, headers?: HeadersInit) {
  return DELETE(
    new Request(`http://localhost/api/internal/codex-threads/${threadId}`, {
      method: 'DELETE',
      headers,
    }),
    { params: Promise.resolve({ threadId }) },
  )
}

describe('DELETE /api/internal/codex-threads/[threadId]', () => {
  beforeEach(() => {
    api.deleteCodexThread.mockReset()
    api.deleteCodexThread.mockResolvedValue(undefined)
    process.env.WORKER_TOKEN = token
  })

  it('deletes the Codex thread for a worker request', async () => {
    const response = await deleteThread('thr_chat', { 'X-Worker-Token': token })

    expect(response.status).toBe(204)
    expect(api.deleteCodexThread).toHaveBeenCalledWith('thr_chat')
  })

  it('rejects a missing worker token', async () => {
    const response = await deleteThread('thr_chat')

    expect(response.status).toBe(403)
    expect(api.deleteCodexThread).not.toHaveBeenCalled()
  })

  it('rejects a thread id the app would not store', async () => {
    const response = await deleteThread('thr chat', { 'X-Worker-Token': token })

    expect(response.status).toBe(400)
    expect(api.deleteCodexThread).not.toHaveBeenCalled()
  })

  it('returns the app-server error without deleting anything else', async () => {
    api.deleteCodexThread.mockRejectedValue(new Error('Codex app-server refused ws://127.0.0.1:4500'))

    const response = await deleteThread('thr_chat', { 'X-Worker-Token': token })

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      error: 'Codex app-server refused ws://127.0.0.1:4500',
    })
  })
})
