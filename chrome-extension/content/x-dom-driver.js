import { contractError, ERROR_CODES } from './contracts.js'
import { findFirst, SELECTORS } from './selectors.js'

const DEFAULT_TIMEOUT_MS = 8000
const POLL_INTERVAL_MS = 100
const SUCCESS_PHRASES = [
  'your post was sent',
  'post sent',
  'your post is scheduled',
  'post scheduled',
  '已发布',
  '发布成功',
  '已安排',
  '安排成功',
]

function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim()
}

function elementText(element) {
  if (!element) return ''
  return normalizeText(element.innerText ?? element.textContent ?? element.value ?? '')
}

function documentHostname(pageWindow) {
  return String(pageWindow?.location?.hostname ?? '').toLowerCase().replace(/\.$/, '')
}

export function isXHost(hostname) {
  const normalized = String(hostname ?? '').toLowerCase().replace(/\.$/, '')
  return normalized === 'x.com' || normalized === 'twitter.com'
}

export function hasSubmissionEvidence({ composer, successText = '' }) {
  if (!composer) return true
  const normalized = normalizeText(successText).toLowerCase()
  return SUCCESS_PHRASES.some(phrase => normalized.includes(phrase.toLowerCase()))
}

function createDomEvent(pageWindow, type, init = {}) {
  if (typeof pageWindow?.InputEvent === 'function' && (type === 'beforeinput' || type === 'input')) {
    return new pageWindow.InputEvent(type, {
      bubbles: true,
      cancelable: type === 'beforeinput',
      inputType: 'insertText',
      data: init.data ?? '',
    })
  }
  if (typeof pageWindow?.Event === 'function') {
    return new pageWindow.Event(type, { bubbles: true, cancelable: type === 'beforeinput' })
  }
  return { type, bubbles: true, cancelable: type === 'beforeinput', ...init }
}

function dispatchEvent(element, pageWindow, type, init) {
  if (typeof element?.dispatchEvent === 'function') {
    element.dispatchEvent(createDomEvent(pageWindow, type, init))
  }
}

function setNativeValue(element, value) {
  const prototype = Object.getPrototypeOf(element)
  const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')
  if (descriptor?.set) {
    descriptor.set.call(element, value)
  } else {
    element.value = value
  }
}

function writeFallback(composer, pageWindow, text) {
  if ('value' in composer && typeof composer.value === 'string') {
    setNativeValue(composer, text)
  } else {
    composer.textContent = text
  }
  dispatchEvent(composer, pageWindow, 'input', { data: text })
}

function readComposerElement(document) {
  return findFirst(document, SELECTORS.composer)
}

function readSuccessText(document) {
  return SELECTORS.success
    .map(selector => findFirst(document, [selector]))
    .filter(Boolean)
    .map(elementText)
    .filter(Boolean)
    .join('\n')
}

function waitFor(predicate, { timeoutMs = DEFAULT_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  return new Promise(resolve => {
    const check = () => {
      let value = false
      try {
        value = predicate()
      } catch {
        value = false
      }
      if (value) {
        resolve(value)
        return
      }
      if (Date.now() >= deadline) {
        resolve(null)
        return
      }
      setTimeout(check, intervalMs)
    }
    check()
  })
}

export function createXDomDriver(document, pageWindow = globalThis.window) {
  const ensureSupported = () => {
    if (!isXHost(documentHostname(pageWindow))) {
      throw contractError(ERROR_CODES.UNSUPPORTED_PAGE, '述策助手只能在 X 页面运行')
    }
  }

  return {
    async assertSupportedPage() {
      ensureSupported()
    },

    async ensureComposer() {
      ensureSupported()
      if (readComposerElement(document)) return

      const trigger = findFirst(document, SELECTORS.composeTrigger)
      if (!trigger || typeof trigger.click !== 'function') {
        throw contractError(ERROR_CODES.COMPOSER_NOT_FOUND, '找不到 X 发帖入口')
      }
      trigger.click()
      const composer = await waitFor(() => readComposerElement(document))
      if (!composer) {
        throw contractError(ERROR_CODES.COMPOSER_NOT_FOUND, '打开后仍找不到 X 发帖编辑器')
      }
    },

    async readComposerText() {
      const composer = readComposerElement(document)
      if (!composer) {
        throw contractError(ERROR_CODES.COMPOSER_NOT_FOUND, '找不到 X 发帖编辑器')
      }
      return elementText(composer)
    },

    async writeComposerText(text) {
      const composer = readComposerElement(document)
      if (!composer) {
        throw contractError(ERROR_CODES.COMPOSER_NOT_FOUND, '找不到 X 发帖编辑器')
      }
      if (elementText(composer)) {
        throw contractError(ERROR_CODES.EXISTING_DRAFT, '编辑器中已有未提交内容')
      }
      if (typeof composer.focus === 'function') composer.focus()
      dispatchEvent(composer, pageWindow, 'beforeinput', { data: text })

      const inserted = typeof document.execCommand === 'function'
        && document.execCommand('insertText', false, text)
      if (!inserted) writeFallback(composer, pageWindow, text)
    },

    async clickFinalSubmit() {
      const submit = findFirst(document, SELECTORS.submit)
      if (!submit || typeof submit.click !== 'function') {
        throw contractError(ERROR_CODES.COMPOSER_NOT_FOUND, '找不到 X 发布按钮')
      }
      if (submit.disabled || submit.getAttribute?.('aria-disabled') === 'true') {
        throw contractError(ERROR_CODES.COMPOSER_NOT_FOUND, 'X 发布按钮当前不可用')
      }
      submit.click()
    },

    async waitForSubmissionEvidence(_mode) {
      const evidence = await waitFor(() => {
        const composer = readComposerElement(document)
        const successText = readSuccessText(document)
        return hasSubmissionEvidence({ composer, successText })
      })
      return Boolean(evidence)
    },
  }
}
