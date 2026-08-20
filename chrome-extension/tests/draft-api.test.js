import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_API_BASE,
  assertAllowedApiBase,
  fetchDraftImage,
  fetchDraftCollection,
  normalizeApiBase,
  publishDraft,
} from '../background/draft-api.js'

test('normalizes HTTP API bases without restricting the host or port', () => {
  assert.equal(normalizeApiBase('http://localhost:8000/api/'), DEFAULT_API_BASE)
  assert.equal(
    assertAllowedApiBase('http://127.0.0.1:8000/api'),
    'http://127.0.0.1:8000/api',
  )
  assert.equal(
    assertAllowedApiBase('https://api.example.com:9443/ediora/api/'),
    'https://api.example.com:9443/ediora/api',
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

test('fetches a local upload and returns a CSP-compatible data URL', async () => {
  const calls = []
  const result = await fetchDraftImage(
    DEFAULT_API_BASE,
    'http://localhost:8000/api/uploads/cover.png',
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      },
    },
  )

  assert.equal(calls[0].url, 'http://localhost:8000/api/uploads/cover.png')
  assert.equal(calls[0].init.headers.Accept, 'image/*')
  assert.deepEqual(result, { dataUrl: 'data:image/png;base64,iVBORw==' })
})

test('fetches an upload from a configured remote API origin', async () => {
  const calls = []
  const result = await fetchDraftImage(
    'https://api.example.com:9443/ediora/api',
    'https://api.example.com:9443/ediora/api/uploads/cover.png',
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      },
    },
  )

  assert.equal(calls[0].url, 'https://api.example.com:9443/ediora/api/uploads/cover.png')
  assert.deepEqual(result, { dataUrl: 'data:image/png;base64,iVBORw==' })
})

test('rejects an upload from a sibling origin', async () => {
  await assert.rejects(
    fetchDraftImage(
      'http://127.0.0.1:8000/api',
      'http://localhost:8000/api/uploads/cover.png',
      { fetchImpl: async () => new Response('not used') },
    ),
    { code: 'DRAFT_API_INVALID_REQUEST' },
  )
})

test('does not proxy an image outside the configured local upload path', async () => {
  let called = false
  await assert.rejects(
    fetchDraftImage(DEFAULT_API_BASE, 'https://example.com/cover.png', {
      fetchImpl: async () => {
        called = true
        return new Response('not used')
      },
    }),
    { code: 'DRAFT_API_INVALID_REQUEST' },
  )
  assert.equal(called, false)
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

test('publishes one draft through the local PATCH endpoint', async () => {
  const calls = []
  const result = await publishDraft(DEFAULT_API_BASE, 7, {
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({
        id: 7,
        title: '标题',
        content: '正文',
        status: 'published',
        draft_type: 'x',
        updated_at: 'now',
        sources: ['private'],
      }), { status: 200 })
    },
  })

  assert.equal(calls[0].url, 'http://localhost:8000/api/write/drafts/7')
  assert.equal(calls[0].init.method, 'PATCH')
  assert.equal(calls[0].init.headers.Accept, 'application/json')
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), { status: 'published' })
  assert.deepEqual(result, {
    id: 7,
    title: '标题',
    content: '正文',
    status: 'published',
    draft_type: 'x',
    updated_at: 'now',
  })
})

test('rejects invalid draft ids before making a request', async () => {
  let called = false
  await assert.rejects(
    publishDraft(DEFAULT_API_BASE, 0, {
      fetchImpl: async () => {
        called = true
        return new Response('{}')
      },
    }),
    { code: 'DRAFT_API_INVALID_REQUEST' },
  )
  assert.equal(called, false)
})
