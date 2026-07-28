import { describe, expect, it } from 'vitest'

import {
  allowedHttpFailureReason,
  allowedRequestFailureReason,
  type NetworkRequestDetails,
} from '../../e2e/network-allowlist'

function imageRequest(url: string, overrides: Partial<NetworkRequestDetails> = {}): NetworkRequestDetails {
  return {
    failureText: '',
    isNavigationRequest: false,
    method: 'GET',
    resourceType: 'image',
    url,
    ...overrides,
  }
}

describe('Task 7 browser network allowlist', () => {
  it.each([
    ['application brand asset', 'http://127.0.0.1:3000/brand/ediora-mark.svg'],
    ['application Next static asset', 'http://127.0.0.1:3000/_next/static/media/ediora.svg'],
    ['API upload asset', 'http://127.0.0.1:8000/api/uploads/fixture.png'],
    ['API upload asset through browser API host', 'http://localhost:8000/api/uploads/fixture.png'],
  ])('does not allow a 404 from the %s', (_label, url) => {
    expect(allowedHttpFailureReason(imageRequest(url), 404)).toBeNull()
  })

  it('does not allow a remote user-media 5xx response', () => {
    expect(allowedHttpFailureReason(imageRequest('https://media.example.test/user/avatar.png'), 503)).toBeNull()
  })

  it('allows a remote user-media 4xx response', () => {
    expect(allowedHttpFailureReason(imageRequest('https://media.example.test/user/avatar.png'), 404)).not.toBeNull()
  })

  it.each([
    ['application asset', 'http://localhost:3000/brand/ediora-mark.svg'],
    ['API asset', 'http://127.0.0.1:8000/api/uploads/fixture.png'],
  ])('does not allow a failed request to an %s', (_label, url) => {
    expect(allowedRequestFailureReason(imageRequest(url, { failureText: 'net::ERR_CONNECTION_REFUSED' }))).toBeNull()
  })

  it('allows a failed request for remote user media', () => {
    expect(allowedRequestFailureReason(imageRequest(
      'https://media.example.test/user/avatar.png',
      { failureText: 'net::ERR_CONNECTION_REFUSED' },
    ))).not.toBeNull()
  })

  it('allows only the exact superseded-navigation abort', () => {
    const navigation = imageRequest('http://127.0.0.1:3000/settings', {
      failureText: 'net::ERR_ABORTED',
      isNavigationRequest: true,
      resourceType: 'document',
    })
    expect(allowedRequestFailureReason(navigation)).toMatch(/supersedes an in-flight document request/i)
    expect(allowedRequestFailureReason({
      ...navigation,
      failureText: 'net::ERR_ABORTED_BY_CLIENT',
    })).toBeNull()
  })
})
