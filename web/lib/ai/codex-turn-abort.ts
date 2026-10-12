import { AsyncLocalStorage } from 'node:async_hooks'

const turnSignals = new AsyncLocalStorage<AbortSignal>()

export function currentCodexTurnSignal() {
  return turnSignals.getStore()
}

export function runWithCodexTurnSignal<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
) {
  return turnSignals.run(signal, run)
}
