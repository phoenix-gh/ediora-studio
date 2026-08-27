import { AsyncLocalStorage } from 'node:async_hooks'

export const MODEL_HTTP_AUDIT_BODY_LIMIT = 256 * 1024

export type ModelHttpAuditContext = {
  callId: string
  phase: string
  step: number
}

export type ModelHttpAuditEvent = ModelHttpAuditContext & {
  direction: 'http_request' | 'http_response' | 'http_error'
  occurredAt: string
  payload: Record<string, unknown>
}

type BoundedBody = {
  text: string
  truncated: boolean
}

export type ModelHttpAuditSanitizedText = {
  text: string
  truncated: boolean
}

const auditContext = new AsyncLocalStorage<ModelHttpAuditContext>()
const sensitiveNamePattern = /(?:^|_)(authorization|api_?key|cookie|password|secret|token)(?:$|_)/i
const sensitiveAliases = new Set([
  'credential',
  'credentials',
  'client_credential',
  'client_credentials',
  'private_key',
  'passphrase',
])
const redactedValue = '[REDACTED]'
const omittedStructuredBody = '[omitted unsafe structured body]'
const omittedStructuredText = '[omitted unsafe structured text]'

export function withModelHttpAuditContext<T>(
  context: ModelHttpAuditContext,
  operation: () => T,
): T {
  return auditContext.run(context, operation)
}

export function currentModelHttpAuditContext(): ModelHttpAuditContext | undefined {
  return auditContext.getStore()
}

export function createModelHttpAuditFetch(options: {
  fetch?: typeof globalThis.fetch
  onEvent: (event: ModelHttpAuditEvent) => void | Promise<void>
  registerTask?: (task: Promise<void>) => void
}): typeof globalThis.fetch {
  const providerFetch = options.fetch ?? globalThis.fetch

  return async (input, init) => {
    const context = currentModelHttpAuditContext()
    if (!context) {
      return providerFetch(input, init)
    }

    let providerResponse: Promise<Response>

    try {
      providerResponse = providerFetch(input, init)
    } catch (error) {
      registerAuditTask(options.registerTask, captureRequest(options.onEvent, context, input, init))
      registerAuditTask(options.registerTask, captureError(options.onEvent, context, input, init, error))
      throw error
    }

    registerAuditTask(options.registerTask, captureRequest(options.onEvent, context, input, init))

    try {
      const response = await providerResponse
      registerAuditTask(options.registerTask, captureResponse(options.onEvent, context, response))
      return response
    } catch (error) {
      registerAuditTask(options.registerTask, captureError(options.onEvent, context, input, init, error))
      throw error
    }
  }
}

function createRequestPayload(input: RequestInfo | URL, init?: RequestInit): Record<string, unknown> {
  const inputRequest = input instanceof Request ? input : undefined
  const headers = mergeHeaders(inputRequest?.headers, init?.headers)
  return {
    url: sanitizeUrl(inputRequest?.url ?? String(input)),
    method: init?.method ?? inputRequest?.method ?? 'GET',
    headers: sanitizeHeaders(headers),
  }
}

