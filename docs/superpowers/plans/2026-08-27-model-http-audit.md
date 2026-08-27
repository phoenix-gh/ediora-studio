# Model HTTP Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist sanitized provider HTTP request/response evidence and correlate it with each Ediora Agent model call.

**Architecture:** A reusable audited fetch captures the actual OpenAI-compatible HTTP exchange. `AsyncLocalStorage` supplies the current Agent call identity without global mutable state, and the Chat route writes audit events into the existing Agent log stream.

**Tech Stack:** TypeScript, Next.js server routes, Vercel AI SDK 7, `@ai-sdk/openai`, Vitest, FastAPI Agent log API

**Spec:** `docs/superpowers/specs/2026-08-27-model-http-audit-design.md`

## Global Constraints

- Never persist authorization, cookies, API keys, tokens, passwords, or secrets.
- Cap each sanitized body at 256 KiB and expose a truncation flag.
- Do not consume or delay the response stream used by AI SDK.
- Audit failures must not alter Chat success or failure behavior.
- Reuse `agent_log_events`; do not add a database migration.

---

### Task 1: HTTP audit boundary

**Files:**
- Create: `web/lib/ai/model-http-audit.ts`
- Test: `web/lib/ai/model-http-audit.test.ts`

**Interfaces:**
- Produces: `withModelHttpAuditContext(context, operation)`, `currentModelHttpAuditContext()`, `createModelHttpAuditFetch(options)`, and `ModelHttpAuditEvent`.
- Consumes: native `fetch`, `Request`, `Response`, and Node `AsyncLocalStorage`.

- [ ] **Step 1: Write failing tests for correlated request/response events, secret redaction, truncation, and network errors.**

```ts
const events: ModelHttpAuditEvent[] = []
const auditedFetch = createModelHttpAuditFetch({
  fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'secret' },
  }),
  onEvent: event => { events.push(event) },
})
await withModelHttpAuditContext({ callId: 'call-1', phase: 'plan', step: 2 }, () => auditedFetch(
  'https://provider.test/v1/chat/completions?api_key=secret',
  {
    method: 'POST',
    headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test', api_key: 'secret', messages: [{ role: 'user', content: 'hello' }] }),
  },
))
await vi.waitFor(() => expect(events).toHaveLength(2))
expect(events.map(event => event.direction)).toEqual(['http_request', 'http_response'])
expect(JSON.stringify(events)).not.toContain('secret')
expect(events[0]).toMatchObject({ callId: 'call-1', phase: 'plan', step: 2 })
```

- [ ] **Step 2: Run `pnpm exec vitest run lib/ai/model-http-audit.test.ts` and verify it fails because the audit module does not exist.**
- [ ] **Step 3: Implement the exact public contract and bounded body shape.**

```ts
export const MODEL_HTTP_AUDIT_BODY_LIMIT = 256 * 1024
export type ModelHttpAuditContext = { callId: string; phase: string; step: number }
export type ModelHttpAuditEvent = ModelHttpAuditContext & {
  direction: 'http_request' | 'http_response' | 'http_error'
  occurredAt: string
  payload: Record<string, unknown>
}
export function withModelHttpAuditContext<T>(context: ModelHttpAuditContext, operation: () => T): T
export function currentModelHttpAuditContext(): ModelHttpAuditContext | undefined
export function createModelHttpAuditFetch(options: {
  fetch?: typeof globalThis.fetch
  onEvent: (event: ModelHttpAuditEvent) => void | Promise<void>
}): typeof globalThis.fetch
```

- [ ] **Step 4: Re-run `pnpm exec vitest run lib/ai/model-http-audit.test.ts` and verify all cases pass.**
- [ ] **Step 5: Commit with `git add web/lib/ai/model-http-audit* && git commit -m "feat: capture model HTTP exchanges"`.**

### Task 2: Runtime call identity and parse-error evidence

**Files:**
- Modify: `web/lib/ai/agent-runtime-types.ts`
- Modify: `web/lib/ai/agent-runtime.ts`
- Test: `web/lib/ai/agent-runtime.test.ts`

**Interfaces:**
- Consumes: `withModelHttpAuditContext` from Task 1.
- Produces: `AgentModelMessageEvent.callId` and enriched `model_error` payloads.

- [ ] **Step 1: Add one runtime test that captures the active HTTP context and one error-evidence test.**

