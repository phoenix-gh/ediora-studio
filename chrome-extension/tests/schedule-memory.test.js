import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SCHEDULE_MEMORY_KEY,
  createScheduleMemory,
  formatScheduleSelection,
  normalizeScheduleSelection,
  readScheduleSelection,
  scheduleSelectionFromDate,
} from '../content/schedule-memory.js'

function createStorage(value = null) {
  let stored = value
  return {
    getItem() {
      return stored
    },
    setItem(_key, next) {
      stored = next
    },
    read() {
      return stored
    },
  }
}

function createSelect(name, options, initial) {
  let current = String(initial ?? options[0]?.value ?? '')
  const events = []
  return {
    name,
    options: options.map(value => ({ value: String(value), text: String(value) })),
    get value() {
      return current
    },
    set value(value) {
      current = String(value)
    },
    get selectedIndex() {
      return this.options.findIndex(option => option.value === current)
    },
    set selectedIndex(index) {
      current = String(this.options[index]?.value ?? '')
    },
    events,
    dispatchEvent(event) {
      events.push(event.type)
    },
    getAttribute(attribute) {
      return attribute === 'name' ? name : null
    },
  }
}

function createScheduleDocument(selects) {
  const dialog = {
    querySelector() {
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'select') return selects
      if (selector === 'input,select,textarea') return selects
      return []
    },
  }
  const clickListeners = new Set()
  return {
    querySelectorAll(selector) {
      return selector === '[role="dialog"]' ? [dialog] : []
    },
    addEventListener(type, listener) {
      if (type === 'click') clickListeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'click') clickListeners.delete(listener)
    },
    dispatchClick(target) {
      for (const listener of clickListeners) {
        listener({ type: 'click', target })
      }
    },
  }
}

function createWindow(storage) {
  const timers = new Map()
  let nextTimerId = 0
  return {
    localStorage: storage,
    setInterval(callback, intervalMs) {
      const id = ++nextTimerId
      timers.set(id, { callback, intervalMs })
      return id
    },
    clearInterval(id) {
      timers.delete(id)
    },
    async runIntervals() {
      for (const { callback } of timers.values()) await callback()
    },
    activeTimers() {
      return [...timers.values()]
    },
  }
}

test('reads and formats the legacy five-field selection', () => {
  const storage = createStorage(JSON.stringify({
    month: '8', day: '8', year: '2026', hour: '8', minute: '30',
  }))

  const selection = readScheduleSelection(storage)

  assert.deepEqual(selection, {
    month: '8', day: '8', year: '2026', hour: '8', minute: '30',
  })
  assert.equal(formatScheduleSelection(selection), '2026-08-08 08:30')
})

test('normalizes and formats an AM/PM selection as local 24-hour display time', () => {
  const selection = normalizeScheduleSelection({
    month: 8, day: 8, year: 2026, hour: 8, minute: 30, period: 'PM',
  })

  assert.deepEqual(selection, {
    month: '8', day: '8', year: '2026', hour: '8', minute: '30', period: 'PM',
  })
  assert.equal(formatScheduleSelection(selection), '2026-08-08 20:30')
})

test('converts a local date into the stored X twelve-hour selection', () => {
  assert.deepEqual(scheduleSelectionFromDate(new Date(2026, 7, 8, 20, 30)), {
    year: '2026', month: '8', day: '8', hour: '8', minute: '30', period: 'PM',
  })
})

test('treats malformed JSON and storage failures as no saved selection', () => {
  assert.equal(readScheduleSelection(createStorage('{')), null)
  assert.equal(readScheduleSelection({ getItem() { throw new Error('blocked') } }), null)
})

test('restores schedule controls without persisting intermediate values', async () => {
  const storage = createStorage(JSON.stringify({
    month: '8', day: '8', year: '2026', hour: '8', minute: '30', period: 'PM',
  }))
  const selects = [
    createSelect('month', [1, 8], 1),
    createSelect('day', [1, 8], 1),
    createSelect('year', [2026, 2027], 2027),
    createSelect('hour', [8, 9], 9),
    createSelect('minute', [30, 45], 45),
    createSelect('period', ['AM', 'PM'], 'AM'),
  ]
  const memory = createScheduleMemory({
    document: createScheduleDocument(selects),
    window: createWindow(storage),
    restoreDelayMs: 0,
  })

  await memory.restore()

  assert.deepEqual(selects.map(select => select.value), ['8', '8', '2026', '8', '30', 'PM'])
  assert.deepEqual(selects.map(select => select.events), [
    ['input', 'change'],
    ['input', 'change'],
    ['input', 'change'],
    ['input', 'change'],
    ['input', 'change'],
    ['input', 'change'],
  ])
  assert.equal(storage.read(), JSON.stringify({
    month: '8', day: '8', year: '2026', hour: '8', minute: '30', period: 'PM',
  }))
})

