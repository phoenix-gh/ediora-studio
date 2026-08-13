import { findFirst, inferScheduleControls, SELECTORS } from './selectors.js'

export const SCHEDULE_MEMORY_KEY = 'x_schedule_last_selection_v3'
export const SCHEDULE_AUTO_FILL_KEY = 'x_schedule_auto_fill_enabled_v1'

const DEFAULT_INTERVAL_MS = 300
const DEFAULT_RESTORE_DELAY_MS = 200
const SCHEDULE_FIELDS = ['month', 'day', 'year', 'hour', 'minute']
const PERIODS = new Set(['AM', 'PM'])

function numericField(value, { minimum, maximum }) {
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return null
  const number = Number(text)
  if (!Number.isInteger(number) || number < minimum || number > maximum) return null
  return String(number)
}

export function normalizeScheduleSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const month = numericField(value.month, { minimum: 1, maximum: 12 })
  const day = numericField(value.day, { minimum: 1, maximum: 31 })
  const year = numericField(value.year, { minimum: 1, maximum: 9999 })
  const minute = numericField(value.minute, { minimum: 0, maximum: 59 })
  if (!month || !day || !year || !minute) return null

  const period = value.period === undefined || value.period === null || value.period === ''
    ? undefined
    : String(value.period).trim().toUpperCase()
  if (period !== undefined && !PERIODS.has(period)) return null

  const hour = numericField(value.hour, period
    ? { minimum: 1, maximum: 12 }
    : { minimum: 0, maximum: 23 })
  if (!hour) return null

  return {
    month,
    day,
    year,
    hour,
    minute,
    ...(period ? { period } : {}),
  }
}

