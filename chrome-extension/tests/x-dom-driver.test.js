import assert from 'node:assert/strict'
import test from 'node:test'

import { ERROR_CODES } from '../content/contracts.js'
import {
  createXDomDriver,
  isXHost,
  hasSubmissionEvidence,
} from '../content/x-dom-driver.js'

test('recognizes only the approved X hosts', () => {
  assert.equal(isXHost('x.com'), true)
  assert.equal(isXHost('twitter.com'), true)
  assert.equal(isXHost('www.x.com'), false)
  assert.equal(isXHost('example.com'), false)
})

test('rejects a non-X page before touching the composer', async () => {
  const document = { querySelector() { throw new Error('must not query') } }
  const driver = createXDomDriver(document, { location: { hostname: 'example.com' } })

  await assert.rejects(driver.assertSupportedPage(), { code: ERROR_CODES.UNSUPPORTED_PAGE })
})

test('accepts submission evidence only from a closed composer or success message', () => {
  assert.equal(hasSubmissionEvidence({ composer: null, successText: '' }), true)
  assert.equal(hasSubmissionEvidence({ composer: {}, successText: '' }), false)
  assert.equal(hasSubmissionEvidence({ composer: {}, successText: 'Your post was sent' }), true)
  assert.equal(hasSubmissionEvidence({ composer: {}, successText: 'Network request finished' }), false)
})
