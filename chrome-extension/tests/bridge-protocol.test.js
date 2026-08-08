import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createResultMessage,
  isPublishRequestMessage,
} from '../content/bridge-protocol.js'

test('accepts only page-origin publish request messages', () => {
  assert.equal(isPublishRequestMessage({
    source: 'shuce-console',
    type: 'SHUCE_PUBLISH_REQUEST',
    requestId: 'request-1',
    payload: { text: 'hello' },
  }), true)
  assert.equal(isPublishRequestMessage({
    source: 'shuce-console',
    type: 'SHUCE_PUBLISH_REQUEST',
    requestId: '',
    payload: { text: 'hello' },
  }), false)
  assert.equal(isPublishRequestMessage({
    source: 'other-script',
    type: 'SHUCE_PUBLISH_REQUEST',
    requestId: 'request-1',
    payload: { text: 'hello' },
  }), false)
})

test('creates correlated success and failure result messages', () => {
  assert.deepEqual(createResultMessage('request-1', { ok: true, action: 'published' }), {
    source: 'shuce-bridge',
    type: 'SHUCE_PUBLISH_RESULT',
    requestId: 'request-1',
    result: { ok: true, action: 'published' },
  })
  assert.deepEqual(createResultMessage('request-2', null, { code: 'INTERNAL_ERROR' }), {
    source: 'shuce-bridge',
    type: 'SHUCE_PUBLISH_RESULT',
    requestId: 'request-2',
    error: { code: 'INTERNAL_ERROR' },
  })
})
