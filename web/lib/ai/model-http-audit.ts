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

const auditContext = new AsyncLocalStorage<ModelHttpAuditContext>()
const sensitiveNamePattern = /(authorization|api[_-]?key|cookie|password|secret|token)/i
const redactedValue = '[REDACTED]'

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
      void captureRequest(options.onEvent, context, input, init).catch(() => undefined)
      void captureError(options.onEvent, context, input, init, error).catch(() => undefined)
      throw error
    }

    void captureRequest(options.onEvent, context, input, init).catch(() => undefined)

    try {
      const response = await providerResponse
      void captureResponse(options.onEvent, context, response).catch(() => undefined)
      return response
    } catch (error) {
      void captureError(options.onEvent, context, input, init, error).catch(() => undefined)
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
    error: sanitizeText(error instanceof Error ? error.message : String(error)),
  })
}

async function captureResponse(
  onEvent: (event: ModelHttpAuditEvent) => void | Promise<void>,
  context: ModelHttpAuditContext,
  response: Response,
): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      url: sanitizeUrl(response.url),
      status: response.status,
      statusText: sanitizeText(response.statusText),
      headers: sanitizeHeaders(response.headers),
    }
    const body = await responseBody(response)

    if (body) {
      payload.body = body.text
      payload.bodyTruncated = body.truncated
    }

    await emitEvent(onEvent, context, 'http_response', payload)
  } catch {
    // Auditing must never consume or delay the provider response.
  }
}

async function requestBody(request: Request | undefined, init?: RequestInit): Promise<BoundedBody | undefined> {
  if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
    return bodyFromInit(init.body)
  }

  if (!request?.body) {
    return undefined
  }

  try {
    return sanitizeBoundedBody(await readBoundedText(request.clone().body))
  } catch {
    return { text: '[unavailable request body]', truncated: false }
  }
}

function bodyFromInit(body: BodyInit | null | undefined): BoundedBody | undefined {
  if (body == null) {
    return undefined
  }

  if (typeof body === 'string') {
    return sanitizeBoundedBody({ text: body, truncated: false })
  }

  if (body instanceof URLSearchParams) {
    return sanitizeBoundedBody({ text: body.toString(), truncated: false })
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

function truncateText(text: string): BoundedBody {
  const bytes = new TextEncoder().encode(text)
  if (bytes.byteLength <= MODEL_HTTP_AUDIT_BODY_LIMIT) {
    return { text, truncated: false }
  }

  return {
    text: new TextDecoder().decode(bytes.subarray(0, MODEL_HTTP_AUDIT_BODY_LIMIT)),
    truncated: true,
  }
}

function sanitizeBoundedBody(body: BoundedBody): BoundedBody {
  const sanitized = truncateText(sanitizeText(body.text))
  return {
    text: sanitized.text,
    truncated: body.truncated || sanitized.truncated,
  }
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
    return url.origin === relativeBase ? `${url.pathname}${url.search}${url.hash}` : url.toString()
  } catch {
    return value.replace(
      /([?&][^=]*?(?:authorization|api[_-]?key|cookie|password|secret|token)[^=]*=)[^&]*/gi,
      `$1${redactedValue}`,
    )
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
    sanitized[name] = isSensitiveName(name) ? redactedValue : sanitizeText(value)
  }
  return sanitized
}

function sanitizeText(text: string): string {
  try {
    return JSON.stringify(sanitizeValue(JSON.parse(text)))
  } catch {
    return text
      .replace(/(bearer\s+)[^\s,;]+/gi, `$1${redactedValue}`)
      .replace(
        /((?:"?(?:authorization|api[_-]?key|cookie|password|secret|token)"?)\s*[=:]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,&;]+)/gi,
        `$1${redactedValue}`,
      )
  }
}

function sanitizeValue(value: unknown): unknown {
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
  return sensitiveNamePattern.test(name)
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