async function captureRequest(
  onEvent: (event: ModelHttpAuditEvent) => void | Promise<void>,
  context: ModelHttpAuditContext,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<void> {
  const payload = createRequestPayload(input, init)
  const inputRequest = input instanceof Request ? input : undefined
  const body = await requestBody(inputRequest, init)

  if (body) {
    payload.body = body.text
    payload.bodyTruncated = body.truncated
  }

  await emitEvent(onEvent, context, 'http_request', payload)
}

async function captureError(
  onEvent: (event: ModelHttpAuditEvent) => void | Promise<void>,
  context: ModelHttpAuditContext,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  error: unknown,
): Promise<void> {
  const request = createRequestPayload(input, init)
  await emitEvent(onEvent, context, 'http_error', {
    url: request.url,
    method: request.method,
    error: sanitizeModelHttpAuditText(error instanceof Error ? error.message : String(error)).text,
  })
}

async function captureResponse(
  onEvent: (event: ModelHttpAuditEvent) => void | Promise<void>,
  context: ModelHttpAuditContext,
  response: Response,
): Promise<void> {
  const payload: Record<string, unknown> = {
    url: sanitizeUrl(response.url),
    status: response.status,
    statusText: sanitizeModelHttpAuditText(response.statusText).text,
    headers: sanitizeHeaders(response.headers),
  }

  try {
    const body = await responseBody(response)

    if (body) {
      payload.body = body.text
      payload.bodyTruncated = body.truncated
    }
  } catch (error) {
    payload.body = '[unavailable response body]'
    payload.bodyError = sanitizeModelHttpAuditText(error instanceof Error ? error.message : String(error)).text
  }

  await emitEvent(onEvent, context, 'http_response', payload)
}

function requestBody(request: Request | undefined, init?: RequestInit): BoundedBody | undefined {
  if (init && Object.prototype.hasOwnProperty.call(init, 'body') && init.body !== undefined) {
    return bodyFromInit(init.body)
  }

  if (request?.body) {
    return { text: '[unsupported streaming request body]', truncated: false }
  }

  return undefined
}

function bodyFromInit(body: BodyInit | null | undefined): BoundedBody | undefined {
  if (body == null) {
    return undefined
  }

  if (typeof body === 'string') {
    return sanitizeBoundedBody(truncateText(body))
  }

  if (body instanceof URLSearchParams) {
    return sanitizeBoundedBody(boundedUrlSearchParams(body))
  }

  return { text: '[unsupported request body]', truncated: false }
}

async function responseBody(response: Response): Promise<BoundedBody | undefined> {
  if (!response.body) {
    return undefined
  }

  return sanitizeBoundedBody(await readBoundedText(response.clone().body))
}

async function readBoundedText(body: ReadableStream<Uint8Array> | null): Promise<BoundedBody> {
  if (!body) {
    return { text: '', truncated: false }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let truncated = false

  try {
    while (length <= MODEL_HTTP_AUDIT_BODY_LIMIT) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      const remaining = MODEL_HTTP_AUDIT_BODY_LIMIT + 1 - length
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
      chunks.push(chunk)
      length += chunk.byteLength

      if (value.byteLength > remaining || length > MODEL_HTTP_AUDIT_BODY_LIMIT) {
        truncated = true
        void reader.cancel().catch(() => undefined)
        break
      }
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = concatBytes(chunks, Math.min(length, MODEL_HTTP_AUDIT_BODY_LIMIT))
  return { text: new TextDecoder().decode(bytes), truncated }
}

function concatBytes(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length)
  let offset = 0

  for (const chunk of chunks) {
    const segment = chunk.subarray(0, Math.max(0, length - offset))
    result.set(segment, offset)
    offset += segment.byteLength
    if (offset === length) {
      break
    }
  }

  return result
}

function boundedUrlSearchParams(params: URLSearchParams): BoundedBody {
  let text = ''

  for (const [key, value] of params) {
    const separator = text ? '&' : ''
    const boundedKey = truncateText(key).text
    const boundedValue = truncateText(value).text
    const entry = `${separator}${new URLSearchParams([[boundedKey, boundedValue]]).toString()}`
    const combined = `${text}${entry}`
    const bounded = truncateText(combined)
    if (bounded.truncated) {
      return bounded
    }
    text = combined
  }

  return { text, truncated: false }
}

function truncateText(text: string, maxBytes = MODEL_HTTP_AUDIT_BODY_LIMIT): BoundedBody {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : MODEL_HTTP_AUDIT_BODY_LIMIT
  if (limit === 0) {
    return { text: '', truncated: text.length > 0 }
  }

  const encoder = new TextEncoder()
  const maxChars = Math.min(text.length, limit)
  let end = maxChars
  let bytes = encoder.encode(text.slice(0, end))

  if (bytes.byteLength > limit) {
    let low = 0
    let high = end
    bytes = encoder.encode('')
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const middleBytes = encoder.encode(text.slice(0, middle))
      if (middleBytes.byteLength <= limit) {
        low = middle
        bytes = middleBytes
      } else {
        high = middle - 1
      }
    }
    end = low
  }

  return {
    text: new TextDecoder().decode(bytes),
    truncated: end < text.length,
  }
}

function sanitizeBoundedBody(body: BoundedBody): BoundedBody {
  const sanitized = sanitizeModelHttpAuditText(body.text)
  return {
    text: isUnsafeStructuredText(body.text) ? omittedStructuredBody : sanitized.text,
    truncated: body.truncated || sanitized.truncated,
  }
}

/**
 * Sanitizes model-provider text and guarantees UTF-8 output is at most maxBytes.
 * The default budget is MODEL_HTTP_AUDIT_BODY_LIMIT (256 KiB).
 */
export function sanitizeModelHttpAuditText(
  text: string,
  maxBytes = MODEL_HTTP_AUDIT_BODY_LIMIT,
): ModelHttpAuditSanitizedText {
  const input = truncateText(text, maxBytes)
  const output = truncateText(sanitizeText(input.text), maxBytes)
  return { text: output.text, truncated: input.truncated || output.truncated }
}

/** Sanitizes nested diagnostic values before they are persisted as model evidence. */
export function sanitizeModelHttpAuditValue(value: unknown): unknown {
  return sanitizeValue(value)
}

function sanitizeUrl(value: string): string {
  try {
    const relativeBase = 'https://model-http-audit.invalid'
    const url = new URL(value, relativeBase)
    for (const [key] of Array.from(url.searchParams)) {
      if (isSensitiveName(key)) {
        url.searchParams.set(key, redactedValue)
      }
    }
    url.username = ''
    url.password = ''
    url.hash = ''
    return url.origin === relativeBase ? `${url.pathname}${url.search}${url.hash}` : url.toString()
  } catch {
    const withoutFragment = value.split('#', 1)[0]
    const withoutUserInfo = withoutFragment.replace(/^((?:[a-z][a-z\d+.-]*:)?\/\/)[^/?#@]*@/i, '$1')
    return sanitizeFallbackQuery(withoutUserInfo)
  }
}

function sanitizeFallbackQuery(value: string): string {
  return value.replace(/([?&])([^=&]*)(=)([^&]*)/g, (pair, prefix: string, name: string, equals: string) => {
    const decodedName = decodeQueryName(name)
    return isSensitiveName(decodedName) ? `${prefix}${name}${equals}${redactedValue}` : pair
  })
}

function decodeQueryName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, ' '))
  } catch {
    return name
  }
}

