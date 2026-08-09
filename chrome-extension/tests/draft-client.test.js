import assert from 'node:assert/strict'
import test from 'node:test'

import { createDraftClient } from '../content/draft-client.js'

function fakeRuntime(responses) {
  const calls = []
  return {
    calls,
    sendMessage(message) {
      calls.push(message)
      return Promise.resolve(responses[message.type])
    },
  }
}

test('sends a correlated request and returns drafts', async () => {
  const runtime = fakeRuntime({
    SHUCE_DRAFTS_REQUEST: {
      requestId: 'request-1',
      ok: true,
      drafts: [{ id: 1 }],
    },
  })
  const client = createDraftClient({ runtime, randomUUID: () => 'request-1' })

  assert.deepEqual(
    await client.fetchDrafts('http://localhost:8000/api'),
    [{ id: 1 }],
  )
  assert.deepEqual(runtime.calls[0], {
    type: 'SHUCE_DRAFTS_REQUEST',
    requestId: 'request-1',
    apiBase: 'http://localhost:8000/api',
  })
})

test('maps service-worker errors and timeouts', async () => {
  const runtime = fakeRuntime({
    SHUCE_DRAFTS_REQUEST: {
      requestId: 'request-2',
      ok: false,
      error: { code: 'DRAFT_API_UNAVAILABLE', message: 'API 暂不可用' },
    },
  })
  const client = createDraftClient({ runtime, randomUUID: () => 'request-2' })

  await assert.rejects(
    client.fetchDrafts('http://localhost:8000/api'),
    { code: 'DRAFT_API_UNAVAILABLE' },
  )

  const hanging = createDraftClient({
    runtime: { sendMessage() { return new Promise(() => {}) } },
    randomUUID: () => 'request-3',
    timeoutMs: 5,
  })
  await assert.rejects(
    hanging.fetchDrafts('http://localhost:8000/api'),
    { code: 'DRAFT_API_UNAVAILABLE' },
  )
})

test('reads, saves, and resets API configuration', async () => {
  const runtime = fakeRuntime({
    SHUCE_DRAFTS_CONFIG_GET: {
      requestId: 'request-4',
      ok: true,
      apiBase: 'http://localhost:8000/api',
    },
    SHUCE_DRAFTS_CONFIG_SET: {
      requestId: 'request-5',
      ok: true,
      apiBase: 'http://127.0.0.1:8000/api',
    },
    SHUCE_DRAFTS_CONFIG_RESET: {
      requestId: 'request-6',
      ok: true,
      apiBase: 'http://localhost:8000/api',
    },
  })
  let id = 4
  const client = createDraftClient({
    runtime,
    randomUUID: () => 'request-' + id++,
  })

  assert.equal((await client.getConfig()).apiBase, 'http://localhost:8000/api')
  assert.equal(
    (await client.saveConfig('http://127.0.0.1:8000/api')).apiBase,
    'http://127.0.0.1:8000/api',
  )
  assert.equal((await client.resetConfig()).apiBase, 'http://localhost:8000/api')
})

test('publishes a draft through the service worker message channel', async () => {
  const runtime = fakeRuntime({
    SHUCE_DRAFT_PUBLISH: {
      requestId: 'request-7',
      ok: true,
      draft: { id: 7, status: 'published' },
    },
  })
  const client = createDraftClient({ runtime, randomUUID: () => 'request-7' })

  assert.deepEqual(
    await client.publishDraft('http://localhost:8000/api', 7),
    { draft: { id: 7, status: 'published' } },
  )
  assert.deepEqual(runtime.calls[0], {
    type: 'SHUCE_DRAFT_PUBLISH',
    requestId: 'request-7',
    apiBase: 'http://localhost:8000/api',
    draftId: 7,
  })
})

test('maps service-worker publish errors', async () => {
  const runtime = fakeRuntime({
    SHUCE_DRAFT_PUBLISH: {
      requestId: 'request-8',
      ok: false,
      error: { code: 'DRAFT_API_UNAVAILABLE', message: 'API 暂不可用' },
    },
  })
  const client = createDraftClient({ runtime, randomUUID: () => 'request-8' })

  await assert.rejects(
    client.publishDraft('http://localhost:8000/api', 8),
    { code: 'DRAFT_API_UNAVAILABLE' },
  )
})