function storageValue(storage, key = SCHEDULE_MEMORY_KEY) {
  if (!storage || typeof storage.getItem !== 'function') return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

export function readScheduleAutoFillEnabled(storage) {
  return storageValue(storage, SCHEDULE_AUTO_FILL_KEY) === 'true'
}

export function writeScheduleAutoFillEnabled(storage, enabled) {
  if (!storage || typeof storage.setItem !== 'function') return false
  const value = enabled === true
  try {
    storage.setItem(SCHEDULE_AUTO_FILL_KEY, String(value))
    return value
  } catch {
    return false
  }
}

export function readScheduleSelection(storage) {
  const raw = storageValue(storage)
  if (!raw) return null

  try {
    return normalizeScheduleSelection(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeScheduleSelection(storage, value) {
  const normalized = normalizeScheduleSelection(value)
  if (!normalized || !storage || typeof storage.setItem !== 'function') return null

  try {
    storage.setItem(SCHEDULE_MEMORY_KEY, JSON.stringify(normalized))
    return normalized
  } catch {
    return null
  }
}

export function scheduleSelectionFromDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null
  const hour24 = date.getHours()
  return normalizeScheduleSelection({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: hour24 % 12 || 12,
    minute: date.getMinutes(),
    period: hour24 < 12 ? 'AM' : 'PM',
  })
}

function dateFromScheduleSelection(selection) {
  const normalized = normalizeScheduleSelection(selection)
  if (!normalized) return null

  let hour = Number(normalized.hour)
  if (normalized.period) {
    hour %= 12
    if (normalized.period === 'PM') hour += 12
  }

  const date = new Date(
    Number(normalized.year),
    Number(normalized.month) - 1,
    Number(normalized.day),
    hour,
    Number(normalized.minute),
    0,
    0,
  )
  return Number.isFinite(date.getTime()) ? date : null
}

function legacyScheduleSelectionFromDate(date) {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1),
    day: String(date.getDate()),
    hour: String(date.getHours()),
    minute: String(date.getMinutes()),
  }
}

export function nextScheduleSelection({ previous, now = new Date(), random = Math.random } = {}) {
  const normalizedPrevious = normalizeScheduleSelection(previous)
  const previousDate = dateFromScheduleSelection(normalizedPrevious)
  const currentDate = now instanceof Date && Number.isFinite(now.getTime())
    ? new Date(now.getTime())
    : new Date()
  const date = previousDate || currentDate
  const rawRandom = Number(random?.())
  const minute = Math.min(15, Math.max(0, Math.floor(rawRandom * 16) || 0))
  date.setHours(date.getHours() + 1, minute, 0, 0)

  return previousDate && !normalizedPrevious.period
    ? legacyScheduleSelectionFromDate(date)
    : scheduleSelectionFromDate(date)
}

function selectionForControls(selection, controls) {
  const normalized = normalizeScheduleSelection(selection)
  if (!normalized) return null
  if (controls?.period) {
    if (!normalized.period) {
      const date = dateFromScheduleSelection(normalized)
      return date ? scheduleSelectionFromDate(date) : normalized
    }
    return normalized
  }
  if (!normalized.period) return normalized

  const date = dateFromScheduleSelection(normalized)
  return date ? legacyScheduleSelectionFromDate(date) : normalized
}

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

export function formatScheduleSelection(value) {
  const selection = normalizeScheduleSelection(value)
  if (!selection) return ''

  let hour = Number(selection.hour)
  if (selection.period) {
    hour %= 12
    if (selection.period === 'PM') hour += 12
  }

  return `${pad(selection.year, 4)}-${pad(selection.month)}-${pad(selection.day)} `
    + `${pad(hour)}:${pad(selection.minute)}`
}

function storageFor(pageWindow) {
  try {
    return pageWindow?.localStorage || null
  } catch {
    return null
  }
}

function dispatch(element, pageWindow, type) {
  if (typeof element?.dispatchEvent !== 'function') return
  const EventConstructor = pageWindow?.Event
  const event = typeof EventConstructor === 'function'
    ? new EventConstructor(type, { bubbles: true })
    : { type, bubbles: true }
  element.dispatchEvent(event)
}

function optionText(option) {
  return String(option?.text ?? option?.textContent ?? '').trim()
}

function optionMatches(option, expected) {
  const wanted = String(expected ?? '').trim().toLowerCase()
  const values = [option?.value, optionText(option)]
    .filter(value => value !== undefined && value !== null)
    .map(value => String(value).trim().toLowerCase())
  if (values.includes(wanted)) return true

  const wantedNumber = Number(wanted)
  return Number.isFinite(wantedNumber)
    && values.some(value => Number(value) === wantedNumber)
}

function setSelect(select, expected, pageWindow) {
  const options = Array.from(select?.options ?? [])
  const index = options.findIndex(option => optionMatches(option, expected))
  if (index < 0) return false

  select.selectedIndex = index
  if (options[index]?.value !== undefined) select.value = String(options[index].value)
  dispatch(select, pageWindow, 'input')
  dispatch(select, pageWindow, 'change')
  return optionMatches(options[select.selectedIndex] || options[index], expected)
}

function resolveInput(element) {
  if (!element) return null
  if ('value' in element) return element
  return typeof element.querySelector === 'function'
    ? element.querySelector('input,textarea')
    : null
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

function setInput(input, value, pageWindow) {
  if (!input || !('value' in input)) return false
  setNativeValue(input, String(value))
  dispatch(input, pageWindow, 'input')
  dispatch(input, pageWindow, 'change')
  return String(input.value) === String(value)
}

function readControl(control) {
  if (!control) return ''
  if (control.value !== undefined && String(control.value) !== '') return String(control.value)
  const options = Array.from(control.options ?? [])
  return optionText(options[control.selectedIndex])
}

function dialogHasScheduleControls(dialog) {
  if (!dialog) return false
  const selects = typeof dialog.querySelectorAll === 'function'
    ? Array.from(dialog.querySelectorAll('select'))
    : []
  if (selects.length >= 5) return true
  return Boolean(
    findFirst(dialog, SELECTORS.scheduleDate)
    || findFirst(dialog, SELECTORS.scheduleTime),
  )
}

function getScheduleDialog(document) {
  if (!document) return null
  const dialogs = typeof document.querySelectorAll === 'function'
    ? Array.from(document.querySelectorAll('[role="dialog"]'))
    : []
  return dialogs.find(dialogHasScheduleControls) || null
}

function readDateTimeSelection(dialog) {
  const dateInput = resolveInput(findFirst(dialog, SELECTORS.scheduleDate))
  const timeInput = resolveInput(findFirst(dialog, SELECTORS.scheduleTime))
  if (!dateInput && !timeInput) return null
  if (!dateInput || !timeInput) return null

  const dateMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateInput.value ?? ''))
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(String(timeInput.value ?? ''))
  if (!dateMatch || !timeMatch) return null

  return normalizeScheduleSelection({
    year: dateMatch[1],
    month: dateMatch[2],
    day: dateMatch[3],
    hour: timeMatch[1],
    minute: timeMatch[2],
  })
}

function readSelectSelection(dialog) {
  const selects = typeof dialog?.querySelectorAll === 'function'
    ? Array.from(dialog.querySelectorAll('select'))
    : []
  if (selects.length < 5) return null

  const controls = inferScheduleControls(selects)
  const selection = {
    month: readControl(controls.month),
    day: readControl(controls.day),
    year: readControl(controls.year),
    hour: readControl(controls.hour),
    minute: readControl(controls.minute),
  }
  const period = readControl(controls.period)
  if (period) selection.period = period
  return normalizeScheduleSelection(selection)
}

