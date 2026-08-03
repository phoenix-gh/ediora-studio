# Daily Creation Selection Normalization Design

## Goal

Prevent a daily creation batch from failing when an AI provider returns a compact selection such as `{ id, reason }` for a creative asset whose stored title is blank. Preserve strict evidence validation and retry only the latest failed daily creation task after the fix is verified.

## Observed Failure

Content job `694` failed in the `select` step before any draft was generated. The provider returned ten valid candidate IDs and non-empty reasons, but no explicit topics. `parseDailyCreationSelection` normalized each ID and used the candidate title as the topic fallback. Those candidates had blank titles, so `dailyCreationSelectionSchema` rejected every selected item at `topic: z.string().min(1)`.

The scheduler catch-up change created the due run successfully and the worker consumed it normally. The failure boundary is provider-output normalization, not scheduling, Redis transport, candidate loading, or draft persistence.

## Selected Approach

Keep the strict selection schema and add deterministic normalization from observed candidate evidence. Do not make `topic` or `angle` optional and do not rely on prompt wording alone.

For each selected item, resolve `topic` from the first non-blank value in this order:

1. AI-provided `topic`;
2. candidate `title`;
3. candidate `summary`;
4. AI-provided `reason`;
5. `素材 <asset_id>`.

Resolve `angle` from the first non-blank value in this order:

1. AI-provided `angle`;
2. AI-provided `reason`;
3. the normalized topic.

Whitespace-only strings count as blank. Normalized text is trimmed before schema validation.

## Trust and Validation Boundary

- Candidate IDs remain authoritative. An unknown or invented ID still fails immediately.
- Candidate title and summary come from the previously loaded MCP candidate list, so they are trusted evidence for deterministic fallback.
- Provider reason is accepted only for a candidate whose ID exists in that list.
- `reuse_decision`, comparison IDs, reuse explanations, excluded items, and global semantic-deduplication validation remain unchanged.
- The persisted output schema remains strict and continues to require non-empty topic and angle values.
- The generic fallback `素材 <asset_id>` guarantees structural validity without inventing a factual claim when all descriptive evidence is blank.

## Prompt Contract

The selection system prompt explicitly requests these fields for each selected item:

- `asset_id`
- `topic`
- `angle`
- `reuse_decision`
- `reuse_explanation`
- `compared_usage_ids`

Prompt reinforcement improves provider output but is defense in depth. The deterministic parser remains responsible for compact and partially blank responses from compatible providers.

## Component Changes

`wemedia-studio/lib/ai/content-job.ts` expands the candidate evidence accepted by `parseDailyCreationSelection` to include optional `summary`. A small internal non-blank-string normalizer implements the fallback order before the existing Zod parse.

`wemedia-studio/lib/ai/daily-creation-job.ts` already supplies candidates containing `summary`; no new API or MCP field is needed. Its selection prompt is strengthened to state the required output fields explicitly.

`wemedia-studio/lib/ai/content-job.test.ts` adds the production failure shape: a candidate with blank title and a compact `{ id, reason }` selection. The test asserts non-empty normalized topic and angle, plus continued rejection of invented candidate IDs.

## Retry Behavior

After code and regression verification:

1. identify the latest failed content job whose flow is `daily_creation`;
2. confirm its creation run is failed and no outputs were persisted;
3. retry that one job through the existing job retry endpoint or service path;
4. do not retry older failed daily creation jobs;
5. monitor the retried job through selection, generation, validation, persistence, and completion;
6. verify the expected drafts or plan items and usage-ledger records exist.

Retry is an explicit post-deployment action because it invokes the configured AI provider again and may incur cost. The user approved retrying only the latest failed task.

## Error Handling

- If the latest failed task is no longer job `694`, select by durable status and creation time rather than a hard-coded ID, then report the resolved ID before retrying.
- If the latest failed run already has persisted outputs, do not automatically retry; report the partial state for review.
- If the retry fails at another step, stop after that single attempt and report the new error. Do not create or retry additional runs.
- If API or worker services are stopped, start the normal development environment before retrying and verify readiness first.

## Testing

- Parser regression test for blank candidate title plus compact `{ id, reason }` output.
- Parser test for whitespace trimming and fallback precedence.
- Parser regression test that invented IDs still fail.
- Daily creation worker test that the strengthened prompt requests all required evidence fields.
- Existing content-job and daily-creation worker tests remain green.
- Runtime verification records the retried job ID, terminal status, created output count, and persisted draft or plan-item IDs.

## Out of Scope

- Allowing empty persisted topics or angles.
- Backfilling titles on existing creative assets.
- Retrying all historical failed daily creation jobs.
- Changing scheduler catch-up semantics.
- Changing AI provider or model configuration.
