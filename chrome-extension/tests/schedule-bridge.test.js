import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SCHEDULE_MESSAGE_TYPES,
  createScheduleClient,
  emptyScheduleSnapshot,
  handleScheduleHostMessage,
  resolveActiveXTab,
  routeScheduleRequest,
} from '../content/schedule-bridge.js'

test('host returns stored schedule and writes autofill', () => {
  const memory = {
    selection: { year: '2026', month: '8', day: '13', hour: '10', minute: '05' },
    autoFillEnabled: false,
    readStored() { return this.selection },
    readAutoFillEnabled() { return this.autoFillEnabled },
    setAutoFillEnabled(enabled) { this.autoFillEnabled = enabled === true },
  }

  assert.deepEqual(
    handleScheduleHostMessage({ type: SCHEDULE_MESSAGE_TYPES.GET }, memory),
    {
      type: SCHEDULE_MESSAGE_TYPES.RESULT,
      ok: true,
      selection: memory.selection,
      autoFillEnabled: false,
      available: true,
    },
  )
  assert.deepEqual(
    handleScheduleHostMessage({ type: SCHEDULE_MESSAGE_TYPES.SET_AUTOFILL, enabled: true }, memory),
    {
      type: SCHEDULE_MESSAGE_TYPES.RESULT,
      ok: true,
      selection: memory.selection,
      autoFillEnabled: true,
      available: true,
    },
  )
  assert.equal(handleScheduleHostMessage({ type: 'OTHER' }, memory), null)
  assert.equal(
    handleScheduleHostMessage({ type: SCHEDULE_MESSAGE_TYPES.GET, requestId: 'host-1' }, memory).requestId,
    'host-1',
  )
})

test('router returns an empty snapshot when no active X tab exists', async () => {
  const result = await routeScheduleRequest(
    { type: SCHEDULE_MESSAGE_TYPES.GET, requestId: 'r1' },
    {
      queryTabs: async () => [{ id: 4, url: 'https://example.com/' }],
      sendToTab: async () => { throw new Error('should not send') },
      isXSiteUrl: url => url.includes('x.com'),
    },
  )
  assert.deepEqual(result, {
    type: SCHEDULE_MESSAGE_TYPES.RESULT,
    requestId: 'r1',
    ok: true,
    ...emptyScheduleSnapshot(),
  })
})

test('router returns an empty snapshot when sendToTab rejects', async () => {
  const result = await routeScheduleRequest(
    { type: SCHEDULE_MESSAGE_TYPES.GET, requestId: 'r-reject' },
    {
      queryTabs: async () => [{ id: 9, url: 'https://x.com/home' }],
      sendToTab: async () => { throw new Error('no receiving end') },
      isXSiteUrl: url => url.includes('x.com'),
    },
  )
  assert.deepEqual(result, {
    type: SCHEDULE_MESSAGE_TYPES.RESULT,
    requestId: 'r-reject',
    ok: true,
    ...emptyScheduleSnapshot(),
  })
})

test('router forwards GET to the active X tab', async () => {
  const sent = []
  const result = await routeScheduleRequest(
    { type: SCHEDULE_MESSAGE_TYPES.GET, requestId: 'r2' },
    {
      queryTabs: async query => {
        assert.deepEqual(query, { active: true, currentWindow: true })
        return [{ id: 9, url: 'https://x.com/home' }]
      },
      sendToTab: async (tabId, message) => {
        sent.push({ tabId, message })
        return {
          type: SCHEDULE_MESSAGE_TYPES.RESULT,
          ok: true,
          selection: { year: '2026', month: '8', day: '13', hour: '11', minute: '00' },
          autoFillEnabled: true,
          available: true,
        }
      },
      isXSiteUrl: url => url.includes('x.com'),
    },
  )
  assert.equal(sent[0].tabId, 9)
  assert.equal(result.available, true)
  assert.equal(result.autoFillEnabled, true)
})

test('resolveActiveXTab returns only the active X tab', async () => {
  assert.equal(
    await resolveActiveXTab(
      async () => [{ id: 1, url: 'https://example.com/' }],
      url => url.includes('x.com'),
    ),
    null,
  )
  assert.deepEqual(
    await resolveActiveXTab(
      async () => [{ id: 9, url: 'https://x.com/home' }],
      url => url.includes('x.com'),
    ),
    { id: 9, url: 'https://x.com/home' },
  )
})

test('client reads and writes through the runtime channel', async () => {
  const calls = []
  const runtime = {
    sendMessage(message) {
      calls.push(message)
      return Promise.resolve({
        type: SCHEDULE_MESSAGE_TYPES.RESULT,
        requestId: message.requestId,
        ok: true,
        selection: null,
        autoFillEnabled: message.enabled === true,
        available: false,
      })
    },
    onMessage: { addListener() {}, removeListener() {} },
  }
  const client = createScheduleClient({ runtime, randomUUID: () => 'fixed' })
  assert.deepEqual(await client.getSnapshot(), {
    selection: null,
    autoFillEnabled: false,
    available: false,
  })
  assert.equal((await client.setAutoFillEnabled(true)).autoFillEnabled, true)
  assert.equal(calls[0].type, SCHEDULE_MESSAGE_TYPES.GET)
  assert.equal(calls[1].type, SCHEDULE_MESSAGE_TYPES.SET_AUTOFILL)
})
