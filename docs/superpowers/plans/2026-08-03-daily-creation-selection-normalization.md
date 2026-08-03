# Daily Creation Selection Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize compact or partially blank AI selection responses into strict, evidence-backed daily-creation selections, then retry only the latest failed daily-creation job once.

**Architecture:** Keep Zod schemas strict and perform deterministic fallback before validation using the already loaded candidate title, summary, and provider reason. Verify the parser with the exact production failure shape and gate the single runtime retry on zero existing outputs.

**Tech Stack:** TypeScript, Zod 4, Vercel AI SDK 7, Vitest 4, FastAPI job API, Redis worker queue, jq

## Global Constraints

- Do not make persisted `topic` or `angle` optional or allow blank strings.
- Resolve topic from AI topic, candidate title, candidate summary, provider reason, then `素材 <asset_id>`.
- Resolve angle from AI angle, provider reason, then normalized topic.
- Trim whitespace-only strings before deciding whether they are usable.
- Continue rejecting candidate IDs that were not returned by the candidate tool.
- Do not change scheduler catch-up, reuse, comparison-ID, exclusion, or global semantic-deduplication semantics.
- Retry only the latest failed `daily_creation` job, only after confirming its run has `created_count == 0`.
- The one retry is allowed to invoke the configured AI provider and incur cost; do not automatically retry again if it fails.
- Preserve unrelated changes in the dirty worktree and stage only the files listed by each implementation task.

---

### Task 1: Normalize non-blank selection evidence

**Files:**
- Modify: `wemedia-studio/lib/ai/content-job.ts:106-158`
- Test: `wemedia-studio/lib/ai/content-job.test.ts:35-65`

**Interfaces:**
- Consumes: `parseDailyCreationSelection(raw, candidates)` and candidates shaped as `{ id: number; title: string; summary?: string }`.
- Produces: unchanged `DailyCreationSelection`; selected items always contain trimmed, non-empty `topic` and `angle` before strict Zod validation.

- [ ] **Step 1: Write the failing production-shape test**

Extend the compact-selection test with the exact failing shape and fallback precedence:

```typescript
  expect(parseDailyCreationSelection({
    selected: [{ id: 14, reason: '聚焦可以落地的收费方式' }],
  }, [{ id: 14, title: '' }]).selected[0]).toEqual(expect.objectContaining({
    asset_id: 14,
    topic: '聚焦可以落地的收费方式',
    angle: '聚焦可以落地的收费方式',
  }))

  expect(parseDailyCreationSelection({
    selected: [{ id: 15, topic: '  ', angle: '  ', reason: '模型理由' }],
  }, [{ id: 15, title: '  ', summary: '  素材摘要  ' }]).selected[0]).toEqual(expect.objectContaining({
    topic: '素材摘要',
    angle: '模型理由',
  }))

  expect(parseDailyCreationSelection({ selected: [{ id: 16 }] }, [
    { id: 16, title: '', summary: '' },
  ]).selected[0]).toEqual(expect.objectContaining({
    topic: '素材 16',
    angle: '素材 16',
  }))
```

Retain the existing assertion that candidate ID `99` throws `invented asset`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd wemedia-studio
pnpm test -- lib/ai/content-job.test.ts
```

Expected: FAIL in `normalizes common compact AI selection responses without inventing candidate ids` because the blank candidate title becomes an invalid empty topic.

- [ ] **Step 3: Implement deterministic non-blank fallback**

Add a local helper and expand the candidate evidence type:

```typescript
function firstNonBlankString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = value.trim()
    if (normalized) return normalized
  }
  return ''
}

