const CONSOLE_SOURCE = 'shuce-console'
const BRIDGE_SOURCE = 'shuce-bridge'
const REQUEST_TYPE = 'SHUCE_PUBLISH_REQUEST'
const RESULT_TYPE = 'SHUCE_PUBLISH_RESULT'

export function isPublishRequestMessage(message) {
  return Boolean(
    message
    && message.source === CONSOLE_SOURCE
    && message.type === REQUEST_TYPE
    && typeof message.requestId === 'string'
    && message.requestId.length > 0
    && message.payload
    && typeof message.payload === 'object'
    && !Array.isArray(message.payload),
  )
}

export function createResultMessage(requestId, result, error) {
  return {
    source: BRIDGE_SOURCE,
    type: RESULT_TYPE,
    requestId,
    ...(error ? { error } : { result }),
  }
}
