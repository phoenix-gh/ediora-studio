# Daily Creation Selection Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require one complete AI selection JSON structure, reject aliases and incomplete items, and expose the same Zod-derived schema in the provider prompt.

**Architecture:** Make the Zod selection schema fully required and parse provider responses without shape normalization. Build the select-step prompt payload from the same schema as JSON Schema so the provider receives exact root keys, item fields, and evidence constraints before strict application validation.

**Tech Stack:** TypeScript, Zod 4 JSON Schema, Vercel AI SDK 7, Vitest 4

## Global Constraints

- Accept only root fields `selected` and `excluded`; do not add or retain response-shape aliases in `parseDailyCreationSelection`.
- Every selected item requires `asset_id`, `topic`, `angle`, `reuse_decision`, `reuse_explanation`, and `compared_usage_ids`.
- Every excluded item requires `asset_id` and `reason`.
- Do not repair missing or blank fields in application code.
- Continue rejecting candidate and usage IDs absent from observed tool evidence.
- Continue requiring a non-empty explanation when `reuse_decision == "reuse_allowed"`.
- Do not change scheduler catch-up, generation, validation, persistence, provider, or model behavior.
- The already consumed retry remains the only runtime retry in this execution. Do not submit another retry without new user authorization.
- Preserve unrelated dirty-worktree changes and stage only named files.

---

### Task 1: Enforce the exact selection schema

**Files:**
- Modify: `wemedia-studio/lib/ai/content-job.ts:16-29,106-158`
- Test: `wemedia-studio/lib/ai/content-job.test.ts:35-100`

**Interfaces:**
- Produces: `parseDailyCreationSelection(raw: unknown): DailyCreationSelection`, which performs only strict structural parsing.
- Retains: `validateDailyCreationSelection(selection, candidateIds, usageIds)` for evidence validation.

- [ ] **Step 1: Replace compact acceptance tests with strict-contract tests**

Add one complete literal fixture and explicit malformed cases:

```typescript
const exactSelection = {
  selected: [{
    asset_id: 12,
    topic: '需求验证',
    angle: '真实付费',
    reuse_decision: 'fresh',
    reuse_explanation: '',
    compared_usage_ids: [],
  }],
  excluded: [{ asset_id: 13, reason: '与近期内容同角度' }],
}

it('accepts only the complete daily creation selection contract', () => {
  expect(parseDailyCreationSelection(exactSelection)).toEqual(exactSelection)
})

it.each([
  { selected_candidates: exactSelection.selected, excluded: [] },
  { selected: [{ id: 12, reason: '紧凑结构' }], excluded: [] },
  { selected: exactSelection.selected },
  {
    selected: [{
      asset_id: 12,
      topic: '需求验证',
      angle: '真实付费',
      reuse_decision: 'fresh',
    }],
    excluded: [],
  },
])('rejects a non-contract daily creation selection: %j', malformed => {
  expect(() => parseDailyCreationSelection(malformed)).toThrow(/invalid daily creation selection/i)
})
```

Retain evidence-validation tests for invented asset IDs, invented usage IDs, and unjustified reuse, but construct their selection input with the complete required fields.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/content-job.test.ts
```

Expected: FAIL because the current parser accepts compact aliases/defaults and because its signature still requires candidate input.

- [ ] **Step 3: Implement strict schema and parsing**

Remove `.default(...)` from selection fields:

```typescript
export const dailyCreationSelectionSchema = z.object({
  selected: z.array(z.object({
    asset_id: z.number().int().positive(),
    topic: z.string().min(1),
    angle: z.string().min(1),
    reuse_decision: z.enum(['fresh', 'reuse_allowed']),
    reuse_explanation: z.string(),
    compared_usage_ids: z.array(z.number().int().positive()),
  })),
  excluded: z.array(z.object({
    asset_id: z.number().int().positive(),
    reason: z.string().min(1),
  })),
})
```

Replace shape normalization with direct parsing:

```typescript
export function parseDailyCreationSelection(raw: unknown): DailyCreationSelection {
  const parsed = dailyCreationSelectionSchema.safeParse(raw)
  if (!parsed.success) {
    const preview = JSON.stringify(raw).slice(0, 500)
    throw new Error(`invalid daily creation selection: ${parsed.error.message}; response=${preview}`)
  }
  return parsed.data
}
```

Update the worker call from `parseDailyCreationSelection(result, candidates)` to `parseDailyCreationSelection(result)`. Do not change `validateDailyCreationSelection` arguments.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/content-job.test.ts
```

Expected: all content-job tests pass; exact structure succeeds, aliases/incomplete structures fail, and evidence validation remains strict.

- [ ] **Step 5: Commit strict parsing**

```bash
git add wemedia-studio/lib/ai/content-job.ts wemedia-studio/lib/ai/content-job.test.ts wemedia-studio/lib/ai/daily-creation-job.ts
git diff --cached --check
git commit -m "fix: enforce daily creation selection contract"
```

---

