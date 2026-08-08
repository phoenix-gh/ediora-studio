const LAST_EXECUTION_KEY = 'lastExecution'

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    [LAST_EXECUTION_KEY]: null,
  })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'SHUCE_EXECUTION_RECORDED') return false

  const record = {
    requestId: typeof message.requestId === 'string' ? message.requestId : '',
    ok: message.ok === true,
    action: typeof message.action === 'string' ? message.action : '',
    errorCode: typeof message.errorCode === 'string' ? message.errorCode : '',
    finishedAt: new Date().toISOString(),
  }
  chrome.storage.local.set({ [LAST_EXECUTION_KEY]: record })
  sendResponse({ ok: true })
  return true
})
