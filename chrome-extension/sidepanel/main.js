import { mountWorkbench } from '../content/workbench-runtime.js'

mountWorkbench({
  document,
  window,
  chromeApi: chrome,
  surface: 'sidepanel',
})
