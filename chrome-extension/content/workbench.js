(() => {
  const hostUrl = chrome.runtime.getURL('content/schedule-host.js')
  import(hostUrl)
    .then(({ startScheduleHost }) => startScheduleHost({ document, window, chromeApi: chrome }))
    .catch(error => console.error('述策助手安排表初始化失败', error))
})()
