import assert from 'node:assert/strict'
import test from 'node:test'

import { isXSiteUrl } from '../background/x-site.js'

test('accepts https X and Twitter hosts including www', () => {
  assert.equal(isXSiteUrl('https://x.com/home'), true)
  assert.equal(isXSiteUrl('https://www.x.com/i/status/1'), true)
  assert.equal(isXSiteUrl('https://twitter.com/compose/post'), true)
  assert.equal(isXSiteUrl('https://www.twitter.com/'), true)
})

test('rejects missing, http, and non-X hosts', () => {
  assert.equal(isXSiteUrl(undefined), false)
  assert.equal(isXSiteUrl(''), false)
  assert.equal(isXSiteUrl('http://x.com/home'), false)
  assert.equal(isXSiteUrl('https://notx.com/'), false)
  assert.equal(isXSiteUrl('https://evilx.com/'), false)
})
