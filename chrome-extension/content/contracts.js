export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  EMPTY_TEXT: 'EMPTY_TEXT',
  INVALID_SCHEDULE_TIME: 'INVALID_SCHEDULE_TIME',
  SCHEDULE_TIME_IN_PAST: 'SCHEDULE_TIME_IN_PAST',
  BUSY: 'BUSY',
  UNSUPPORTED_PAGE: 'UNSUPPORTED_PAGE',
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  COMPOSER_NOT_FOUND: 'COMPOSER_NOT_FOUND',
  EXISTING_DRAFT: 'EXISTING_DRAFT',
  TEXT_MISMATCH: 'TEXT_MISMATCH',
  SCHEDULER_UNAVAILABLE: 'SCHEDULER_UNAVAILABLE',
  SCHEDULE_CONTROLS_CHANGED: 'SCHEDULE_CONTROLS_CHANGED',
  SUBMIT_NOT_CONFIRMED: 'SUBMIT_NOT_CONFIRMED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
})

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/

export function contractError(code, message, details) {
  const error = new Error(message)
  error.name = 'ShuceContractError'
  error.code = code
  if (details !== undefined) error.details = details
  return error
}

export function parseLocalSchedule(value, now = new Date()) {
  const match = LOCAL_DATETIME.exec(String(value ?? ''))
  if (!match) {
    throw contractError(ERROR_CODES.INVALID_SCHEDULE_TIME, '定时时间格式必须为 YYYY-MM-DD HH:mm')
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const date = new Date(year, month - 1, day, hour, minute, 0, 0)
  const roundTrips = date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day
    && date.getHours() === hour
    && date.getMinutes() === minute

  if (!roundTrips) {
    throw contractError(ERROR_CODES.INVALID_SCHEDULE_TIME, '定时时间不存在')
  }
  if (date.getTime() <= now.getTime()) {
    throw contractError(ERROR_CODES.SCHEDULE_TIME_IN_PAST, '定时时间必须晚于当前时间')
  }
  return date
}

export function scheduleParts(date) {
  const hour24 = date.getHours()
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour12: hour24 % 12 || 12,
    minute: date.getMinutes(),
    period: hour24 < 12 ? 'AM' : 'PM',
  }
}

function pad(value) {
  return String(value).padStart(2, '0')
}

export function formatLocalIso(date) {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offsetMinutes)
  const hours = Math.floor(absoluteOffset / 60)
  const minutes = absoluteOffset % 60

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(hours)}:${pad(minutes)}`
}

export function validatePublishRequest(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw contractError(ERROR_CODES.INVALID_REQUEST, '发布命令必须是对象')
  }
  if (typeof raw.text !== 'string' || !raw.text.trim()) {
    throw contractError(ERROR_CODES.EMPTY_TEXT, '帖子内容不能为空')
  }
  if (raw.dryRun !== undefined && typeof raw.dryRun !== 'boolean') {
    throw contractError(ERROR_CODES.INVALID_REQUEST, 'dryRun 必须是布尔值')
  }

  const hasSchedule = raw.scheduledAt !== undefined && raw.scheduledAt !== null
  return {
    text: raw.text.trim(),
    dryRun: raw.dryRun === true,
    scheduledAt: hasSchedule ? parseLocalSchedule(raw.scheduledAt, now) : null,
  }
}

export function successResult(action, scheduledAt) {
  return {
    ok: true,
    action,
    ...(scheduledAt ? { scheduledAt: formatLocalIso(scheduledAt) } : {}),
  }
}

export function failureResult(code, message, details) {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  }
}
