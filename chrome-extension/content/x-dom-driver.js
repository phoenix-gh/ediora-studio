import { contractError, ERROR_CODES } from './contracts.js'
import { findFirst, inferScheduleControls, SELECTORS } from './selectors.js'

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
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
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

function optionText(option) {
  return String(option?.text ?? option?.textContent ?? '').trim()
}

function optionMatches(option, expected, aliases = []) {
  const wanted = String(expected).trim().toLowerCase()
  const values = [option?.value, optionText(option), ...aliases]
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value).trim().toLowerCase())
  if (values.includes(wanted)) return true

  const wantedNumber = Number(wanted)
  if (Number.isFinite(wantedNumber)) {
    return values.some(value => Number(value) === wantedNumber)
  }
  return false
}

function selectedOption(select) {
  const options = Array.from(select?.options ?? [])
  return options[select?.selectedIndex] || options.find(option => String(option?.value ?? '') === String(select?.value ?? ''))
}

function dispatchSelectEvent(select, pageWindow, type) {
  dispatchEvent(select, pageWindow, type, {})
}

export function setSelectValue(select, expected, pageWindow = globalThis.window, aliases = []) {
  const options = Array.from(select?.options ?? [])
  const index = options.findIndex(option => optionMatches(option, expected, aliases))
  if (index < 0) {
    throw contractError(ERROR_CODES.SCHEDULE_CONTROLS_CHANGED, `找不到安排表选项 ${expected}`)
  }

  select.selectedIndex = index
  if (options[index]?.value !== undefined) select.value = String(options[index].value)
  dispatchSelectEvent(select, pageWindow, 'input')
  dispatchSelectEvent(select, pageWindow, 'change')

  if (!optionMatches(selectedOption(select), expected, aliases)) {
    throw contractError(ERROR_CODES.SCHEDULE_CONTROLS_CHANGED, `安排表选项未回读为 ${expected}`)
  }
  return selectedOption(select)
}

function writeFallback(composer, pageWindow, text) {
  if ('value' in composer && typeof composer.value === 'string') {
    setNativeValue(composer, text)
  } else {
    composer.textContent = text
  }
  dispatchEvent(composer, pageWindow, 'input', { data: text })
}

