import {
  formatRelativeTime,
  getDraftTitle,
  getDraftTypeLabel,
  getDraftTypeOptions,
} from './draft-model.js'
import { createDraftClient } from './draft-client.js'
import { copyMarkdown } from './workbench-clipboard.js'
import { hydrateMarkdownImages, renderMarkdown } from './markdown-renderer.js'
import {
  applyDrafts,
  createWorkbenchState,
  getSelectedDraft,
  getVisibleDrafts,
  publishDraftAndSelectNext,
  selectDraft,
  shuffleDrafts,
  setWorkbenchFilter,
  setWorkbenchLayout,
  setWorkbenchSettingsOpen,
  WORKBENCH_LAYOUT_STORAGE_KEY,
} from './workbench-state.js'
import { createScheduleClient, emptyScheduleSnapshot } from './schedule-bridge.js'
import { formatScheduleSelection } from './schedule-memory.js'

const SAFE_UI_MESSAGES = Object.freeze({
  DRAFT_API_NOT_CONFIGURED: 'API 地址无效，请在设置中检查',
  DRAFT_API_PERMISSION_UNAVAILABLE: '当前浏览器不支持 API 域名授权',
  DRAFT_API_PERMISSION_DENIED: '未授权访问该 API 域名',
  DRAFT_API_INVALID_REQUEST: '发布请求无效',
  DRAFT_API_UNAVAILABLE: '草稿 API 暂不可用，请检查服务是否运行',
  DRAFT_API_INVALID_RESPONSE: '草稿 API 返回格式无效',
})

