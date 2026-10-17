import { describe, expect, it, vi } from 'vitest'
import { beginChatTurn, controlChatTurn } from './chat-turn-control'

describe('chat turn controls', () => {
  it('waits for native turn startup before interrupting', async () => {
    const turn = beginChatTurn(101, vi.fn())
    const interrupt = vi.fn(async () => {})
    try {
      const stopped = controlChatTurn(101, 'interrupt')
      expect(interrupt).not.toHaveBeenCalled()
      turn.ready({ threadId: 'thread', turnId: 'turn', interrupt, steer: vi.fn() })
      await stopped
      expect(interrupt).toHaveBeenCalledTimes(1)
      await turn.drain()
    } finally { turn.dispose() }
  })

  it('waits for accepted instructions to persist before the assistant completes', async () => {
    let release!: () => void
    const persist = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const turn = beginChatTurn(102, persist)
    const steer = vi.fn(async () => {})
    try {
      turn.ready({ threadId: 'thread', turnId: 'turn', interrupt: vi.fn(), steer })
      const sent = controlChatTurn(102, 'steer', '新指令')
      await vi.waitFor(() => expect(persist).toHaveBeenCalledWith('新指令'))
      let finished = false
      const closing = turn.drain().then(() => { finished = true })
      await Promise.resolve()
      expect(finished).toBe(false)
      await expect(controlChatTurn(102, 'steer', 'too late')).rejects.toThrow('已结束')
      release()
      await Promise.all([sent, closing])
      expect(steer).toHaveBeenCalledWith('新指令')
    } finally { turn.dispose() }
  })

  it('does not persist instructions the native turn rejected', async () => {
    const persist = vi.fn()
    const turn = beginChatTurn(103, persist)
    try {
      turn.ready({ threadId: 'thread', turnId: 'turn', interrupt: vi.fn(), steer: vi.fn(async () => { throw new Error('finished') }) })
      await expect(controlChatTurn(103, 'steer', 'new')).rejects.toThrow('finished')
      expect(persist).not.toHaveBeenCalled()
      await turn.drain()
    } finally { turn.dispose() }
    await expect(controlChatTurn(103, 'interrupt')).rejects.toThrow('没有')
  })

  it('reports an accepted instruction when only chat persistence fails', async () => {
    const turn = beginChatTurn(104, async () => { throw new Error('database unavailable') })
    try {
      turn.ready({ threadId: 'thread', turnId: 'turn', interrupt: vi.fn(), steer: vi.fn(async () => {}) })
      await expect(controlChatTurn(104, 'steer', 'new')).resolves.toMatchObject({ warning: expect.stringContaining('已送达') })
      await turn.drain()
    } finally { turn.dispose() }
  })
})
