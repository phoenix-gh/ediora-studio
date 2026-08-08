import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_API_BASE,
  assertAllowedApiBase,
  fetchDraftCollection,
  normalizeApiBase,
} from '../background/draft-api.js'

test('normalizes and restricts local API bases', () => {
  assert.equal(normalizeApiBase('http://localhost:8000/api/'), DEFAULT_API_BASE)
  assert.equal(
    assertAllowedApiBase('http://127.0.0.1:8000/api'),
    'http://127.0.0.1:8000/api',
  )
  assert.throws(
    () => assertAllowedApiBase('https://example.com/api'),
    { code: 'DRAFT_API_HOST_NOT_ALLOWED' },
  )
  assert.throws(
    () => normalizeApiBase('not a url'),
    { code: 'DRAFT_API_NOT_CONFIGURED' },
  )
})

test('fetches the existing endpoint and strips unrelated fields', async () => {
  const calls = []
  const result = await fetchDraftCollection(DEFAULT_API_BASE, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify([{
        id: 7,
        title: '标题',
        content: '正文',
        status: 'ready',
        draft_type: 'article',
        updated_at: 'now',
        sources: ['private'],
      }]), { status: 200 })
    },
  })

  assert.equal(calls[0].url, 'http://localhost:8000/api/write/drafts')
  assert.equal(calls[0].init.headers.Accept, 'application/json')
  assert.deepEqual(result, [{
    id: 7,
    title: '标题',
    content: '正文',
    status: 'ready',
    draft_type: 'article',
    updated_at: 'now',
  }])
})

test('hides error response bodies and rejects malformed payloads', async () => {
  await assert.rejects(
    fetchDraftCollection(DEFAULT_API_BASE, {
      fetchImpl: async () => new Response('secret body', { status: 500 }),
    }),
    error => error.code === 'DRAFT_API_UNAVAILABLE' && !error.message.includes('secret body'),
  )

  await assert.rejects(
    fetchDraftCollection(DEFAULT_API_BASE, {
      fetchImpl: async () => new Response('{}', { status: 200 }),
    }),
    { code: 'DRAFT_API_INVALID_RESPONSE' },
  )
})