```ts
deps.generate = vi.fn(async () => {
  contexts.push(currentModelHttpAuditContext())
  return { text: 'done', content: [], toolResults: [] }
}) as AgentRuntimeDependencies['generate']
expect(messages[0].callId).toBe(messages[1].callId)
expect(contexts[0]).toMatchObject({ callId: messages[0].callId, phase: 'execute', step: 1 })

const parseError = Object.assign(new Error('No object generated: could not parse the response.'), {
  name: 'AI_NoObjectGeneratedError', text: '```json\n{"broken":\n```', finishReason: 'length',
  usage: { inputTokens: 10, outputTokens: 20 }, response: { id: 'response-1' },
  cause: new Error('JSON parse failed'),
})
deps.generate = vi.fn(async () => { throw parseError }) as AgentRuntimeDependencies['generate']
await expect(runtime.run(request)).rejects.toThrow(parseError.message)
expect(messages.at(-1)?.payload).toMatchObject({
  name: 'AI_NoObjectGeneratedError', text: expect.stringContaining('{"broken"'),
  finishReason: 'length', usage: { inputTokens: 10, outputTokens: 20 },
  response: { id: 'response-1' }, cause: { name: 'Error', message: 'JSON parse failed' },
})
```

- [ ] **Step 2: Run `pnpm exec vitest run lib/ai/agent-runtime.test.ts` and verify the call-ID/context and error-evidence assertions fail.**
- [ ] **Step 3: Add `callId: string` to `AgentModelMessageEvent`, generate it with `randomUUID()`, run `deps.generate` through `withModelHttpAuditContext`, and serialize only bounded JSON-safe error fields.**
- [ ] **Step 4: Re-run `pnpm exec vitest run lib/ai/agent-runtime.test.ts` and verify it passes.**
- [ ] **Step 5: Commit with `git add web/lib/ai/agent-runtime* web/lib/ai/agent-runtime-types.ts && git commit -m "feat: correlate model audit events"`.**

### Task 3: Provider and Chat persistence integration

**Files:**
- Modify: `web/lib/ai/runtime-config.ts`
- Modify: `web/app/api/chat/route.ts`
- Test: `web/lib/ai/runtime-config.test.ts`
- Test: `web/app/api/chat/route.test.ts`

**Interfaces:**
- Consumes: `createModelHttpAuditFetch` and `ModelHttpAuditEvent` from Task 1.
- Produces: `llm/http-request`, `llm/http-response`, and `llm/http-error` rows with `callId`, phase, and step.

- [ ] **Step 1: Write failing provider-injection and Chat mapping tests.**

```ts
const auditedFetch = vi.fn()
openaiProviderFromConfig(config, { fetch: auditedFetch as typeof fetch })
expect(api.createOpenAI).toHaveBeenCalledWith(expect.objectContaining({ fetch: auditedFetch }))

expect(chatAgentLogEventFromHttpAudit({
  callId: 'call-1', phase: 'plan', step: 2, direction: 'http_response',
  occurredAt: '2026-08-27T00:00:00.000Z', payload: { status: 200, body: '{"ok":true}' },
}, context)).toMatchObject({
  stream_key: 'chat:12', step_id: '2', event_type: 'llm/http-response', phase: 'plan',
  payload: { callId: 'call-1', status: 200, body: '{"ok":true}' },
})
```

- [ ] **Step 2: Run `pnpm exec vitest run lib/ai/runtime-config.test.ts app/api/chat/route.test.ts` and verify both new expectations fail.**
- [ ] **Step 3: Change the provider constructor to the following compatible signature and wire it in Chat.**

```ts
export function openaiProviderFromConfig(
  config: Pick<TextModelConfig, 'apiKey' | 'baseURL' | 'headers'>,
  options: { fetch?: typeof globalThis.fetch } = {},
) {
  return createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, headers: config.headers, fetch: options.fetch })
}
```

Create the audited fetch with `onEvent: event => persistChatAgentLogEvent(chatAgentLogEventFromHttpAudit(event, logContext))` and pass it only to the text provider.

- [ ] **Step 4: Re-run `pnpm exec vitest run lib/ai/runtime-config.test.ts app/api/chat/route.test.ts` and verify both pass.**
- [ ] **Step 5: Commit with `git add web/lib/ai/runtime-config* web/app/api/chat/route* && git commit -m "feat: persist Chat model HTTP audit"`.**

### Task 4: Regression and live verification

**Files:**
- Verify only; no planned production files.

**Interfaces:**
- Consumes: all preceding tasks.
- Produces: fresh test, lint, and live runtime evidence.

- [ ] **Step 1: Run `pnpm exec vitest run lib/ai/model-http-audit.test.ts lib/ai/agent-runtime.test.ts lib/ai/agent-trajectory.test.ts lib/ai/runtime-config.test.ts app/api/chat/route.test.ts components/features/agent/AgentTrajectoryPanel.test.tsx`.**
- [ ] **Step 2: Run `pnpm exec eslint lib/ai/model-http-audit.ts lib/ai/model-http-audit.test.ts lib/ai/agent-runtime.ts lib/ai/agent-runtime.test.ts lib/ai/agent-runtime-types.ts lib/ai/runtime-config.ts lib/ai/runtime-config.test.ts app/api/chat/route.ts app/api/chat/route.test.ts` and `git diff --check`.**
- [ ] **Step 3: Independently review the complete source-branch diff and address Critical or Important findings.**
- [ ] **Step 4: Merge the source branch into `develop`, restart Ediora, and verify new Chat logs contain correlated sanitized HTTP request/response events.**
