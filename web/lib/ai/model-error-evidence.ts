import {
  sanitizeModelHttpAuditText,
  sanitizeModelHttpAuditValue,
} from './model-http-audit'

/** Maximum UTF-8 size of one persisted model-error diagnostic payload. */
export const MODEL_ERROR_DIAGNOSTIC_PAYLOAD_LIMIT = 64 * 1024

const MODEL_ERROR_DIAGNOSTIC_FIELD_LIMIT = 4 * 1024
const MODEL_ERROR_DIAGNOSTIC_NODE_LIMIT = 512
const MODEL_ERROR_MAX_DEPTH = 4
const MODEL_ERROR_MAX_ITEMS = 50
const textEncoder = new TextEncoder()

type ModelErrorSerializationState = {
  remainingNodes: number
  remainingValueBytes: number
  truncated: boolean
}

function boundedDiagnosticString(value: string, state: ModelErrorSerializationState) {
  if (state.remainingValueBytes <= 0) {
    state.truncated = true
    return '[truncated]'
  }
  const sanitized = sanitizeModelHttpAuditText(
    value,
    Math.min(MODEL_ERROR_DIAGNOSTIC_FIELD_LIMIT, state.remainingValueBytes),
  )
  state.remainingValueBytes -= textEncoder.encode(sanitized.text).byteLength
  state.truncated ||= sanitized.truncated
  return sanitized.text
}

function boundedJsonSafe(
  value: unknown,
  state: ModelErrorSerializationState,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (state.remainingNodes <= 0) {
    state.truncated = true
    return '[truncated]'
  }
  state.remainingNodes -= 1
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'string') return boundedDiagnosticString(value, state)
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (depth >= MODEL_ERROR_MAX_DEPTH) {
    state.truncated = true
    return '[truncated]'
  }
  if (typeof value !== 'object') return boundedDiagnosticString(String(value), state)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) {
    const result: unknown[] = []
    for (const item of value) {
      if (result.length >= MODEL_ERROR_MAX_ITEMS || state.remainingNodes <= 0) {
        state.truncated = true
        break
      }
      const safeItem = boundedJsonSafe(item, state, depth + 1, seen)
      if (safeItem !== undefined) result.push(safeItem)
    }
    return result
  }
  const result: Record<string, unknown> = Object.create(null)
  let itemCount = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (itemCount >= MODEL_ERROR_MAX_ITEMS || state.remainingNodes <= 0) {
      state.truncated = true
      break
    }
    itemCount += 1
    try {
      const item = boundedJsonSafe(value[key as keyof typeof value], state, depth + 1, seen)
      if (item !== undefined) result[key] = item
    } catch {
      result[key] = '[unavailable]'
    }
  }
  return result
}

function errorField(error: unknown, key: string): unknown {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined
  try {
    return (error as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function sanitizedDiagnosticValue(value: unknown, state: ModelErrorSerializationState): unknown {
  const bounded = boundedJsonSafe(value, state)
  if (bounded === undefined) return undefined
  const sanitized = sanitizeModelHttpAuditValue(bounded)
  const serialized = JSON.stringify(sanitized)
  if (serialized === undefined) return undefined
  const boundedText = sanitizeModelHttpAuditText(serialized, MODEL_ERROR_DIAGNOSTIC_FIELD_LIMIT)
  if (boundedText.truncated) {
    state.truncated = true
    return '[truncated]'
  }
  try {
    return JSON.parse(boundedText.text)
  } catch {
    return boundedText.text
  }
}

function addModelErrorField(
  payload: Record<string, unknown>,
  key: string,
  value: unknown,
  state: ModelErrorSerializationState,
) {
  const serialized = JSON.stringify({ ...payload, [key]: value })
  if (serialized === undefined || textEncoder.encode(serialized).byteLength > MODEL_ERROR_DIAGNOSTIC_PAYLOAD_LIMIT) {
    state.truncated = true
    return false
  }
  payload[key] = value
  return true
}

/**
 * Produces bounded, JSON-safe model-error evidence without changing the original error.
 */
export function modelErrorEvidenceFromUnknown(error: unknown): Record<string, unknown> {
  try {
    const state: ModelErrorSerializationState = {
      remainingNodes: MODEL_ERROR_DIAGNOSTIC_NODE_LIMIT,
      remainingValueBytes: MODEL_ERROR_DIAGNOSTIC_PAYLOAD_LIMIT,
      truncated: false,
    }
    const message = error instanceof Error
      ? error.message
      : typeof errorField(error, 'message') === 'string'
        ? errorField(error, 'message') as string
        : String(error)
    const name = typeof errorField(error, 'name') === 'string'
      ? errorField(error, 'name') as string
      : error instanceof Error ? error.name : 'Error'
    const payload: Record<string, unknown> = {}
    const safeName = sanitizedDiagnosticValue(name, state)
    const safeMessage = sanitizedDiagnosticValue(message, state)
    addModelErrorField(payload, 'name', safeName ?? 'Error', state)
    addModelErrorField(payload, 'message', safeMessage ?? '[unavailable model error evidence]', state)
    addModelErrorField(payload, 'error', safeMessage ?? '[unavailable model error evidence]', state)
    const cause = errorField(error, 'cause')
    if (cause !== undefined) {
      const causeName = typeof errorField(cause, 'name') === 'string'
        ? errorField(cause, 'name') as string
        : cause instanceof Error ? cause.name : 'Error'
      const causeMessage = cause instanceof Error
        ? cause.message
        : typeof errorField(cause, 'message') === 'string'
          ? errorField(cause, 'message') as string
          : String(cause)
      addModelErrorField(payload, 'cause', {
        name: sanitizedDiagnosticValue(causeName, state),
        message: sanitizedDiagnosticValue(causeMessage, state),
      }, state)
    }
    for (const key of ['text', 'finishReason', 'usage', 'response'] as const) {
      const value = errorField(error, key)
      const safeValue = sanitizedDiagnosticValue(value, state)
      if (safeValue !== undefined) addModelErrorField(payload, key, safeValue, state)
    }
    if (state.truncated) addModelErrorField(payload, 'truncated', true, state)
    return payload
  } catch {
    return {
      name: 'Error',
      message: '[unavailable model error evidence]',
      error: '[unavailable model error evidence]',
    }
  }
}
