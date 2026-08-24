# Agent-Owned Completion and Runtime Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan.

**Goal:** Make goal completion robust by separating the Agent's completion declaration from Harness-owned execution evidence, so a model cannot make a legitimate completed run fail by citing a transient or unavailable provider tool-call ID.

**Architecture:** The completion tool accepts the Agent's semantic result (`completed` or `blocked`, summary, remaining work, and optional stable artifact outputs). The runtime normalizes legacy evidence without trusting it, records actual tool audits as runtime evidence, and lets the job layer verify durable business outputs before finalizing. No fixed output count is introduced.

**Tech Stack:** TypeScript, Zod, Vercel AI SDK tool execution, Vitest, Next.js/Ediora job runtime.

## Global Constraints

- Work only on `feat/skill-pipeline-design` until the implementation is verified; merge to `develop` only after the feature branch checks pass.
- Preserve existing persisted job records and raw completion JSON; legacy model evidence may be read but must not control completion.
- Never infer completion from a succeeded execution, a tool-call count, or a model-provided provider tool-call ID.
- Keep daily and pipeline output requirements domain-owned; do not add a hardcoded quantity requirement.
- Use focused frontend tests from `web` with `pnpm exec vitest run <exact files>` before broader checks.

## Task 1: Establish the failing contract tests

**Files:** `web/lib/ai/agent-goal-completion.test.ts`, `web/lib/ai/agent-runtime.test.ts`, `web/lib/ai/daily-creation-agent-job.test.ts`, `web/lib/ai/skill-pipeline-job.test.ts`

- Add a test proving a completion declaration can finish without model-supplied tool-call evidence.
- Add a regression test proving an unavailable/legacy provider tool-call ID is ignored rather than treated as a completion failure.
- Add a runtime test proving the persisted completion record contains evidence derived from actual tool audits.
- Update daily/pipeline expectations to verify durable workflow outputs and Agent status, not a fixed count or model evidence ID.
- Run the exact focused tests and observe the new tests fail against the current implementation.

## Task 2: Separate semantic declaration from runtime evidence

**Files:** `web/lib/ai/agent-goal-completion.ts`, `web/lib/ai/agent-runtime-types.ts`, `web/lib/ai/agent-runtime.ts`

- Change the model-facing contract and instructions to accept semantic completion plus optional stable artifact outputs; remove the instruction to cite provider tool-call IDs.
- Add normalization that strips legacy `evidence` from the model declaration while preserving the original persisted JSON for recovery/data retention.
- Add a Harness-owned runtime evidence type and builder based only on completed tool audits and stable output references.
- Ensure `acceptGoalCompletion` and completion recovery use the normalized declaration and never validate model-owned provider IDs.
- Keep the existing stop/continuation semantics: runtime completion still requires all tool work and pending input/approval handling to settle, while goal completion remains Agent-declared.

## Task 3: Wire domain verification and durable finalization

**Files:** `web/lib/ai/daily-creation-agent-job.ts`, `web/lib/ai/skill-pipeline-job.ts`, related tests

- Replace tool-call-ID evidence validation with runtime evidence construction.
- Keep daily/pipeline domain checks on persisted artifacts and declared stage contracts; do not derive required output quantities from implementation code.
- Make recovery accept the current normalized completion declaration and retain legacy completion payloads without treating stale evidence as live execution proof.
- Ensure blocked declarations remain blocked and incomplete/error states do not get finalized as success.

## Task 4: Document and verify the protocol

**Files:** `docs/superpowers/specs/2026-08-23-ediora-skill-pipeline-design.md`, relevant implementation files

- Update the Ediora skill-pipeline design to describe the three layers: runtime settled, Agent declared, and business outputs verified.
- Document that runtime owns tool-call identity/evidence and that old evidence is compatibility data only.
- Run focused Vitest suites, frontend type/lint checks, and the applicable backend/static checks; record any environment limitation explicitly.

## Task 5: Integrate the verified branch

- Inspect the feature diff and worktree status.
- Merge `feat/skill-pipeline-design` into local `develop` without resetting or overwriting unrelated work.
- Re-run the focused tests on the merged `develop` result and report the exact verification evidence for user testing.