const STATIC_UI = [
  '<style>',
  'html, :root, .sw-root { color-scheme: dark; }',
  '* { box-sizing: border-box; }',
  '.sw-root { position: fixed; inset: 0; pointer-events: auto; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #e8eefc; }',
  '.sw-panel { position: absolute; inset: 0; width: auto; height: auto; max-width: none; max-height: none; padding: 1px; overflow: hidden; border-radius: 0; background: linear-gradient(145deg, rgba(103, 232, 249, .75), rgba(99, 102, 241, .5) 42%, rgba(192, 132, 252, .72)); box-shadow: 0 30px 90px rgba(2, 6, 23, .62), 0 0 48px rgba(59, 130, 246, .16); pointer-events: auto; animation: sw-rise .2s ease-out; }',
  '.sw-panel-inner { display: flex; flex-direction: column; width: 100%; height: 100%; overflow: hidden; border-radius: 0; background: radial-gradient(circle at 95% 0%, rgba(79, 70, 229, .2), transparent 34%), #0b1020; }',
  '.sw-header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; min-height: 0; padding: 14px 14px 12px 16px; border-bottom: 1px solid rgba(148, 163, 184, .15); }',
  '.sw-heading { min-width: min(100%, 160px); flex: 1 1 160px; }',
  '.sw-title { margin: 0; color: #f8fbff; font-size: 16px; font-weight: 780; letter-spacing: .02em; }',
  '.sw-subtitle { margin-top: 5px; color: #8290aa; font-size: 11px; }',
  '.sw-summary { display: flex; align-items: center; gap: 7px; flex: 0 1 auto; padding: 8px 10px; border: 1px solid rgba(125, 211, 252, .18); border-radius: 11px; color: #b8f4ff; background: rgba(8, 47, 73, .38); font-size: 11px; white-space: nowrap; }',
  '.sw-summary-dot { width: 6px; height: 6px; border-radius: 50%; background: #5eead4; box-shadow: 0 0 10px #5eead4; }',
  '.sw-schedule-memory { display: flex; flex-direction: column; gap: 3px; flex: 1 1 145px; min-width: 0; padding: 7px 9px; border: 1px solid rgba(192, 132, 252, .24); border-radius: 10px; color: #aebbd1; background: rgba(49, 46, 129, .24); font-size: 10px; white-space: nowrap; }',
  '.sw-schedule-memory strong { overflow: hidden; color: #e8ddff; font-size: 11px; font-weight: 700; text-overflow: ellipsis; }',
  '.sw-auto-schedule { display: inline-flex; align-items: center; gap: 5px; color: #c5d0e2; cursor: pointer; font-size: 10px; }',
  '.sw-auto-schedule input { width: 12px; height: 12px; margin: 0; accent-color: #67e8f9; cursor: pointer; }',
  '.sw-actions { display: flex; flex: 0 0 auto; gap: 5px; margin-left: auto; }',
  '.sw-icon-button, .sw-ghost-button, .sw-primary-button { border: 1px solid transparent; border-radius: 9px; color: #9eacc5; background: transparent; cursor: pointer; transition: color .15s ease, background .15s ease, border-color .15s ease, transform .15s ease; }',
  '.sw-icon-button { width: 32px; height: 32px; font-size: 16px; }',
  '.sw-icon-button:hover, .sw-ghost-button:hover { color: #e8fbff; border-color: rgba(125, 211, 252, .25); background: rgba(51, 65, 85, .46); }',
  '.sw-icon-button:active, .sw-primary-button:active { transform: scale(.96); }',
  '.sw-body { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(180px, 38%) minmax(0, 1fr); min-height: 0; flex: 1; }',
  '.sw-body[data-layout="split"] { grid-template-columns: minmax(140px, 38%) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); }',
  '.sw-body[data-layout="stack"] { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(180px, 38%) minmax(0, 1fr); }',
  '.sw-body[data-layout="stack"] .sw-sidebar { border-right: 0; border-bottom: 1px solid rgba(148, 163, 184, .14); }',
  '.sw-sidebar { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 15px 12px 13px 14px; border-right: 1px solid rgba(148, 163, 184, .14); background: rgba(15, 23, 42, .43); }',
  '.sw-search-wrap { position: relative; }',
  '.sw-search-icon { position: absolute; top: 9px; left: 11px; color: #65748e; font-size: 13px; pointer-events: none; }',
  '.sw-search { width: 100%; height: 34px; padding: 0 10px 0 30px; outline: none; border: 1px solid rgba(100, 116, 139, .28); border-radius: 10px; color: #e6eefb; background: rgba(15, 23, 42, .86); font-size: 12px; }',
  '.sw-search::placeholder { color: #64748b; }',
  '.sw-search:focus, .sw-settings-input:focus { border-color: rgba(103, 232, 249, .62); box-shadow: 0 0 0 3px rgba(34, 211, 238, .09); }',
  '.sw-filters { display: flex; gap: 6px; padding: 12px 2px 10px; overflow-x: auto; scrollbar-width: none; }',
  '.sw-filters::-webkit-scrollbar { display: none; }',
  '.sw-filter { flex: 0 0 auto; padding: 5px 9px; border: 1px solid rgba(100, 116, 139, .25); border-radius: 8px; color: #8190aa; background: rgba(30, 41, 59, .52); cursor: pointer; font-size: 11px; }',
  '.sw-filter:hover { color: #d8f9ff; border-color: rgba(103, 232, 249, .32); }',
  '.sw-filter[data-active="true"] { color: #07111f; border-color: transparent; background: linear-gradient(135deg, #67e8f9, #a5b4fc); font-weight: 760; }',
  '.sw-list { min-height: 0; flex: 1; overflow-y: auto; padding-right: 2px; scrollbar-color: rgba(100, 116, 139, .42) transparent; scrollbar-width: thin; }',
  '.sw-draft-row { display: block; width: 100%; margin-bottom: 6px; padding: 10px 10px 9px; outline: none; border: 1px solid transparent; border-radius: 11px; color: inherit; text-align: left; background: transparent; cursor: pointer; }',
  '.sw-draft-row:hover { border-color: rgba(100, 116, 139, .22); background: rgba(51, 65, 85, .34); }',
  '.sw-draft-row[data-selected="true"] { border-color: rgba(103, 232, 249, .38); background: linear-gradient(110deg, rgba(8, 47, 73, .8), rgba(49, 46, 129, .34)); box-shadow: inset 3px 0 #67e8f9; }',
  '.sw-draft-title { display: block; overflow: hidden; color: #e5edf9; font-size: 12px; font-weight: 670; line-height: 1.5; text-overflow: ellipsis; white-space: nowrap; }',
  '.sw-draft-meta { display: block; margin-top: 5px; overflow: hidden; color: #74839b; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }',
  '.sw-empty, .sw-error { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 160px; padding: 22px 12px; color: #7d8da8; text-align: center; font-size: 12px; line-height: 1.6; }',
  '.sw-empty-mark { display: grid; place-items: center; width: 36px; height: 36px; margin-bottom: 10px; border: 1px solid rgba(103, 232, 249, .22); border-radius: 12px; color: #67e8f9; background: rgba(8, 47, 73, .34); font-size: 17px; }',
  '.sw-error { align-items: stretch; color: #fda4af; }',
  '.sw-error strong { color: #fecdd3; font-size: 12px; }',
  '.sw-error span { margin-top: 5px; color: #a5b4c9; font-size: 11px; }',
  '.sw-retry { align-self: center; margin-top: 12px; padding: 6px 11px; border: 1px solid rgba(251, 113, 133, .35); border-radius: 8px; color: #fecdd3; background: rgba(127, 29, 29, .24); cursor: pointer; font-size: 11px; }',
  '.sw-skeleton { height: 52px; margin-bottom: 7px; border-radius: 11px; background: linear-gradient(90deg, rgba(30, 41, 59, .55), rgba(71, 85, 105, .42), rgba(30, 41, 59, .55)); background-size: 220% 100%; animation: sw-shimmer 1.3s ease-in-out infinite; }',
  '.sw-preview { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 25px 25px 20px; background: rgba(2, 6, 23, .17); }',
  '.sw-preview-article { display: flex; flex-direction: column; min-height: 0; flex: 1; overflow: hidden; }',
  '.sw-preview-article[hidden] { display: none; }',
  '.sw-preview-head { min-width: 0; flex-shrink: 0; padding-bottom: 17px; }',
  '.sw-preview-title { margin: 0; overflow: hidden; color: #f6f9ff; font-size: 18px; font-weight: 760; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }',
  '.sw-preview-meta { display: flex; align-items: center; gap: 7px; margin-top: 8px; color: #8391a8; font-size: 11px; }',
  '.sw-type-pill { padding: 3px 7px; border: 1px solid rgba(103, 232, 249, .22); border-radius: 6px; color: #a5f3fc; background: rgba(8, 47, 73, .42); }',
  '.sw-preview-divider { height: 1px; flex-shrink: 0; background: linear-gradient(90deg, rgba(103, 232, 249, .38), rgba(99, 102, 241, .18), transparent); }',
  '.sw-preview-content { min-height: 0; flex: 1; overflow-y: auto; padding: 18px 4px 18px 0; scrollbar-color: rgba(100, 116, 139, .42) transparent; scrollbar-width: thin; }',
  '.sw-markdown { color: #d9e3f2; font-size: 13px; line-height: 1.78; overflow-wrap: anywhere; }',
  '.sw-markdown > :first-child { margin-top: 0; }',
  '.sw-markdown > :last-child { margin-bottom: 0; }',
  '.sw-markdown-heading { margin: 20px 0 9px; color: #f6f9ff; font-weight: 760; line-height: 1.4; }',
  '.sw-markdown h1 { font-size: 21px; }',
  '.sw-markdown h2 { font-size: 18px; }',
  '.sw-markdown h3 { font-size: 16px; }',
  '.sw-markdown h4, .sw-markdown h5, .sw-markdown h6 { font-size: 14px; }',
  '.sw-markdown-paragraph { margin: 0 0 14px; }',
  '.sw-markdown-list { margin: 0 0 14px; padding-left: 24px; }',
  '.sw-markdown-list li + li { margin-top: 4px; }',
  '.sw-markdown-blockquote { margin: 0 0 14px; padding: 8px 13px; border-left: 3px solid rgba(103, 232, 249, .6); color: #aebbd1; background: rgba(15, 23, 42, .55); }',
  '.sw-markdown-rule { margin: 20px 0; border: 0; border-top: 1px solid rgba(148, 163, 184, .24); }',
  '.sw-markdown-inline-code { padding: 2px 5px; border-radius: 5px; color: #d9f99d; background: rgba(30, 41, 59, .86); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: .9em; }',
  '.sw-markdown-code-block { margin: 0 0 14px; padding: 12px 13px; overflow-x: auto; border: 1px solid rgba(100, 116, 139, .22); border-radius: 9px; color: #d9e3f2; background: rgba(2, 6, 23, .7); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11px; line-height: 1.65; white-space: pre-wrap; }',
  '.sw-markdown-link { color: #67e8f9; text-decoration: underline; text-decoration-color: rgba(103, 232, 249, .45); text-underline-offset: 2px; }',
  '.sw-markdown-link:hover { color: #cffafe; }',
  '.sw-markdown-image { display: block; width: auto; max-width: 100%; height: auto; margin: 13px 0 17px; border: 1px solid rgba(148, 163, 184, .2); border-radius: 10px; background: rgba(15, 23, 42, .48); object-fit: contain; }',
  '.sw-markdown-image-error { display: inline-flex; margin: 6px 0 12px; padding: 7px 9px; border: 1px solid rgba(251, 113, 133, .3); border-radius: 7px; color: #fda4af; background: rgba(127, 29, 29, .2); font-size: 11px; }',
  '.sw-preview-empty { display: grid; place-items: center; flex: 1; color: #71819b; font-size: 12px; }',
  '.sw-preview-footer { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 12px; padding-top: 11px; border-top: 1px solid rgba(148, 163, 184, .13); }',
  '.sw-char-count { color: #71819b; font-size: 10px; font-variant-numeric: tabular-nums; }',
  '.sw-preview-actions { display: flex; align-items: center; gap: 8px; }',
  '.sw-primary-button { min-width: 100px; padding: 8px 13px; border-color: rgba(103, 232, 249, .32); color: #07111f; background: linear-gradient(135deg, #67e8f9, #a5b4fc); font-size: 11px; font-weight: 760; }',
  '.sw-primary-button:hover { border-color: transparent; box-shadow: 0 7px 20px rgba(34, 211, 238, .18); }',
  '.sw-primary-button:disabled { opacity: .35; cursor: not-allowed; box-shadow: none; }',
  '.sw-settings { position: absolute; top: 68px; right: 15px; z-index: 2; width: 310px; padding: 14px; border: 1px solid rgba(125, 211, 252, .28); border-radius: 14px; background: rgba(15, 23, 42, .98); box-shadow: 0 20px 42px rgba(2, 6, 23, .46); }',
  '.sw-settings[hidden] { display: none; }',
  '.sw-settings-title { color: #e7f8ff; font-size: 12px; font-weight: 740; }',
  '.sw-settings-hint { margin: 6px 0 11px; color: #8290aa; font-size: 10px; line-height: 1.5; }',
  '.sw-settings-input { width: 100%; height: 34px; padding: 0 9px; outline: none; border: 1px solid rgba(100, 116, 139, .32); border-radius: 8px; color: #e6eefb; background: rgba(2, 6, 23, .7); font-size: 11px; }',
  '.sw-settings-actions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 11px; }',
  '.sw-ghost-button { padding: 7px 9px; border-color: rgba(100, 116, 139, .25); font-size: 10px; }',
  '.sw-settings-status { min-height: 18px; margin-top: 8px; color: #fda4af; font-size: 10px; line-height: 1.4; }',
  '.sw-toast { position: absolute; right: 21px; bottom: 17px; max-width: 300px; padding: 8px 11px; border: 1px solid rgba(94, 234, 212, .32); border-radius: 9px; color: #ccfbf1; background: rgba(13, 68, 65, .94); box-shadow: 0 12px 30px rgba(2, 6, 23, .32); font-size: 11px; opacity: 0; pointer-events: none; transform: translateY(5px); transition: opacity .18s ease, transform .18s ease; }',
  '.sw-toast.is-visible { opacity: 1; transform: translateY(0); }',
  '@keyframes sw-rise { from { opacity: 0; transform: translateY(8px) scale(.985); } to { opacity: 1; transform: translateY(0) scale(1); } }',
  '@keyframes sw-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }',
  '@media (max-width: 720px) { .sw-preview { padding: 19px 17px 16px; } .sw-settings { right: 8px; left: 8px; width: auto; } }',
  '@media (max-width: 420px) { .sw-heading { flex: 1 1 100%; } .sw-schedule-memory { flex: 1 1 auto; min-width: 0; } .sw-actions { margin-left: auto; } }',
  '</style>',
  '<section class="sw-panel" data-role="panel" aria-label="述策发布指挥台">',
  '<div class="sw-panel-inner">',
  '<header class="sw-header">',
  '<div class="sw-heading"><h1 class="sw-title">述策发布指挥台</h1><div class="sw-subtitle">从草稿箱挑选内容，复制后交给 X 发布</div></div>',
  '<div class="sw-summary"><span class="sw-summary-dot"></span><span data-role="summary">0 条待发布</span></div>',
  '<div class="sw-schedule-memory"><strong data-role="last-schedule">上次安排：未记录</strong><label class="sw-auto-schedule"><input type="checkbox" data-role="auto-schedule"><span>自动填入发布时间</span></label></div>',
  '<div class="sw-actions">',
  '<button class="sw-icon-button" type="button" data-action="refresh" title="刷新草稿">↻</button>',
  '<button class="sw-icon-button" type="button" data-action="shuffle" title="按图文比例重新排序">⤨</button>',
  '<button class="sw-icon-button" type="button" data-action="settings" title="API 设置">⚙</button>',
  '<button class="sw-icon-button" type="button" data-action="layout" title="左右布局" aria-label="左右布局">☰</button>',
  '</div>',
  '</header>',
  '<div class="sw-body" data-role="body">',
  '<aside class="sw-sidebar">',
  '<div class="sw-search-wrap"><span class="sw-search-icon">⌕</span><input class="sw-search" data-role="search" type="search" placeholder="搜索标题或正文" aria-label="搜索标题或正文"></div>',
  '<div class="sw-filters" data-role="filters"></div>',
  '<div class="sw-list" data-role="list"></div>',
  '</aside>',
  '<main class="sw-preview">',
  '<div class="sw-preview-empty" data-role="preview-empty">选择左侧草稿查看原文</div>',
  '<article class="sw-preview-article" data-role="preview" hidden>',
  '<div class="sw-preview-head"><h2 class="sw-preview-title" data-role="preview-title"></h2><div class="sw-preview-meta"><span class="sw-type-pill" data-role="preview-type"></span><span data-role="preview-time"></span></div></div>',
  '<div class="sw-preview-divider"></div>',
  '<div class="sw-preview-content"><div data-role="preview-content"></div></div>',
  '<footer class="sw-preview-footer"><span class="sw-char-count" data-role="char-count">0 字</span><div class="sw-preview-actions"><button class="sw-ghost-button" type="button" data-action="copy" disabled>复制 Markdown</button><button class="sw-primary-button" type="button" data-action="publish" disabled>发布并下一条</button></div></footer>',
  '</article>',
  '</main>',
  '</div>',
  '<div class="sw-settings" data-role="settings" hidden>',
  '<div class="sw-settings-title">连接 Ediora</div>',
  '<div class="sw-settings-hint">支持任意 HTTP/HTTPS API；首次连接某个域名时需要授权。</div>',
  '<input class="sw-settings-input" data-role="api-input" type="url" spellcheck="false" aria-label="API 地址">',
  '<div class="sw-settings-status" data-role="settings-status"></div>',
  '<div class="sw-settings-actions"><button class="sw-ghost-button" type="button" data-action="reset-config">恢复默认</button><button class="sw-primary-button" type="button" data-action="save-config">保存并刷新</button></div>',
  '</div>',
  '<div class="sw-toast" data-role="toast" aria-live="polite"></div>',
  '</div>',
  '</section>',
].join('')

