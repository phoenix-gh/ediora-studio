const CONSOLE_API_URL = chrome.runtime.getURL('injected/console-api.js')
const PROTOCOL_URL = chrome.runtime.getURL('content/bridge-protocol.js')
const PUBLISHER_URL = chrome.runtime.getURL('content/publisher.js')

let consoleApiInjected = false
let protocolPromise
let publisherPromise

function injectConsoleApi() {
  if (consoleApiInjected) return
  consoleApiInjected = true
  const script = document.createElement('script')
  script.type = 'module'
  script.src = CONSOLE_API_URL
  script.onload = () => script.remove()
  ;(document.head || document.documentElement).appendChild(script)
}

function loadProtocol() {
  protocolPromise ||= import(PROTOCOL_URL)
  return protocolPromise
}

function loadPublisher() {
  publisherPromise ||= import(PUBLISHER_URL)
  return publisherPromise
}

function recordExecution(requestId, result) {
  const errorCode = result?.error?.code || ''
  chrome.runtime.sendMessage({
    type: 'SHUCE_EXECUTION_RECORDED',
    requestId,
    ok: result?.ok === true,
    action: result?.action || '',
    errorCode,
  }).catch(() => {})
}

window.addEventListener('message', event => {
  if (event.source !== window) return

  loadProtocol().then(({ createResultMessage, isPublishRequestMessage }) => {
    if (!isPublishRequestMessage(event.data)) return
    const { requestId, payload } = event.data
    return loadPublisher()
      .then(({ publish }) => publish(payload))
      .then(result => {
        window.postMessage(createResultMessage(requestId, result), '*')
        recordExecution(requestId, result)
      })
      .catch(error => {
        const normalized = {
          code: typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : '述策助手执行失败',
        }
        const result = { ok: false, error: normalized }
        window.postMessage(createResultMessage(requestId, null, normalized), '*')
        recordExecution(requestId, result)
      })
  }).catch(error => {
    console.error('述策助手桥接初始化失败', error)
  })
})

injectConsoleApi()
