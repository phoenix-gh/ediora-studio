# Agent Capability Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the three approved follow-up phases after the audit-only capability snapshot: pin Job capabilities, detect drift before retry execution, centralize ToolPolicy profiles, and add enforceable Tool concurrency/idempotency metadata.

**Scope boundary:** No plugin framework. Preserve current Skill execution semantics, scheduled-Agent visibility of `list_drafts` and `get_draft`, and the existing remote-image-upload restriction. The first `prepared` checkpoint is the earliest authoritative capability boundary because MCP Tool discovery happens when the runtime opens.

## Phase 2: Pin Job capabilities and reject retry drift

- [x] Add a nullable `AgentExecution.pinned_capability_snapshot` JSON column and idempotent migration. Keep the existing latest `audit_data.capabilities` evidence separate from the immutable pin.
- [x] Extend the Agent execution checkpoint contract with an optional `capability_pin`; the backend sets it once and only allows the documented first-run null-Skill to selected-Skill bootstrap upgrade. Any mode, visible Tool, policy, or Skill identity/content mismatch returns a non-retryable 409.
- [x] Add pure TypeScript comparison/pinning helpers. Skill activation source is intentionally ignored during comparison because a retry may restore the same Skill with `activation: restored`; Skill identity, version, instruction digest, reference evidence, Tools, and policy remain compared.
- [x] On the first `prepared` boundary, establish the pin before model Tool execution. On retry, restore the previously observed Skill when available and compare the current snapshot before any Tool claim. A missing/changed Skill or changed Tool/policy surface fails deterministically.
- [x] Persist the pin through prepared, step, and finalizing checkpoints for daily creation and content-response Jobs. Do not alter completion, uncertain, or side-effect recovery semantics except for the new drift gate.
- [x] Add backend service/router/database tests and Job retry tests for matching snapshots, activation-only changes, Tool drift, Skill digest drift, and legacy executions without a pin.

## Phase 3: Centralize ToolPolicy profiles

- [x] Add explicit profiles in `web/lib/ai/agent-tool-policy.ts`: `chat`, `scheduled`, and `response-writing`.
- [x] Move the response-writing allow-list into the shared policy module. Keep `list_drafts` and `get_draft` in that profile and retain the scheduled blocked names for remote image uploads.
- [x] Make `openAgentRuntime` resolve profile approval, allow-list, blocked names, and always-available names. Keep compatibility fields for existing test doubles while production Chat and Job adapters pass profiles explicitly.
- [x] Apply the resolved profile to the final visible Tool set and capability audit. Do not make the snapshot an authorization source; runtime filtering remains authoritative.
- [x] Add profile tests proving Chat, scheduled, and response-writing surfaces, including the scheduled boundary and response allow-list.

## Phase 4: Add Tool concurrency/idempotency metadata

- [x] Add explicit `concurrencyPolicy` and `idempotencyPolicy` metadata to Tool descriptors, with safe defaults for unknown Tools.
- [x] Classify current read-only Tools as parallel-safe/replayable, current side-effect Tools as serialized/claim-backed, and `generateImage` as serialized/unknown while preserving its existing approval classification.
- [x] Make `applyAgentToolPolicy` serialize Tools marked serialized. Keep durable `beforeToolExecute` claim/replay/uncertain handling authoritative for Job retries; metadata must not silently claim idempotency that the runtime cannot enforce.
- [x] Extend strict Chat snapshot validation compatibly for old snapshots without the new optional metadata, and add tests for metadata capture plus same-Tool concurrent execution serialization.

## Verification

- [x] Run focused Vitest suites for capability helpers, policy profiles, runtime, global Tools, daily/content Jobs, and Agent execution client.
- [x] Run focused PostgreSQL-backed pytest suites for Agent execution, Chat migration/API, content jobs, daily creation, and Job routers.
- [x] Run changed-file ESLint, `git diff --check`, and inspect all snapshots/pins for bodies, outputs, secrets, or execute functions.
- [x] Report unrelated full-suite baseline failures separately; do not widen this work into unrelated UI or environment failures.
