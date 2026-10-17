import { describe, expect, it, vi } from 'vitest'
import { beginChatTurn } from '@/lib/ai/chat-turn-control'
import { POST } from './route'

function control(sessionId: string, body: unknown) {
  return POST(new Request('http://localhost/api/chat/control', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ sessionId }) })
}

describe('chat control endpoint', () => {
  it('rejects missing sessions and invalid requests', async () => {
    expect((await control('bad', { action: 'interrupt' })).status).toBe(400)
    expect((await control('123', { action: 'steer', text: '' })).status).toBe(400)
    expect((await control('123', { action: 'interrupt' })).status).toBe(409)
  })
  it('sends native controls only to the selected active session', async () => {
    const persist = vi.fn(async () => {})
    const steer = vi.fn(async () => {})
    const interrupt = vi.fn(async () => {})
    const turn = beginChatTurn(123, persist)
    turn.ready({ threadId: 'thread', turnId: 'turn', steer, interrupt })
    try {
      expect((await control('124', { action: 'interrupt' })).status).toBe(409)
      expect((await control('123', { action: 'steer', text: '改变目标' })).status).toBe(200)
      expect(steer).toHaveBeenCalledWith('改变目标')
      expect(persist).toHaveBeenCalledWith('改变目标')
      expect((await control('123', { action: 'interrupt' })).status).toBe(200)
      expect(interrupt).toHaveBeenCalledTimes(1)
      await turn.drain()
    } finally { turn.dispose() }
  })
})
