export type NetworkRequestDetails = {
  failureText: string
  isNavigationRequest: boolean
  method: string
  resourceType: string
  url: string
}

const PROTECTED_ORIGINS = new Set([
  'http://127.0.0.1:3000',
  'http://localhost:3000',
  'http://127.0.0.1:8000',
  'http://localhost:8000',
])
const MEDIA_FAILURE_REASON = 'Remote user media failures are allowed because third-party media availability does not indicate an application or API failure.'
const NAVIGATION_ABORT_REASON = 'Navigation ERR_ABORTED is allowed when client-side navigation supersedes an in-flight document request.'

function remoteUserMediaFailureReason(request: NetworkRequestDetails) {
  if (request.method !== 'GET' || !['image', 'media'].includes(request.resourceType)) return null
  const url = new URL(request.url)
  if (!['http:', 'https:'].includes(url.protocol) || PROTECTED_ORIGINS.has(url.origin)) return null
  return MEDIA_FAILURE_REASON
}

export function allowedRequestFailureReason(request: NetworkRequestDetails) {
  if (request.isNavigationRequest && request.failureText === 'net::ERR_ABORTED') {
    return NAVIGATION_ABORT_REASON
  }
  return remoteUserMediaFailureReason(request)
}

export function allowedHttpFailureReason(request: NetworkRequestDetails, status: number) {
  if (status < 400 || status >= 500) return null
  return remoteUserMediaFailureReason(request)
}
