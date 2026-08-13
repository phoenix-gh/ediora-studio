export const SCHEDULE_MESSAGE_TYPES = Object.freeze({
  GET: 'SHUCE_SCHEDULE_GET',
  SET_AUTOFILL: 'SHUCE_SCHEDULE_SET_AUTOFILL',
  CHANGED: 'SHUCE_SCHEDULE_CHANGED',
  RESULT: 'SHUCE_SCHEDULE_RESULT',
})

export function emptyScheduleSnapshot() {
  return {
    selection: null,
    autoFillEnabled: false,
    available: false,
  }
}

function defaultRandomUUID() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function snapshotFromResponse(response) {
  if (!response || typeof response !== 'object') return emptyScheduleSnapshot()
  return {
    selection: response.selection ?? null,
    autoFillEnabled: response.autoFillEnabled === true,
    available: response.available === true,
  }
}

export function handleScheduleHostMessage(message, memory) {
  if (!message || typeof message !== 'object') return null

  if (message.type === SCHEDULE_MESSAGE_TYPES.GET) {
    return {
      type: SCHEDULE_MESSAGE_TYPES.RESULT,
      ok: true,
      selection: memory.readStored(),
      autoFillEnabled: memory.readAutoFillEnabled() === true,
      available: true,
    }
  }

  if (message.type === SCHEDULE_MESSAGE_TYPES.SET_AUTOFILL) {
    memory.setAutoFillEnabled(message.enabled)
    return {
      type: SCHEDULE_MESSAGE_TYPES.RESULT,
      ok: true,
      selection: memory.readStored(),
      autoFillEnabled: memory.readAutoFillEnabled() === true,
      available: true,
    }
  }

  return null
}

export async function resolveActiveXTab(queryTabs, isXSiteUrl) {
  const tabs = await queryTabs({ active: true, currentWindow: true })
  const tab = Array.isArray(tabs) ? tabs[0] : null
  if (!tab || typeof isXSiteUrl !== 'function' || !isXSiteUrl(tab.url)) return null
  return tab
}

export async function routeScheduleRequest(message, { queryTabs, sendToTab, isXSiteUrl }) {
  const tab = await resolveActiveXTab(queryTabs, isXSiteUrl)
  if (!tab) {
    return {
      type: SCHEDULE_MESSAGE_TYPES.RESULT,
      requestId: message?.requestId,
      ok: true,
      ...emptyScheduleSnapshot(),
    }
  }

  const response = await sendToTab(tab.id, message)
  if (!response || typeof response !== 'object') {
    return {
      type: SCHEDULE_MESSAGE_TYPES.RESULT,
      requestId: message?.requestId,
      ok: true,
      ...emptyScheduleSnapshot(),
    }
  }
  return response
}

export function createScheduleClient({
  runtime,
  randomUUID = defaultRandomUUID,
  timeoutMs = 10_000,
} = {}) {
  const listeners = new Set()
  let destroyed = false

  function onRuntimeMessage(message) {
    if (destroyed) return
    if (!message || message.type !== SCHEDULE_MESSAGE_TYPES.CHANGED) return
    const snapshot = snapshotFromResponse(message)
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch {
        // ignore subscriber errors
      }
    }
  }

  if (runtime?.onMessage && typeof runtime.onMessage.addListener === 'function') {
    runtime.onMessage.addListener(onRuntimeMessage)
  }

  async function sendRequest(type, payload = {}) {
    if (destroyed || !runtime || typeof runtime.sendMessage !== 'function') {
      return emptyScheduleSnapshot()
    }

    const requestId = randomUUID()
    const message = { type, requestId, ...payload }
    let timer

    try {
      const response = await new Promise((resolve) => {
        let settled = false
        const settle = (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(value)
        }

        timer = setTimeout(() => {
          settle(null)
        }, timeoutMs)

        let sent
        try {
          sent = runtime.sendMessage(message)
        } catch {
          settle(null)
          return
        }

        if (!sent || typeof sent.then !== 'function') {
          settle(null)
          return
        }
        sent.then(
          value => settle(value),
          () => settle(null),
        )
      })

      if (!response || typeof response !== 'object') return emptyScheduleSnapshot()
      if (response.requestId && response.requestId !== requestId) {
        return emptyScheduleSnapshot()
      }
      return snapshotFromResponse(response)
    } catch {
      return emptyScheduleSnapshot()
    }
  }

  return Object.freeze({
    getSnapshot() {
      return sendRequest(SCHEDULE_MESSAGE_TYPES.GET)
    },

    setAutoFillEnabled(enabled) {
      return sendRequest(SCHEDULE_MESSAGE_TYPES.SET_AUTOFILL, { enabled: enabled === true })
    },

    subscribe(onChange) {
      if (typeof onChange !== 'function' || destroyed) return () => {}
      listeners.add(onChange)
      return () => { listeners.delete(onChange) }
    },

    destroy() {
      destroyed = true
      listeners.clear()
      if (runtime?.onMessage && typeof runtime.onMessage.removeListener === 'function') {
        runtime.onMessage.removeListener(onRuntimeMessage)
      }
    },
  })
}
