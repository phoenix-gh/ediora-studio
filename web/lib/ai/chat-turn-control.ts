import type { CodexTurnControl } from './codex-app-server-client'

export class ChatTurnConflict extends Error {}

type ActiveChatTurn = ReturnType<typeof createTurn>
const shared = globalThis as typeof globalThis & { __edioraChatTurns?: Map<number, ActiveChatTurn> }
const turns = shared.__edioraChatTurns ??= new Map<number, ActiveChatTurn>()

function createTurn(persistInstruction: (text: string) => Promise<void>) {
  let resolveReady!: (control: CodexTurnControl) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<CodexTurnControl>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  void ready.catch(() => undefined)
  let closing = false
  let pending = Promise.resolve()
  return {
    ready: resolveReady,
    control(action: 'interrupt' | 'steer', text?: string) {
      if (closing) return Promise.reject(new ChatTurnConflict('当前任务已结束，请重新发送'))
      const operation = pending.then(async () => {
        const control = await ready
        if (action === 'interrupt') await control.interrupt()
        else {
          if (!text?.trim()) throw new Error('追加指令不能为空')
          await control.steer(text)
          try { await persistInstruction(text) }
          catch { return { warning: '指令已送达，但保存聊天记录失败，请勿重复发送' } }
        }
        return {}
      })
      pending = operation.then(() => undefined, () => undefined)
      return operation
    },
    async drain() {
      closing = true
      rejectReady(new ChatTurnConflict('当前任务已结束，请重新发送'))
      await pending
    },
  }
}

export function beginChatTurn(sessionId: number, persistInstruction: (text: string) => Promise<void>) {
  if (turns.has(sessionId)) throw new ChatTurnConflict('当前会话已有运行中的任务')
  const turn = createTurn(persistInstruction)
  turns.set(sessionId, turn)
  return {
    ...turn,
    dispose() {
      if (turns.get(sessionId) === turn) turns.delete(sessionId)
    },
  }
}

export async function controlChatTurn(sessionId: number, action: 'interrupt' | 'steer', text?: string) {
  const turn = turns.get(sessionId)
  if (!turn) throw new ChatTurnConflict('当前没有可控制的运行任务，请刷新会话后重试')
  return turn.control(action, text)
}
