import assert from 'node:assert/strict'
import test from 'node:test'

import { installConsoleApi } from '../injected/console-api.js'

function createFakeWindow() {
  const listeners = new Set()
  return {
    sent: [],
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener)
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener)
    },
    postMessage(data) {
      this.sent.push(data)
    },
    emitMessage(data) {
      for (const listener of listeners) listener({ source: this, data })
    },
  }
}

test('publish posts a correlated request and resolves only its matching response', async () => {
  const fakeWindow = createFakeWindow()
  installConsoleApi(fakeWindow, { randomUUID: () => 'request-1', timeoutMs: 100 })

  const promise = fakeWindow.Shuce.publish({ text: 'hello' })
  assert.deepEqual(fakeWindow.sent[0], {
    source: 'shuce-console',
    type: 'SHUCE_PUBLISH_REQUEST',
    requestId: 'request-1',
    payload: { text: 'hello' },
  })

  fakeWindow.emitMessage({
    source: 'shuce-bridge',
    type: 'SHUCE_PUBLISH_RESULT',
    requestId: 'other',
    result: { ok: true },
  })
  fakeWindow.emitMessage({
    source: 'shuce-bridge',
    type: 'SHUCE_PUBLISH_RESULT',
    requestId: 'request-1',
    result: { ok: true, action: 'published' },
  })

  assert.deepEqual(await promise, { ok: true, action: 'published' })
})

test('publish rejects with a stable timeout error', async () => {
  const fakeWindow = createFakeWindow()
  installConsoleApi(fakeWindow, { randomUUID: () => 'request-2', timeoutMs: 5 })

  await assert.rejects(fakeWindow.Shuce.publish({ text: 'hello' }), error => {
    assert.equal(error.code, 'BRIDGE_TIMEOUT')
    return true
  })
})

test('install does not replace an existing Shuce API', () => {
  const fakeWindow = createFakeWindow()
  const existing = Object.freeze({ existing: true })
  fakeWindow.Shuce = existing

  installConsoleApi(fakeWindow, { randomUUID: () => 'request-3', timeoutMs: 5 })

  assert.equal(fakeWindow.Shuce, existing)
})