### Task 2: Emit the exact contract in the provider prompt

**Files:**
- Modify: `wemedia-studio/lib/ai/daily-creation-job.ts:45-60,148-158`
- Test: `wemedia-studio/lib/ai/daily-creation-job.test.ts`

**Interfaces:**
- Produces: `buildDailyCreationSelectionPrompt(input): string`, the exact JSON payload passed to `generateJson` for the select step.
- Consumes: `dailyCreationSelectionSchema` via `z.toJSONSchema`.

- [ ] **Step 1: Write the failing provider-boundary test**

```typescript
import {
  buildDailyCreationSelectionPrompt,
  normalizeRunDirectories,
} from './daily-creation-job'

it('emits the complete strict selection schema to the provider', () => {
  const payload = JSON.parse(buildDailyCreationSelectionPrompt({
    requested_count: 10,
    rule: { name: '夜间创作' },
    candidates: [{ id: 12, title: '需求验证' }],
    recent_global_usage: [],
  }))

  expect(payload.output_rules).toEqual([
    '只返回一个 JSON 对象，不要 Markdown 或解释。',
    '顶层只能包含 selected 和 excluded，禁止使用任何别名。',
    'selected 和 excluded 必须始终返回数组；没有排除项时 excluded 返回空数组。',
    '所有 ID 必须来自给定候选或历史用量。',
  ])
  expect(payload.output_schema).toMatchObject({
    type: 'object',
    required: expect.arrayContaining(['selected', 'excluded']),
    properties: {
      selected: {
        type: 'array',
        items: {
          required: expect.arrayContaining([
            'asset_id',
            'topic',
            'angle',
            'reuse_decision',
            'reuse_explanation',
            'compared_usage_ids',
          ]),
        },
      },
    },
  })
})
```

This exercises the real provider-boundary payload rather than checking source text or a mock.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/daily-creation-job.test.ts
```

Expected: FAIL because `buildDailyCreationSelectionPrompt` does not exist.

- [ ] **Step 3: Build and use the schema-backed prompt payload**

Import `z` and add:

```typescript
type DailyCreationSelectionPromptInput = {
  requested_count: number
  rule: unknown
  candidates: unknown[]
  recent_global_usage: unknown[]
}

export function buildDailyCreationSelectionPrompt(input: DailyCreationSelectionPromptInput) {
  return JSON.stringify({
    output_rules: [
      '只返回一个 JSON 对象，不要 Markdown 或解释。',
      '顶层只能包含 selected 和 excluded，禁止使用任何别名。',
      'selected 和 excluded 必须始终返回数组；没有排除项时 excluded 返回空数组。',
      '所有 ID 必须来自给定候选或历史用量。',
    ],
    output_schema: z.toJSONSchema(dailyCreationSelectionSchema),
    ...input,
  })
}
```

Update the select call:

```typescript
system: '严格按照 prompt 中的 output_schema 和 output_rules 完成通用内容选材与语义去重。字段名、层级和类型必须完全一致。',
prompt: buildDailyCreationSelectionPrompt({
  requested_count: context.requested_count,
  rule: context.rule,
  candidates,
  recent_global_usage: usage,
}),
```

- [ ] **Step 4: Run focused and complete Vitest suites**

Run:

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/content-job.test.ts lib/ai/daily-creation-job.test.ts
pnpm test
```

Expected: both focused files and all Vitest files pass. Run the complete suite outside the restricted sandbox because provider tests bind a local port.

- [ ] **Step 5: Commit the schema-backed prompt**

```bash
git add wemedia-studio/lib/ai/daily-creation-job.ts wemedia-studio/lib/ai/daily-creation-job.test.ts
git diff --cached --check
git commit -m "fix: send strict creation schema to provider"
```

---

### Task 3: Record runtime state without retrying

**Files:**
- No source files.

- [ ] **Step 1: Verify no outputs were created by the consumed retry**

```bash
curl --fail --silent 'http://127.0.0.1:8000/api/daily-plan/creation-runs/17' \
  | jq -e '.id == 17 and .content_job_id == 694 and .status == "failed" and .created_count == 0'
```

If services are stopped, use the backend database environment for an equivalent read-only query. Do not start services solely to perform another retry.

- [ ] **Step 2: Do not call the retry endpoint**

No `POST /api/jobs/694/retry` is permitted in this plan. Report that attempt 2 failed on `selected_candidates`, the run remains at zero outputs, and another retry requires fresh user authorization after integration.

---

## Final Verification

- [ ] Confirm no provider-output alias was added.
- [ ] Confirm the temporary topic/angle fallback implementation and tests were removed.
- [ ] Confirm exact schema, alias rejection, incomplete-field rejection, and evidence-validation tests pass.
- [ ] Confirm the provider prompt payload contains the Zod-derived required structure.
- [ ] Confirm the complete Vitest suite passes.
- [ ] Confirm job `694` was not retried more than the already consumed second attempt.
- [ ] Confirm unrelated dirty-worktree files remain unstaged.
