export const DRAFT_MESSAGE_TYPES = Object.freeze({
  REQUEST: 'SHUCE_DRAFTS_REQUEST',
  PUBLISH: 'SHUCE_DRAFT_PUBLISH',
  RESULT: 'SHUCE_DRAFTS_RESULT',
  CONFIG_GET: 'SHUCE_DRAFTS_CONFIG_GET',
  CONFIG_SET: 'SHUCE_DRAFTS_CONFIG_SET',
  CONFIG_RESET: 'SHUCE_DRAFTS_CONFIG_RESET',
})

function createError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function defaultRandomUUID() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function responseError(response) {
  const code = typeof response?.error?.code === 'string'
    ? response.error.code
    : 'DRAFT_API_UNAVAILABLE'
  const message = typeof response?.error?.message === 'string'
    ? response.error.message
    : '述策助手无法读取草稿'
  return createError(code, message)
}

export function createDraftClient({
  runtime = globalThis.chrome?.runtime,
  timeoutMs = 10_000,
  randomUUID = defaultRandomUUID,
} = {}) {
  if (!runtime || typeof runtime.sendMessage !== 'function') {
    throw createError('DRAFT_API_UNAVAILABLE', '扩展消息通道不可用')
  }

  async function sendRequest(type, payload = {}) {
    const requestId = randomUUID()
    const message = { type, requestId, ...payload }
    let timer

    const response = await new Promise((resolve, reject) => {
      let settled = false
      const settle = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback(value)
      }

      timer = setTimeout(() => {
        settle(reject, createError('DRAFT_API_UNAVAILABLE', '等待草稿 API 响应超时'))
      }, timeoutMs)

      let sent
      try {
        sent = runtime.sendMessage(message)
      } catch {
        settle(reject, createError('DRAFT_API_UNAVAILABLE', '扩展消息通道不可用'))
        return
      }

      if (!sent || typeof sent.then !== 'function') {
        settle(reject, createError('DRAFT_API_UNAVAILABLE', '扩展消息通道没有返回结果'))
        return
      }
      sent.then(
        value => settle(resolve, value),
        () => settle(reject, createError('DRAFT_API_UNAVAILABLE', '扩展消息通道不可用')),
      )
    })

    if (!response || typeof response !== 'object') {
      throw createError('DRAFT_API_UNAVAILABLE', '草稿 API 返回为空')
    }
    if (response.requestId && response.requestId !== requestId) {
      throw createError('DRAFT_API_UNAVAILABLE', '草稿 API 响应已失效')
    }
    if (response.ok !== true) throw responseError(response)
    return response
  }

  return Object.freeze({
    async fetchDrafts(apiBase) {
      const response = await sendRequest(DRAFT_MESSAGE_TYPES.REQUEST, { apiBase })
      if (!Array.isArray(response.drafts)) {
        throw createError('DRAFT_API_INVALID_RESPONSE', '草稿 API 返回格式无效')
      }
      return response.drafts
    },

    async publishDraft(apiBase, draftId) {
      const response = await sendRequest(DRAFT_MESSAGE_TYPES.PUBLISH, { apiBase, draftId })
      if (!response.draft || typeof response.draft !== 'object' || Array.isArray(response.draft)) {
        throw createError('DRAFT_API_INVALID_RESPONSE', '草稿 API 返回格式无效')
      }
      return { draft: response.draft }
    },

    async getConfig() {
      const response = await sendRequest(DRAFT_MESSAGE_TYPES.CONFIG_GET)
      if (typeof response.apiBase !== 'string' || !response.apiBase) {
        throw createError('DRAFT_API_INVALID_RESPONSE', 'API 配置返回格式无效')
      }
      return { apiBase: response.apiBase }
    },

    async saveConfig(apiBase) {
      const response = await sendRequest(DRAFT_MESSAGE_TYPES.CONFIG_SET, { apiBase })
      if (typeof response.apiBase !== 'string' || !response.apiBase) {
        throw createError('DRAFT_API_INVALID_RESPONSE', 'API 配置返回格式无效')
      }
      return { apiBase: response.apiBase }
    },

    async resetConfig() {
      const response = await sendRequest(DRAFT_MESSAGE_TYPES.CONFIG_RESET)
      if (typeof response.apiBase !== 'string' || !response.apiBase) {
        throw createError('DRAFT_API_INVALID_RESPONSE', 'API 配置返回格式无效')
      }
      return { apiBase: response.apiBase }
    },
  })
}
