import {
  API_BASE_STORAGE_KEY,
  DEFAULT_API_BASE,
  assertAllowedApiBase,
  fetchDraftImage,
  fetchDraftCollection,
  publishDraft,
} from './draft-api.js'
import { isXSiteUrl } from './x-site.js'
import {
  routeScheduleRequest,
  SCHEDULE_MESSAGE_TYPES,
} from '../content/schedule-bridge.js'

const DRAFTS_REQUEST_TYPE = 'SHUCE_DRAFTS_REQUEST'
const DRAFT_IMAGE_REQUEST_TYPE = 'SHUCE_DRAFT_IMAGE_REQUEST'
const DRAFT_PUBLISH_TYPE = 'SHUCE_DRAFT_PUBLISH'
const DRAFTS_RESULT_TYPE = 'SHUCE_DRAFTS_RESULT'
const CONFIG_GET_TYPE = 'SHUCE_DRAFTS_CONFIG_GET'
const CONFIG_SET_TYPE = 'SHUCE_DRAFTS_CONFIG_SET'
const CONFIG_RESET_TYPE = 'SHUCE_DRAFTS_CONFIG_RESET'

const SAFE_ERROR_MESSAGES = Object.freeze({
  DRAFT_API_NOT_CONFIGURED: 'API 地址无效',
  DRAFT_API_HOST_NOT_ALLOWED: '当前扩展只允许本机 8000 端口 API',
  DRAFT_API_INVALID_REQUEST: '发布请求无效',
  DRAFT_API_UNAVAILABLE: '草稿 API 暂不可用，请检查服务是否运行',
  DRAFT_API_INVALID_RESPONSE: '草稿 API 返回格式无效',
})

const {
  GET: SHUCE_SCHEDULE_GET,
  SET_AUTOFILL: SHUCE_SCHEDULE_SET_AUTOFILL,
} = SCHEDULE_MESSAGE_TYPES

export function sidePanelOptionsForUrl(url) {
  return {
    path: 'sidepanel/index.html',
    enabled: isXSiteUrl(url),
  }
}

export async function syncSidePanelForTab(tabId, url, sidePanel = globalThis.chrome?.sidePanel) {
  if (!sidePanel || !Number.isInteger(tabId)) return
  await sidePanel.setOptions({ tabId, ...sidePanelOptionsForUrl(url) })
}

function requestIdOf(message) {
  return typeof message?.requestId === 'string' ? message.requestId : ''
}

function safeError(error) {
  const code = typeof error?.code === 'string' && SAFE_ERROR_MESSAGES[error.code]
    ? error.code
    : 'DRAFT_API_UNAVAILABLE'
  return { code, message: SAFE_ERROR_MESSAGES[code] }
}

async function readConfiguredApiBase() {
  const stored = await chrome.storage.local.get(API_BASE_STORAGE_KEY)
  if (typeof stored?.[API_BASE_STORAGE_KEY] !== 'string') return DEFAULT_API_BASE

  try {
    return assertAllowedApiBase(stored[API_BASE_STORAGE_KEY])
  } catch {
    return DEFAULT_API_BASE
  }
}

async function handleDraftsRequest(message) {
  const configured = await readConfiguredApiBase()
  const apiBase = typeof message.apiBase === 'string' && message.apiBase.trim()
    ? message.apiBase
    : configured
  return fetchDraftCollection(apiBase)
}

async function handleDraftImageRequest(message) {
  const configured = await readConfiguredApiBase()
  const apiBase = typeof message.apiBase === 'string' && message.apiBase.trim()
    ? message.apiBase
    : configured
  return fetchDraftImage(apiBase, message.imageUrl)
}

async function handleDraftPublishRequest(message) {
  const configured = await readConfiguredApiBase()
  const apiBase = typeof message.apiBase === 'string' && message.apiBase.trim()
    ? message.apiBase
    : configured
  return publishDraft(apiBase, message.draftId)
}

async function handleDraftMessage(message) {
  const requestId = requestIdOf(message)

  if (message.type === DRAFTS_REQUEST_TYPE) {
    const drafts = await handleDraftsRequest(message)
    return {
      type: DRAFTS_RESULT_TYPE,
      requestId,
      ok: true,
      drafts,
    }
  }

  if (message.type === DRAFT_IMAGE_REQUEST_TYPE) {
    const image = await handleDraftImageRequest(message)
    return {
      type: DRAFTS_RESULT_TYPE,
      requestId,
      ok: true,
      ...image,
    }
  }

  if (message.type === DRAFT_PUBLISH_TYPE) {
    const draft = await handleDraftPublishRequest(message)
    return {
      type: DRAFTS_RESULT_TYPE,
      requestId,
      ok: true,
      draft,
    }
  }

  if (message.type === CONFIG_GET_TYPE) {
    return {
      type: DRAFTS_RESULT_TYPE,
      requestId,
      ok: true,
      apiBase: await readConfiguredApiBase(),
    }
  }

  if (message.type === CONFIG_SET_TYPE) {
    const apiBase = assertAllowedApiBase(message.apiBase)
    await chrome.storage.local.set({ [API_BASE_STORAGE_KEY]: apiBase })
    return { type: DRAFTS_RESULT_TYPE, requestId, ok: true, apiBase }
  }

  if (message.type === CONFIG_RESET_TYPE) {
    await chrome.storage.local.remove(API_BASE_STORAGE_KEY)
    return {
      type: DRAFTS_RESULT_TYPE,
      requestId,
      ok: true,
      apiBase: DEFAULT_API_BASE,
    }
  }

  return null
}

if (globalThis.chrome?.sidePanel) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  chrome.sidePanel.setOptions({ enabled: false }).catch(() => {})
  chrome.tabs.onUpdated.addListener((tabId, _info, tab) => {
    void syncSidePanelForTab(tabId, tab?.url)
  })
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    void syncSidePanelForTab(tabId, tab?.url)
  })
}

if (globalThis.chrome?.runtime) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const draftMessageTypes = new Set([
      DRAFTS_REQUEST_TYPE,
      DRAFT_IMAGE_REQUEST_TYPE,
      DRAFT_PUBLISH_TYPE,
      CONFIG_GET_TYPE,
      CONFIG_SET_TYPE,
      CONFIG_RESET_TYPE,
    ])
    if (message?.type === SHUCE_SCHEDULE_GET || message?.type === SHUCE_SCHEDULE_SET_AUTOFILL) {
      return routeScheduleRequest(message, {
        queryTabs: query => chrome.tabs.query(query),
        sendToTab: (tabId, payload) => chrome.tabs.sendMessage(tabId, payload),
        isXSiteUrl,
      })
    }
    if (!draftMessageTypes.has(message?.type)) return false

    handleDraftMessage(message)
      .then(sendResponse)
      .catch(error => sendResponse({
        type: DRAFTS_RESULT_TYPE,
        requestId: requestIdOf(message),
        ok: false,
        error: safeError(error),
      }))
    return true
  })
}
