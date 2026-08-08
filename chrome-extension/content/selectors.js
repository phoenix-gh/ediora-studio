export const SELECTORS = Object.freeze({
  composeTrigger: [
    '[data-testid="SideNav_NewTweet_Button"]',
    'a[href="/compose/post"]',
    'a[href="/compose/tweet"]',
  ],
  composer: [
    '[data-testid="tweetTextarea_0"]',
  ],
  submit: [
    '[data-testid="tweetButton"]',
    '[data-testid="tweetButtonInline"]',
  ],
  schedulerTrigger: [
    '[data-testid="scheduleOption"]',
    '[data-testid="scheduledButton"]',
    '[aria-label="Schedule post"]',
    '[aria-label="Schedule"]',
    '[aria-label="安排帖子"]',
  ],
  schedulerDialog: [
    '[role="dialog"]',
  ],
  scheduleDate: [
    '[data-testid="scheduledDateField"]',
    '[data-testid="scheduleDateInput"]',
  ],
  scheduleTime: [
    '[data-testid="scheduledTimeField"]',
    '[data-testid="scheduleTimeInput"]',
  ],
  scheduleConfirm: [
    '[data-testid="scheduledConfirmationPrimaryAction"]',
    '[data-testid="scheduleConfirm"]',
  ],
  success: [
    '[role="alert"]',
    '[data-testid="toast"]',
  ],
})

export function findFirst(root, selectors) {
  if (!root || typeof root.querySelector !== 'function') return null
  for (const selector of selectors) {
    const element = root.querySelector(selector)
    if (element) return element
  }
  return null
}

function optionRecords(select) {
  return Array.from(select?.options ?? []).map(option => ({
    value: String(option?.value ?? '').trim(),
    text: String(option?.text ?? option?.textContent ?? '').trim(),
  }))
}

function optionNumbers(select) {
  return optionRecords(select)
    .map(option => Number(option.value || option.text))
    .filter(Number.isFinite)
}

function metadata(select) {
  return [
    select?.name,
    select?.id,
    select?.ariaLabel,
    select?.getAttribute?.('name'),
    select?.getAttribute?.('id'),
    select?.getAttribute?.('aria-label'),
    select?.getAttribute?.('data-testid'),
  ].filter(Boolean).join(' ').toLowerCase()
}

function hasLabel(select, pattern) {
  return pattern.test(metadata(select))
}

function hasExactOption(select, pattern) {
  return optionRecords(select).some(option => pattern.test(option.value) || pattern.test(option.text))
}

function coversNumericRange(select, minimum, maximum) {
  const numbers = new Set(optionNumbers(select))
  return numbers.has(minimum) && numbers.has(maximum)
}

function isYearSelect(select) {
  return hasLabel(select, /year|年份/) || optionRecords(select).some(option => /^\d{4}$/.test(option.value || option.text))
}

function isPeriodSelect(select) {
  return hasLabel(select, /period|ampm|am.?pm|上午|下午/)
    || hasExactOption(select, /^(?:a\.?m\.?|p\.?m\.?)$/i)
}

function isMinuteSelect(select) {
  return hasLabel(select, /minute|min|分钟/)
    || optionRecords(select).length >= 60
    || coversNumericRange(select, 0, 59)
}

function isDaySelect(select) {
  return hasLabel(select, /day|日期|日/) || coversNumericRange(select, 1, 31)
}

function isMonthSelect(select) {
  return hasLabel(select, /month|月份|月/)
    || optionRecords(select).length === 12
    || coversNumericRange(select, 1, 12)
}

function isHourSelect(select) {
  return hasLabel(select, /hour|小时|时/) || coversNumericRange(select, 1, 12)
}

export function inferScheduleControls(selects) {
  const candidates = Array.from(selects ?? []).filter(Boolean)
  const result = {}
  const used = new Set()

  const pick = (kind, predicate, { preferLabel = false } = {}) => {
    const available = candidates.filter(candidate => !used.has(candidate) && predicate(candidate))
    const preferred = preferLabel
      ? available.find(candidate => hasLabel(candidate, new RegExp(kind, 'i')))
      : null
    const selected = preferred || available[0]
    if (selected) {
      result[kind] = selected
      used.add(selected)
    }
  }

  pick('year', isYearSelect, { preferLabel: true })
  pick('period', isPeriodSelect, { preferLabel: true })
  pick('minute', isMinuteSelect, { preferLabel: true })
  pick('day', isDaySelect, { preferLabel: true })

  const monthOrHour = candidates.filter(candidate => !used.has(candidate)
    && (isMonthSelect(candidate) || isHourSelect(candidate)))
  const labelledMonth = monthOrHour.find(candidate => hasLabel(candidate, /month|月份|月/))
  const labelledHour = monthOrHour.find(candidate => hasLabel(candidate, /hour|小时|时/))
  if (labelledMonth) {
    result.month = labelledMonth
    used.add(labelledMonth)
  }
  if (labelledHour && !used.has(labelledHour)) {
    result.hour = labelledHour
    used.add(labelledHour)
  }

  for (const candidate of monthOrHour) {
    if (used.has(candidate)) continue
    if (!result.month && isMonthSelect(candidate)) {
      result.month = candidate
      used.add(candidate)
      continue
    }
    if (!result.hour && isHourSelect(candidate)) {
      result.hour = candidate
      used.add(candidate)
    }
  }

  if (candidates.length >= 6) {
    // XActions' current X dialog order is month, day, year, hour, minute, AM/PM.
    const fallbackOrder = ['month', 'day', 'year', 'hour', 'minute', 'period']
    for (let index = 0; index < fallbackOrder.length; index += 1) {
      const kind = fallbackOrder[index]
      if (!result[kind]) result[kind] = candidates[index]
    }
  }

  return result
}
