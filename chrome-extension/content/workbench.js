(() => {
  const runtimeUrl = chrome.runtime.getURL('content/workbench-runtime.js')
  import(runtimeUrl)
    .then(({ mountWorkbench }) => mountWorkbench({ document, window, chromeApi: chrome }))
    .catch(error => console.error('述策助手工作台初始化失败', error))
})()
