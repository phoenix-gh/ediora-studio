# Model HTTP Audit Design

## Goal

Make Ediora's Agent logs preserve the sanitized HTTP request and response exchanged with the configured text-model provider, including parse-failure evidence, and correlate that evidence with the existing Turn, phase, and model-call step.

## Scope

- Capture provider HTTP exchanges for Direct Chat, including the generic Skill runtime and the legacy streaming path because both use the same configured provider.
- Keep the existing canonical trajectory focused on orchestration. Store wire evidence as generic `llm/http-request`, `llm/http-response`, and `llm/http-error` Agent log events.
- Add one `callId` to normalized model request/response/error events and use the same identity in HTTP audit events.
- Preserve the raw semantic payload after sanitization. Never persist authorization, cookies, API keys, tokens, secrets, or passwords.
- Limit each captured request or response body to 256 KiB and record whether truncation occurred.
- Continue using the existing `agent_log_events` lifecycle and query API; no database migration or new retention mechanism is introduced.

## Architecture

`agent-runtime.ts` creates a unique call identity for every outer model invocation and executes `generateText` inside a Node `AsyncLocalStorage` context containing `callId`, phase, and step. The OpenAI-compatible provider receives an audited `fetch` implementation from `runtime-config.ts`. At the actual HTTP boundary, that fetch reads the active context, records the sanitized request before dispatch, clones the response, and records its sanitized raw body without consuming the response used by AI SDK.

The Chat route maps HTTP audit records into the existing generic Agent log endpoint. Request logging is awaited but failure-isolated; response-body capture runs from a cloned response and cannot delay or consume streaming output. Existing backend redaction remains a second defense, while the HTTP audit module must sanitize structured bodies before they become opaque strings.

## Data contract

Every HTTP audit record contains:

```ts
type ModelHttpAuditEvent = {
  callId: string
  phase: string
  step: number
  direction: 'http_request' | 'http_response' | 'http_error'
  occurredAt: string
  payload: {
    url: string
    method?: string
    headers?: Record<string, string>
    body?: string
    bodyTruncated?: boolean
    status?: number
    statusText?: string
    error?: string
  }
}
```

Normalized `AgentModelMessageEvent` also carries `callId`. A model error payload must preserve sanitized `name`, `message`, `cause`, provider-generated `text`, `finishReason`, `usage`, and response metadata when present.

## Security and failure behavior

- Redact sensitive header names and case-insensitive JSON keys before serialization.
- Sanitize sensitive URL query parameters.
- Represent unsupported binary or streaming request bodies with a descriptive placeholder instead of consuming them.
- HTTP logging must never change a successful or failed provider result. Audit persistence failures are swallowed by the existing Chat log helper.
- Response capture uses `Response.clone()` and its own bounded text copy.

## Verification

- Unit tests prove correlation, redaction, truncation, success response capture, and network-error capture against a fake fetch.
- Runtime tests prove one stable `callId` spans request/response and that parse errors retain raw AI SDK error evidence.
- Route tests prove HTTP audit events map to the correct Chat stream, phase, step, and event type.
- Focused Chat/runtime/backend tests remain green, followed by a live local Chat failure/success inspection when the configured provider is available.