export function parseDailyCreationSelection(
  raw: unknown,
  candidates: Array<{ id: number; title: string; summary?: string }>,
): DailyCreationSelection {
```

Inside the existing selected-item normalization, preserve ID lookup and then replace only the topic/angle calculation:

```typescript
          const topic = firstNonBlankString(
            compact.topic,
            candidate.title,
            candidate.summary,
            compact.reason,
          ) || `素材 ${assetId}`
          const angle = firstNonBlankString(
            compact.angle,
            compact.reason,
            topic,
          )
          return {
            asset_id: assetId,
            topic,
            angle,
            reuse_decision: compact.reuse_decision === 'reuse_allowed' ? 'reuse_allowed' : 'fresh',
            reuse_explanation: typeof compact.reuse_explanation === 'string' ? compact.reuse_explanation : '',
            compared_usage_ids: Array.isArray(compact.compared_usage_ids) ? compact.compared_usage_ids : [],
          }
```

Do not change the unknown-ID check or the final `dailyCreationSelectionSchema.safeParse`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cd wemedia-studio
pnpm test -- lib/ai/content-job.test.ts
```

Expected: all tests in `content-job.test.ts` pass, including blank-title, summary, generic fallback, and invented-ID cases.

- [ ] **Step 5: Commit parser normalization**

```bash
git add wemedia-studio/lib/ai/content-job.ts wemedia-studio/lib/ai/content-job.test.ts
git diff --cached --check
git commit -m "fix: normalize daily creation selection evidence"
```

---

### Task 2: Verify the complete frontend test suite

**Files:**
- No additional source files.

**Interfaces:**
- Consumes: the parser implementation and regression tests from Task 1.
- Produces: complete Vitest regression evidence before any runtime retry.

- [ ] **Step 1: Run the adjacent daily-creation tests**

```bash
cd wemedia-studio
pnpm test -- lib/ai/content-job.test.ts lib/ai/daily-creation-job.test.ts
```

Expected: both focused files pass.

- [ ] **Step 2: Run the complete Vitest suite**

```bash
cd wemedia-studio
pnpm test
```

Expected: the complete Vitest suite passes. If an unrelated dirty-worktree failure appears, record it and do not retry the live job until the parser-focused suite remains green and the failure is proven unrelated.

---

### Task 3: Retry only the latest failed daily-creation job

**Files:**
- No source files. This is a guarded runtime operation after Tasks 1 and 2 are committed and verified.

**Interfaces:**
- Consumes: `GET /api/jobs?limit=100`, `GET /api/daily-plan/creation-runs/{run_id}`, and `POST /api/jobs/{job_id}/retry` with `{ "step_key": "select" }`.
- Produces: one retried job reaching a terminal state and its existing `DailyCreationRun` updated with the created output count.

- [ ] **Step 1: Start and verify the normal development environment**

Run:

```bash
./dev.sh start
./dev.sh status
curl --fail --silent http://127.0.0.1:8000/health | jq .
```

Expected: PostgreSQL, Redis, API, Worker, and Web report ready; `/health` returns a successful JSON response.

- [ ] **Step 2: Resolve and inspect the latest failed daily-creation job**

Run:

```bash
latest_job_json="$(curl --fail --silent 'http://127.0.0.1:8000/api/jobs?limit=100' \
  | jq -c '[.jobs[] | select(.flow == "daily_creation" and .status == "failed")] | sort_by(.created_at) | last')"
printf '%s\n' "$latest_job_json" | jq '{id, status, input, steps}'
job_id="$(printf '%s\n' "$latest_job_json" | jq -r '.id')"
run_id="$(printf '%s\n' "$latest_job_json" | jq -r '.input.run_id')"
run_json="$(curl --fail --silent "http://127.0.0.1:8000/api/daily-plan/creation-runs/$run_id")"
printf '%s\n' "$run_json" | jq '{id, status, created_count, content_job_id}'
printf '%s\n' "$latest_job_json" | jq -e '
  (.id | type == "number" and . > 0)
  and (.input.run_id | type == "number" and . > 0)
  and (.steps | last | .key == "select" and .status == "failed" and .retryable == true)
'
printf '%s\n' "$run_json" | jq -e \
  --argjson job_id "$job_id" \
  '.content_job_id == $job_id and .status == "failed" and .created_count == 0'
```

Required gate: `job_id` and `run_id` are positive integers, the latest failed step key is `select`, `retryable` is true, `content_job_id == job_id`, and `created_count == 0`. If any condition differs, stop without retrying and report the state.

- [ ] **Step 3: Submit exactly one retry**

Run once:

```bash
curl --fail --silent \
  -X POST "http://127.0.0.1:8000/api/jobs/$job_id/retry" \
  -H 'Content-Type: application/json' \
  --data '{"step_key":"select"}' \
  | jq '{id, status, steps}'
```

Expected: the existing job becomes `queued` with a new queued `select` attempt. Do not repeat this command.

- [ ] **Step 4: Monitor the one retry to a terminal state**

Poll without mutating state:

```bash
curl --fail --silent "http://127.0.0.1:8000/api/jobs/$job_id" \
  | jq '{id, status, steps, events}'
```

Repeat only this GET until status is `succeeded`, `failed`, or `cancelled`. If it fails, capture the new failed step and error and stop; do not retry again.

- [ ] **Step 5: Verify persisted outputs**

On success, run:

```bash
curl --fail --silent "http://127.0.0.1:8000/api/daily-plan/creation-runs/$run_id" \
  | jq '{id, status, requested_count, created_count, detail}'
curl --fail --silent "http://127.0.0.1:8000/api/jobs/$job_id" \
  | jq '{id, status, persist: [.steps[] | select(.key == "persist" and .status == "succeeded") | .output]}'
```

Expected: job status is `succeeded`; the run status is `succeeded` or `partial`; `created_count` is greater than zero; the successful persist output contains the created draft or plan-item responses. Report the actual IDs and counts.

---

## Final Verification

- [ ] Confirm the implementation diff touches only `wemedia-studio/lib/ai/content-job.ts` and `wemedia-studio/lib/ai/content-job.test.ts`.
- [ ] Confirm the production failure shape failed before the parser fix and passed afterward.
- [ ] Confirm invented candidate IDs still fail.
- [ ] Confirm the complete Vitest suite passes.
- [ ] Confirm exactly one existing failed job was retried and no new daily-creation run was created.
- [ ] Confirm the retried job's terminal status and persisted output count from the API.
- [ ] Confirm unrelated dirty-worktree files remain unstaged.