function readDialogSelection(dialog) {
  return readDateTimeSelection(dialog) || readSelectSelection(dialog)
}

function wait(ms, pageWindow) {
  const timeout = pageWindow?.setTimeout || globalThis.setTimeout
  return new Promise(resolve => timeout(resolve, ms))
}

function isScheduleConfirmTarget(target) {
  if (!target) return false
  return SELECTORS.scheduleConfirm.some(selector => {
    try {
      return Boolean(target.matches?.(selector) || target.closest?.(selector))
    } catch {
      return false
    }
  })
}

export function createScheduleMemory({
  document,
  window: pageWindow = globalThis.window,
  onChange = () => {},
  intervalMs = DEFAULT_INTERVAL_MS,
  restoreDelayMs = DEFAULT_RESTORE_DELAY_MS,
  now: nowValue = () => new Date(),
  random = Math.random,
} = {}) {
  const storage = storageFor(pageWindow)
  let timer = null
  let wasOpen = false
  let restoring = false
  let lastState = JSON.stringify(readScheduleSelection(storage))

  const read = () => readDialogSelection(getScheduleDialog(document))
  const readStored = () => readScheduleSelection(storage)

  function save(selection = read()) {
    const normalized = normalizeScheduleSelection(selection)
    if (!normalized) return null
    const serialized = JSON.stringify(normalized)
    if (serialized === lastState) return normalized

    const saved = writeScheduleSelection(storage, normalized)
    if (!saved) return null
    lastState = JSON.stringify(saved)
    onChange(saved)
    return saved
  }

  function saveCurrent() {
    return save(read())
  }

  async function applySelection(selection) {
    if (!selection) return null

    const dialog = getScheduleDialog(document)
    if (!dialog) return selection

    restoring = true
    try {
      const dateInput = resolveInput(findFirst(dialog, SELECTORS.scheduleDate))
      const timeInput = resolveInput(findFirst(dialog, SELECTORS.scheduleTime))
      if (dateInput || timeInput) {
        if (dateInput && timeInput) {
          const date = dateFromScheduleSelection(selection)
          if (date) {
            setInput(
              dateInput,
              `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
              pageWindow,
            )
            setInput(
              timeInput,
              `${pad(date.getHours())}:${pad(date.getMinutes())}`,
              pageWindow,
            )
          }
        }
      } else {
        const selects = Array.from(dialog.querySelectorAll?.('select') ?? [])
        const controls = inferScheduleControls(selects)
        const formatted = selectionForControls(selection, controls)
        const fields = [
          ['year', formatted?.year],
          ['month', formatted?.month],
          ['day', formatted?.day],
          ['hour', formatted?.hour],
          ['minute', formatted?.minute],
          ...(formatted?.period && controls.period ? [['period', formatted.period]] : []),
        ]
        for (const [kind, value] of fields) {
          if (!setSelect(controls[kind], value, pageWindow)) break
          await wait(restoreDelayMs, pageWindow)
        }
      }
      return selection
    } finally {
      restoring = false
    }
  }

  async function restore() {
    return applySelection(readStored())
  }

  async function fillNext() {
    const current = typeof nowValue === 'function' ? nowValue() : nowValue
    return applySelection(nextScheduleSelection({
      previous: readStored(),
      now: current,
      random,
    }))
  }

  async function poll() {
    const isOpen = Boolean(getScheduleDialog(document))
    if (isOpen && !wasOpen) {
      wasOpen = true
      await wait(restoreDelayMs, pageWindow)
      if (readScheduleAutoFillEnabled(storage)) await fillNext()
      else await restore()
    }

    if (!isOpen) wasOpen = false
  }

  function handleClick(event) {
    if (isScheduleConfirmTarget(event?.target)) saveCurrent()
  }

  function start() {
    if (timer !== null) return
    document?.addEventListener?.('click', handleClick, true)
    const setTimer = pageWindow?.setInterval || globalThis.setInterval
    timer = setTimer(() => poll(), intervalMs)
  }

  function stop() {
    document?.removeEventListener?.('click', handleClick, true)
    if (timer !== null) {
      const clearTimer = pageWindow?.clearInterval || globalThis.clearInterval
      clearTimer(timer)
      timer = null
    }
    wasOpen = false
  }

  return {
    read,
    readStored,
    readAutoFillEnabled: () => readScheduleAutoFillEnabled(storage),
    setAutoFillEnabled: enabled => {
      writeScheduleAutoFillEnabled(storage, enabled)
      return readScheduleAutoFillEnabled(storage)
    },
    save,
    saveCurrent,
    restore,
    fillNext,
    start,
    stop,
  }
}