test('restores direct date and time controls through their native setters', async () => {
  class FakeInput {
    constructor() {
      this._value = ''
      this.nativeWrites = 0
      this.events = []
    }

    get value() {
      return this._value
    }

    set value(value) {
      this._value = String(value)
      this.nativeWrites += 1
    }

    dispatchEvent(event) {
      this.events.push(event.type)
    }
  }

  const dateInput = new FakeInput()
  const timeInput = new FakeInput()
  for (const input of [dateInput, timeInput]) {
    Object.defineProperty(input, 'value', {
      configurable: true,
      get() {
        return this._value
      },
      set() {
        throw new Error('controlled input must use the prototype setter')
      },
    })
  }
  const dialog = {
    querySelector(selector) {
      if (selector === '[data-testid="scheduledDateField"]') return dateInput
      if (selector === '[data-testid="scheduledTimeField"]') return timeInput
      return null
    },
    querySelectorAll() {
      return []
    },
  }
  const storage = createStorage(JSON.stringify({
    month: '8', day: '8', year: '2026', hour: '8', minute: '30', period: 'PM',
  }))
  const memory = createScheduleMemory({
    document: {
      querySelectorAll(selector) {
        return selector === '[role="dialog"]' ? [dialog] : []
      },
    },
    window: createWindow(storage),
    restoreDelayMs: 0,
  })

  await memory.restore()

  assert.equal(dateInput.value, '2026-08-08')
  assert.equal(timeInput.value, '20:30')
  assert.equal(dateInput.nativeWrites, 1)
  assert.equal(timeInput.nativeWrites, 1)
  assert.deepEqual(dateInput.events, ['input', 'change'])
  assert.deepEqual(timeInput.events, ['input', 'change'])
})

test('saves current schedule controls and notifies the workbench', () => {
  const storage = createStorage()
  const selects = [
    createSelect('month', [1, 8], 8),
    createSelect('day', [1, 8], 8),
    createSelect('year', [2026, 2027], 2026),
    createSelect('hour', [8, 9], 8),
    createSelect('minute', [30, 45], 30),
    createSelect('period', ['AM', 'PM'], 'PM'),
  ]
  const changes = []
  const memory = createScheduleMemory({
    document: createScheduleDocument(selects),
    window: createWindow(storage),
    onChange: selection => changes.push(selection),
  })

  const saved = memory.saveCurrent()

  assert.deepEqual(saved, {
    month: '8', day: '8', year: '2026', hour: '8', minute: '30', period: 'PM',
  })
  assert.equal(storage.getItem(SCHEDULE_MEMORY_KEY), JSON.stringify(saved))
  assert.deepEqual(changes, [saved])
})

test('saves the current selection only when the schedule confirmation is clicked', async () => {
  const storage = createStorage()
  const selects = [
    createSelect('month', [1, 8], 8),
    createSelect('day', [1, 8], 8),
    createSelect('year', [2026, 2027], 2026),
    createSelect('hour', [8, 9], 8),
    createSelect('minute', [30, 45], 30),
    createSelect('period', ['AM', 'PM'], 'PM'),
  ]
  const document = createScheduleDocument(selects)
  const window = createWindow(storage)
  const memory = createScheduleMemory({
    document,
    window,
    restoreDelayMs: 0,
  })
  const confirmButton = {
    matches(selector) {
      return selector === '[data-testid="scheduledConfirmationPrimaryAction"]'
    },
    closest(selector) {
      return this.matches(selector) ? this : null
    },
  }

  memory.start()
  await window.runIntervals()
  assert.equal(storage.read(), null)

  document.dispatchClick(confirmButton)

  assert.deepEqual(JSON.parse(storage.read()), {
    month: '8',
    day: '8',
    year: '2026',
    hour: '8',
    minute: '30',
    period: 'PM',
  })
  memory.stop()
})

test('starts idempotently and stops its polling timer', () => {
  const storage = createStorage()
  const window = createWindow(storage)
  const memory = createScheduleMemory({
    document: createScheduleDocument([]),
    window,
  })

  memory.start()
  memory.start()
  assert.equal(window.activeTimers().length, 1)
  assert.equal(window.activeTimers()[0].intervalMs, 300)

  memory.stop()

  assert.equal(window.activeTimers().length, 0)
})