function safeMessage(error) {
  if (typeof error?.code === 'string' && SAFE_UI_MESSAGES[error.code]) return SAFE_UI_MESSAGES[error.code]
  return '工作台暂时无法完成操作，请稍后重试'
}

function createElement(document, tag, className, text) {
  const element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

export function getPreviewMountKey(draft, apiBase = '') {
  if (!draft || draft.id === undefined || draft.id === null) return ''
  return `${String(draft.id)}\u0000${String(draft.content ?? '')}\u0000${String(apiBase ?? '')}`
}

export function shouldRemountPreview(previousKey, nextKey) {
  return previousKey !== nextKey
}

export function syncPreviewVisibility({ previewEmpty, preview, hasDraft }) {
  previewEmpty.hidden = hasDraft
  previewEmpty.style.display = hasDraft ? 'none' : ''
  preview.hidden = !hasDraft
}

export function mountWorkbench({ document, window, chromeApi = globalThis.chrome, surface } = {}) {
  if (surface !== 'sidepanel') return { destroy() {} }
  if (!document || !window || !chromeApi?.runtime) return { destroy() {} }

  const root = document.createElement('div')
  root.className = 'sw-root'
  root.innerHTML = STATIC_UI
  document.body.appendChild(root)
  const query = selector => root.querySelector(selector)
  const panel = query('[data-role="panel"]')
  const body = query('[data-role="body"]')
  const summary = query('[data-role="summary"]')
  const lastSchedule = query('[data-role="last-schedule"]')
  const autoSchedule = query('[data-role="auto-schedule"]')
  const search = query('[data-role="search"]')
  const filters = query('[data-role="filters"]')
  const list = query('[data-role="list"]')
  const previewEmpty = query('[data-role="preview-empty"]')
  const preview = query('[data-role="preview"]')
  const previewTitle = query('[data-role="preview-title"]')
  const previewType = query('[data-role="preview-type"]')
  const previewTime = query('[data-role="preview-time"]')
  const previewContent = query('[data-role="preview-content"]')
  const charCount = query('[data-role="char-count"]')
  const copyButton = query('[data-action="copy"]')
  const publishButton = query('[data-action="publish"]')
  const refreshButton = query('[data-action="refresh"]')
  const shuffleButton = query('[data-action="shuffle"]')
  const settingsButton = query('[data-action="settings"]')
  const layoutButton = query('[data-action="layout"]')
  const settings = query('[data-role="settings"]')
  const apiInput = query('[data-role="api-input"]')
  const settingsStatus = query('[data-role="settings-status"]')
  const toast = query('[data-role="toast"]')

  const client = createDraftClient({
    runtime: chromeApi.runtime,
    permissions: chromeApi.permissions,
  })
  const scheduleClient = createScheduleClient({ runtime: chromeApi.runtime })
  let scheduleSnapshot = emptyScheduleSnapshot()
  let state = createWorkbenchState()
  let settingsDraft = state.apiBase
  let loadSequence = 0
  let toastTimer
  let previewMountKey = ''
  const previewImageCache = new Map()

  function renderLastSchedule(selection = scheduleSnapshot.selection) {
    const formatted = formatScheduleSelection(selection)
    lastSchedule.textContent = formatted ? `上次安排：${formatted}` : '上次安排：未记录'
  }

  async function refreshSchedule() {
    scheduleSnapshot = await scheduleClient.getSnapshot()
    renderLastSchedule(scheduleSnapshot.selection)
    autoSchedule.checked = scheduleSnapshot.autoFillEnabled === true
    autoSchedule.disabled = scheduleSnapshot.available !== true
  }

  scheduleClient.subscribe(snapshot => {
    scheduleSnapshot = snapshot
    renderLastSchedule(snapshot.selection)
    autoSchedule.checked = snapshot.autoFillEnabled === true
    autoSchedule.disabled = snapshot.available !== true
  })

  function renderFilters() {
    filters.replaceChildren()
    const options = ['all', ...getDraftTypeOptions(state.drafts)]
    options.forEach(type => {
      const button = createElement(document, 'button', 'sw-filter', type === 'all' ? '全部' : getDraftTypeLabel(type))
      button.type = 'button'
      button.disabled = state.publishingId !== null
      button.dataset.type = type
      button.dataset.active = String(state.type === type)
      filters.appendChild(button)
    })
  }

  function renderList() {
    list.replaceChildren()
    if (state.loading) {
      for (let index = 0; index < 5; index += 1) list.appendChild(createElement(document, 'div', 'sw-skeleton'))
      return
    }

    if (state.error) {
      const errorBox = createElement(document, 'div', 'sw-error')
      errorBox.appendChild(createElement(document, 'strong', '', '读取草稿失败'))
      errorBox.appendChild(createElement(document, 'span', '', state.error.message))
      const retry = createElement(document, 'button', 'sw-retry', '重试')
      retry.type = 'button'
      retry.dataset.action = 'retry'
      errorBox.appendChild(retry)
      list.appendChild(errorBox)
      return
    }

    const visible = getVisibleDrafts(state)
    if (!visible.length) {
      const empty = createElement(document, 'div', 'sw-empty')
      empty.appendChild(createElement(document, 'div', 'sw-empty-mark', state.drafts.length ? '⌕' : '○'))
      empty.appendChild(createElement(document, 'div', '', state.drafts.length ? '没有匹配的草稿' : '暂无待发布草稿'))
      if (!state.drafts.length) {
        const refresh = createElement(document, 'button', 'sw-retry', '刷新列表')
        refresh.type = 'button'
        refresh.dataset.action = 'refresh'
        empty.appendChild(refresh)
      }
      list.appendChild(empty)
      return
    }

    visible.forEach(draft => {
      const row = createElement(document, 'button', 'sw-draft-row')
      row.type = 'button'
      row.disabled = state.publishingId !== null
      row.dataset.draftId = String(draft.id)
      row.dataset.selected = String(String(draft.id) === String(state.selectedId))
      row.appendChild(createElement(document, 'span', 'sw-draft-title', getDraftTitle(draft)))
      row.appendChild(createElement(
        document,
        'span',
        'sw-draft-meta',
        getDraftTypeLabel(draft.draft_type) + ' · ' + formatRelativeTime(draft.updated_at),
      ))
      list.appendChild(row)
    })
  }

  function renderPreview() {
    const draft = getSelectedDraft(state)
    syncPreviewVisibility({ previewEmpty, preview, hasDraft: Boolean(draft) })
    if (!draft) {
      if (shouldRemountPreview(previewMountKey, '')) {
        previewMountKey = ''
        previewContent.replaceChildren()
      }
      copyButton.disabled = true
      publishButton.disabled = true
      copyButton.textContent = '复制 Markdown'
      publishButton.textContent = '发布并下一条'
      return
    }

    previewTitle.textContent = getDraftTitle(draft)
    previewType.textContent = getDraftTypeLabel(draft.draft_type)
    previewTime.textContent = formatRelativeTime(draft.updated_at)
    const nextKey = getPreviewMountKey(draft, state.apiBase)
    if (shouldRemountPreview(previewMountKey, nextKey)) {
      previewMountKey = nextKey
      const rendered = renderMarkdown(draft.content, {
        document,
        apiBase: state.apiBase,
      })
      previewContent.replaceChildren(rendered.element)
      const apiBase = state.apiBase
      void hydrateMarkdownImages(rendered.element, {
        fetchImage: imageUrl => client.fetchImage(apiBase, imageUrl),
        cache: previewImageCache,
      })
    }
    charCount.textContent = Array.from(draft.content).length + ' 字'
    const visible = getVisibleDrafts(state)
    const visibleSelection = visible.some(item => String(item.id) === String(draft.id))
    const publishing = state.publishingId !== null
      && String(state.publishingId) === String(draft.id)
    copyButton.disabled = !draft.content || state.publishingId !== null
    publishButton.disabled = !draft.content || !visibleSelection || state.publishingId !== null
    copyButton.textContent = state.copyState === 'success' ? '已复制 Markdown' : '复制 Markdown'
    publishButton.textContent = publishing ? '发布中…' : '发布并下一条'
  }

  function render() {
    root.dataset.layout = state.layout
    body.dataset.layout = state.layout
    const layoutLabel = state.layout === 'split' ? '上下布局' : '左右布局'
    layoutButton.title = layoutLabel
    layoutButton.setAttribute('aria-label', layoutLabel)
    panel.hidden = false
    summary.textContent = state.drafts.length + ' 条待发布'
    search.value = state.query
    search.disabled = state.publishingId !== null
    apiInput.value = settingsDraft
    settings.hidden = !state.settingsOpen
    autoSchedule.checked = scheduleSnapshot.autoFillEnabled === true
    autoSchedule.disabled = scheduleSnapshot.available !== true
    refreshButton.disabled = state.publishingId !== null
    shuffleButton.disabled = state.publishingId !== null
    settingsButton.disabled = state.publishingId !== null
    layoutButton.disabled = state.publishingId !== null
    renderLastSchedule()
    renderFilters()
    renderList()
    renderPreview()
  }

  function notify(message) {
    toast.textContent = message
    toast.classList.add('is-visible')
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200)
  }

  async function loadDrafts() {
    const sequence = ++loadSequence
    state = { ...state, loading: true, error: null }
    render()

    try {
      const rawDrafts = await client.fetchDrafts(state.apiBase)
      if (sequence !== loadSequence) return
      state = applyDrafts(state, rawDrafts)
    } catch (error) {
      if (sequence !== loadSequence) return
      state = { ...state, loading: false, error: { message: safeMessage(error) } }
    }
    render()
  }

  async function initialize() {
    try {
      const stored = await chromeApi.storage?.local?.get?.(WORKBENCH_LAYOUT_STORAGE_KEY)
      state = setWorkbenchLayout(state, stored?.[WORKBENCH_LAYOUT_STORAGE_KEY])
    } catch {}
    await refreshSchedule()
    try {
      const config = await client.getConfig()
      state = { ...state, apiBase: config.apiBase }
      settingsDraft = config.apiBase
    } catch {
      settingsDraft = state.apiBase
    }
    render()
    await loadDrafts()
  }

  async function saveConfig() {
    settingsStatus.textContent = ''
    try {
      const apiBase = await client.requestApiPermission(settingsDraft)
      const config = await client.saveConfig(apiBase)
      state = { ...state, apiBase: config.apiBase, settingsOpen: false, error: null }
      settingsDraft = config.apiBase
      render()
      await loadDrafts()
      notify('API 地址已保存，草稿已刷新')
    } catch (error) {
      settingsStatus.textContent = safeMessage(error)
    }
  }

  async function resetConfig() {
    settingsStatus.textContent = ''
    try {
      const config = await client.resetConfig()
      state = { ...state, apiBase: config.apiBase }
      settingsDraft = config.apiBase
      render()
      await loadDrafts()
      notify('已恢复默认 API 地址')
    } catch (error) {
      settingsStatus.textContent = safeMessage(error)
    }
  }

  async function copySelected() {
    const draft = getSelectedDraft(state)
    if (!draft?.content || state.publishingId !== null) return
    try {
      const rendered = renderMarkdown(draft.content, {
        document,
        apiBase: state.apiBase,
        deferLocalImages: false,
      })
      await copyMarkdown(draft.content, {
        html: rendered.html,
        document,
        clipboard: window.navigator?.clipboard,
        clipboardItemClass: window.ClipboardItem,
        blobClass: window.Blob,
      })
      state = { ...state, copyState: 'success' }
      renderPreview()
      notify('Markdown 已复制到剪贴板')
      window.setTimeout(() => {
        if (state.copyState === 'success') {
          state = { ...state, copyState: 'idle' }
          renderPreview()
        }
      }, 2200)
    } catch (error) {
      state = { ...state, copyState: 'error' }
      renderPreview()
      notify(error?.code === 'CLIPBOARD_FAILED' ? error.message : '复制失败，请手动选择正文复制')
    }
  }

  async function publishSelected() {
    const draft = getSelectedDraft(state)
    if (!draft?.content || state.publishingId !== null) return

    const draftId = draft.id
    state = { ...state, publishingId: draftId, error: null }
    render()

    try {
      await client.publishDraft(state.apiBase, draftId)
      state = publishDraftAndSelectNext(state, draftId)
      render()
      notify('已标记为已发布，已进入下一条')
    } catch (error) {
      state = { ...state, publishingId: null }
      render()
      notify(safeMessage(error))
    }
  }

  query('[data-action="refresh"]').addEventListener('click', () => {
    if (state.publishingId === null) void loadDrafts()
  })
  shuffleButton.addEventListener('click', () => {
    if (state.publishingId !== null) return
    state = shuffleDrafts(state)
    render()
  })
  query('[data-action="settings"]').addEventListener('click', () => {
    if (state.publishingId !== null) return
    settingsDraft = state.apiBase
    state = setWorkbenchSettingsOpen(state, !state.settingsOpen)
    render()
  })
  query('[data-action="layout"]').addEventListener('click', () => {
    if (state.publishingId !== null) return
    state = setWorkbenchLayout(state, state.layout === 'split' ? 'stack' : 'split')
    render()
    void chromeApi.storage?.local?.set?.({
      [WORKBENCH_LAYOUT_STORAGE_KEY]: state.layout,
    }).catch?.(() => {})
  })
  query('[data-action="save-config"]').addEventListener('click', () => void saveConfig())
  query('[data-action="reset-config"]').addEventListener('click', () => void resetConfig())
  copyButton.addEventListener('click', () => void copySelected())
  publishButton.addEventListener('click', () => void publishSelected())
  search.addEventListener('input', event => {
    if (state.publishingId !== null) return
    state = setWorkbenchFilter(state, { query: event.target.value })
    render()
  })
  apiInput.addEventListener('input', event => {
    settingsDraft = event.target.value
  })
  autoSchedule.addEventListener('change', () => {
    void scheduleClient.setAutoFillEnabled(autoSchedule.checked).then(refreshSchedule)
  })
  filters.addEventListener('click', event => {
    if (state.publishingId !== null) return
    const button = event.target.closest('[data-type]')
    if (!button) return
    state = setWorkbenchFilter(state, { type: button.dataset.type })
    render()
  })
  list.addEventListener('click', event => {
    if (state.publishingId !== null) return
    const row = event.target.closest('[data-draft-id]')
    if (!row) return
    state = selectDraft(state, row.dataset.draftId)
    render()
  })
  list.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action
    if (action === 'retry' || action === 'refresh') void loadDrafts()
  })

  function destroy() {
    window.clearTimeout(toastTimer)
    scheduleClient.destroy()
    root.remove()
  }
  render()
  void initialize()

  return { destroy }
}