function setInputValue(input, value, pageWindow) {
  if (!input || !('value' in input)) {
    throw contractError(ERROR_CODES.SCHEDULE_CONTROLS_CHANGED, '找不到可写入的安排表输入框')
  }
  setNativeValue(input, value)
  dispatchEvent(input, pageWindow, 'input', { data: value })
  dispatchEvent(input, pageWindow, 'change', { data: value })
  if (String(input.value) !== String(value)) {
    throw contractError(ERROR_CODES.SCHEDULE_CONTROLS_CHANGED, '安排表输入框未回读为请求值')
  }
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

function readSchedulerDialog(document) {
  return findFirst(document, SELECTORS.schedulerDialog)
}

function schedulerRoot(document) {
  return readSchedulerDialog(document) || document
}

function allSelects(root) {
  return typeof root?.querySelectorAll === 'function'
    ? Array.from(root.querySelectorAll('select'))
    : []
}

function resolveInput(element) {
  if (!element) return null
  if ('value' in element) return element
  if (typeof element.querySelector === 'function') {
    return element.querySelector('input,textarea')
  }
  return null
}

function dateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function timeValue(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function scheduleAliases(kind, value) {
  if (kind !== 'month') return []
  return [MONTH_NAMES[Number(value) - 1] || '']
}

function controlText(element) {
  if (!element) return ''
  const values = [
    elementText(element),
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
    element.getAttribute?.('datetime'),
    element.value,
  ]
  let parent = element.parentElement
  for (let level = 0; level < 2 && parent; level += 1) {
    values.push(elementText(parent))
    parent = parent.parentElement
  }
  return values.filter(Boolean).join(' ')
}

export function matchesScheduleText(text, date) {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const minute = String(date.getMinutes()).padStart(2, '0')
  const hour24 = String(date.getHours()).padStart(2, '0')
  const hour12 = date.getHours() % 12 || 12
  const period = date.getHours() < 12 ? 'AM' : 'PM'
  const monthLong = MONTH_NAMES[month - 1]
  const monthShort = monthLong.slice(0, 3)
  const dateTokens = [
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    `${year}-${month}-${day}`,
    `${month}/${day}/${year}`,
    `${month}/${day}`,
    `${monthLong} ${day}, ${year}`,
    `${monthShort} ${day}, ${year}`,
    `${month}月${day}日`,
  ].map(token => token.toLowerCase())
  const timeTokens = [
    `${hour24}:${minute}`,
    `${hour12}:${minute} ${period}`,
    `${hour12}:${minute}${period}`,
  ].map(token => token.toLowerCase())

  const normalized = String(text ?? '').toLowerCase()
  return dateTokens.some(token => normalized.includes(token))
    && timeTokens.some(token => normalized.includes(token))
}

function readControlValues(root) {
  if (typeof root?.querySelectorAll !== 'function') return []
  return Array.from(root.querySelectorAll('input,select,textarea')).flatMap(control => [
    control.value,
    optionText(selectedOption(control)),
    control.getAttribute?.('aria-label'),
    control.getAttribute?.('title'),
  ]).filter(Boolean)
}

function scheduleDisplayMatches(document, date) {
  const composer = readComposerElement(document)
  const dialog = readSchedulerDialog(document)
  const text = [
    controlText(composer),
    controlText(dialog),
    document.body && elementText(document.body),
    ...readControlValues(dialog),
    ...readControlValues(document),
  ].filter(Boolean).join(' ')
  return matchesScheduleText(text, date)
}

function enabled(element) {
  return element && !element.disabled && element.getAttribute?.('aria-disabled') !== 'true'
}

function findScheduleConfirm(root) {
  const explicit = findFirst(root, SELECTORS.scheduleConfirm)
  if (enabled(explicit)) return explicit
  const buttons = typeof root?.querySelectorAll === 'function'
    ? Array.from(root.querySelectorAll('button,[role="button"]'))
    : []
  return buttons.find(button => enabled(button) && /schedule|安排|确认|confirm/i.test(
    `${elementText(button)} ${button.getAttribute?.('aria-label') || ''}`,
  )) || buttons.find(button => enabled(button) && button.type === 'submit') || null
}

function findEnabledSubmit(root) {
  for (const selector of SELECTORS.submit) {
    const candidates = typeof root?.querySelectorAll === 'function'
      ? Array.from(root.querySelectorAll(selector))
      : [root?.querySelector?.(selector)].filter(Boolean)
    const submit = candidates.find(enabled)
    if (submit) return submit
  }
  return null
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

    async openScheduler() {
      ensureSupported()
      if (readSchedulerDialog(document)) return

      const trigger = findFirst(document, SELECTORS.schedulerTrigger)
      if (!trigger || typeof trigger.click !== 'function') {
        throw contractError(ERROR_CODES.SCHEDULER_UNAVAILABLE, '找不到 X 原生安排表入口')
      }
      trigger.click()
      const dialog = await waitFor(() => readSchedulerDialog(document))
      if (!dialog) {
        throw contractError(ERROR_CODES.SCHEDULER_UNAVAILABLE, 'X 原生安排表没有打开')
      }
    },

    async setScheduleFields(parts) {
      const root = schedulerRoot(document)
      const dateField = resolveInput(findFirst(root, SELECTORS.scheduleDate))
      const timeField = resolveInput(findFirst(root, SELECTORS.scheduleTime))

      if (dateField || timeField) {
        if (!dateField || !timeField) {
          throw contractError(ERROR_CODES.SCHEDULE_CONTROLS_CHANGED, 'X 安排表输入控件不完整')
        }
        const targetDate = new Date(parts.year, parts.month - 1, parts.day, parts.period === 'AM' ? parts.hour12 % 12 : (parts.hour12 % 12) + 12, parts.minute)
        setInputValue(dateField, dateValue(targetDate), pageWindow)
        setInputValue(timeField, timeValue(targetDate), pageWindow)
        return
      }

      const controls = inferScheduleControls(allSelects(root))
      const required = ['year', 'month', 'day', 'hour', 'minute', 'period']
      if (required.some(kind => !controls[kind])) {
        throw contractError(ERROR_CODES.SCHEDULE_CONTROLS_CHANGED, '无法识别 X 安排表控件')
      }

      for (const kind of required) {
        const value = kind === 'hour' ? parts.hour12 : parts[kind]
        setSelectValue(controls[kind], value, pageWindow, scheduleAliases(kind, value))
      }
    },

    async confirmScheduleDialog() {
      const root = schedulerRoot(document)
      const confirm = findScheduleConfirm(root)
      if (!confirm || typeof confirm.click !== 'function') {
        throw contractError(ERROR_CODES.SCHEDULER_UNAVAILABLE, '找不到 X 安排表确认按钮')
      }
      confirm.click()
    },

    async verifyComposerSchedule(date) {
      const evidence = await waitFor(() => scheduleDisplayMatches(document, date))
      return Boolean(evidence)
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
      const inserted = typeof document.execCommand === 'function'
        && document.execCommand('insertText', false, text)
      if (inserted) return

      dispatchEvent(composer, pageWindow, 'beforeinput', { data: text })
      writeFallback(composer, pageWindow, text)
    },

    async clickFinalSubmit() {
      const submit = findEnabledSubmit(document)
      if (!submit || typeof submit.click !== 'function') {
        throw contractError(ERROR_CODES.COMPOSER_NOT_FOUND, '找不到 X 发布按钮')
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
