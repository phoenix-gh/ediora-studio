const REQUEST_SOURCE = 'shuce-console'
const BRIDGE_SOURCE = 'shuce-bridge'
const REQUEST_TYPE = 'SHUCE_PUBLISH_REQUEST'
const RESULT_TYPE = 'SHUCE_PUBLISH_RESULT'
const DEFAULT_TIMEOUT_MS = 30_000

function bridgeTimeoutError(requestId) {
  const error = new Error(`述策助手等待发布结果超时：${requestId}`)
  error.code = 'BRIDGE_TIMEOUT'
  return error
}

export function installConsoleApi(targetWindow, options = {}) {
  if (!targetWindow || targetWindow.Shuce) return targetWindow?.Shuce

  const pending = new Map()
  const randomUUID = options.randomUUID
    || targetWindow.crypto?.randomUUID?.bind(targetWindow.crypto)
    || (() => `${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const setTimer = options.setTimeout || globalThis.setTimeout
  const clearTimer = options.clearTimeout || globalThis.clearTimeout
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const onMessage = event => {
    if (event.source !== targetWindow || event.data?.source !== BRIDGE_SOURCE) return
    if (event.data.type !== RESULT_TYPE || typeof event.data.requestId !== 'string') return

    const entry = pending.get(event.data.requestId)
    if (!entry) return
    pending.delete(event.data.requestId)
    clearTimer(entry.timer)
    if (event.data.error) entry.reject(event.data.error)
    else entry.resolve(event.data.result)
  }

  targetWindow.addEventListener('message', onMessage)

  const publish = payload => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const error = new Error('Shuce.publish() 参数必须是对象')
      error.code = 'INVALID_REQUEST'
      return Promise.reject(error)
    }

    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(requestId)
        reject(bridgeTimeoutError(requestId))
      }, timeoutMs)
      pending.set(requestId, { resolve, reject, timer })
      targetWindow.postMessage({
        source: REQUEST_SOURCE,
        type: REQUEST_TYPE,
        requestId,
        payload,
      }, '*')
    })
  }

  const api = Object.freeze({ publish })
  Object.defineProperty(targetWindow, 'Shuce', {
    configurable: true,
    enumerable: false,
    writable: false,
    value: api,
  })
  return api
}

if (typeof window !== 'undefined') installConsoleApi(window)
