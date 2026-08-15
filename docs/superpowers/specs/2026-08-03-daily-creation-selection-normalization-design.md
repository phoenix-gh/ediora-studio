# Daily Creation Selection Contract Design

## Goal

Require the AI provider to return one explicit daily-creation selection structure instead of adding parser aliases for each provider variation. Keep selection validation strict and retry only the latest failed task after the revised contract is verified.

## Observed Failures

Content job `694` failed twice in the `select` step before any draft was generated:

1. Attempt 1 returned compact `{ id, reason }` items and failed because required topics were blank.
2. After a temporary parser fallback, attempt 2 returned the root key `selected_candidates` instead of `selected` and failed because the standard selected array was absent.

Both responses came from a prompt that described selection and deduplication but did not state the exact JSON root keys or required item fields. Passing a Zod schema to the compatible provider API was not sufficient by itself.

## Selected Approach

Define one provider-facing output contract and validate it without response-shape normalization.

The response must be a JSON object with exactly these root fields:

```json
{
  "selected": [
    {
      "asset_id": 381,
      "topic": "非空主题",
      "angle": "非空创作角度",
      "reuse_decision": "fresh",
      "reuse_explanation": "",
      "compared_usage_ids": []
    }
  ],
  "excluded": [
    {
      "asset_id": 382,
      "reason": "非空排除原因"
    }
  ]
}
```

`selected_candidates`, `selected_items`, `selected_assets`, `selections`, numeric arrays, `id`, `candidate_id`, and other aliases are not accepted. A provider response that violates the contract fails explicitly.

## Schema and Prompt Source of Truth

`dailyCreationSelectionSchema` remains the source of truth and requires every field shown above. Remove defaults from `reuse_explanation`, `compared_usage_ids`, and `excluded` so an incomplete response cannot be silently repaired.

The worker builds the provider prompt as JSON containing:

- the requested count, rule, candidate evidence, and recent usage;
- `output_schema`, generated from `dailyCreationSelectionSchema` with Zod's JSON Schema support;
- concise output rules stating that the top-level object may contain only `selected` and `excluded`, every selected item must contain all six required fields, every excluded item must contain both required fields, IDs must come from the supplied evidence, and no aliases or explanatory prose are allowed.

Generating the prompt schema from the validation schema prevents the instructions and runtime validator from drifting apart.

## Parsing and Trust Boundary

`parseDailyCreationSelection` accepts only the raw provider value and applies `dailyCreationSelectionSchema.safeParse` directly. It no longer receives candidates or maps compact output shapes.

After structural parsing, `validateDailyCreationSelection` retains the evidence checks:

- every selected and excluded `asset_id` must exist in the candidate list;
- every `compared_usage_id` must exist in recent usage;
- `reuse_allowed` requires a non-empty explanation.

This separates structural responsibility from evidence responsibility: the provider must follow the documented shape, while the application still prevents invented IDs and unjustified reuse.

## Components

- `web/lib/ai/content-job.ts`: make the selection schema fully required and replace compact normalization with strict parsing.
- `web/lib/ai/content-job.test.ts`: replace compact-response acceptance tests with exact-contract acceptance and malformed/alias rejection tests.
- `web/lib/ai/daily-creation-job.ts`: add a provider-prompt builder that embeds the generated JSON Schema and explicit output rules, then use it for the select step.
- `web/lib/ai/daily-creation-job.test.ts`: parse the emitted provider payload and verify its observable `output_schema` and rules at the model boundary.

## Testing

- Exact complete structure parses successfully.
- `selected_candidates` and compact `{ id, reason }` responses fail.
- Missing `excluded`, `reuse_explanation`, or `compared_usage_ids` fails.
- Empty topic and angle values fail.
- The provider prompt payload contains an object JSON Schema whose required root keys are `selected` and `excluded` and whose selected-item schema requires all six fields.
- Invented candidate and usage IDs still fail in evidence validation.
- Focused AI tests and the complete Vitest suite pass.

## Retry Behavior

The first approved retry has already been consumed and failed with `selected_candidates`. It created no output. No further retry occurs without new cost authorization.

After the strict contract is implemented, merged, and deployed:

1. verify the existing run still has `created_count == 0`;
2. request explicit authorization for one additional AI retry;
3. if authorized, retry only the latest failed `select` step once;
4. monitor to a terminal state and never retry automatically after another failure.

## Out of Scope

- Adding new provider-output aliases.
- Repairing missing selection fields in application code.
- Changing scheduler catch-up behavior.
- Changing the AI provider or model.
- Retrying historical failed jobs.