function mergeHeaders(requestHeaders?: Headers, initHeaders?: HeadersInit): Headers {
  const headers = new Headers(requestHeaders)
  if (initHeaders) {
    for (const [name, value] of new Headers(initHeaders)) {
      headers.set(name, value)
    }
  }
  return headers
}

function sanitizeHeaders(headers: Headers): Record<string, string> {
  const sanitized: Record<string, string> = {}
  for (const [name, value] of headers) {
    if (/cookie/i.test(name)) {
      continue
    }
    sanitized[name] = isSensitiveName(name) ? redactedValue : sanitizeModelHttpAuditText(value).text
  }
  return sanitized
}

function sanitizeText(text: string): string {
  const fenced = sanitizeFencedJson(text)
  if (fenced !== undefined) {
    return fenced
  }

  try {
    return JSON.stringify(sanitizeValue(JSON.parse(text)))
  } catch {
    if (isStructuredJson(text)) {
      return omittedStructuredText
    }
    return sanitizePlainText(text)
  }
}

function sanitizeFencedJson(text: string): string | undefined {
  const fencedStart = /^\s*```json\b/i
  if (!fencedStart.test(text)) {
    return undefined
  }

  const match = text.match(/^(\s*```json[^\S\r\n]*\r?\n)([\s\S]*?)(\r?\n```\s*)$/i)
  if (!match) {
    return omittedStructuredText
  }

  try {
    return `${match[1]}${JSON.stringify(sanitizeValue(JSON.parse(match[2])))}${match[3]}`
  } catch {
    return omittedStructuredText
  }
}

function sanitizePlainText(text: string): string {
  return text
    .replace(/(bearer\s+)[^\s,;]+/gi, `$1${redactedValue}`)
    .replace(
      /([?&][^=]*?(?:authorization|api[_-]?key|cookie|password|secret|token|credentials?|client[_-]?credentials?|private[_-]?key|passphrase)[^=]*=)[^&#\s]*/gi,
      `$1${redactedValue}`,
    )
    .replace(
      /((?:"?(?:authorization|api[_-]?key|cookie|password|secret|token|credentials?|client[_-]?credentials?|private[_-]?key|passphrase)"?)\s*[=:]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,&;]+)/gi,
      `$1${redactedValue}`,
    )
}

function isUnsafeStructuredText(text: string): boolean {
  return isStructuredJson(text) && !isValidJson(text)
}

function isStructuredJson(text: string): boolean {
  return /^[\s]*[\[{]/.test(text)
}

function isValidJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizePlainText(value)
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveName(key) ? redactedValue : sanitizeValue(entry),
    ]))
  }

  return value
}

function isSensitiveName(name: string): boolean {
  const normalized = name
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[^a-z\d]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
  return sensitiveAliases.has(normalized) || sensitiveNamePattern.test(normalized)
}

async function emitEvent(
  onEvent: (event: ModelHttpAuditEvent) => void | Promise<void>,
  context: ModelHttpAuditContext,
  direction: ModelHttpAuditEvent['direction'],
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await onEvent({
      ...context,
      direction,
      occurredAt: new Date().toISOString(),
      payload,
    })
  } catch {
    // Audit callback failures must not alter provider behavior.
  }
}

function registerAuditTask(
  registerTask: ((task: Promise<void>) => void) | undefined,
  task: Promise<void>,
): void {
  const isolatedTask = task.catch(() => undefined)
  try {
    registerTask?.(isolatedTask)
  } catch {
    // Lifecycle registration must not alter provider behavior.
  }
}
