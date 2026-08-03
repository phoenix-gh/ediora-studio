# Configurable Daily Creation Rules Design

## Context

The existing daily-plan flow creates one date-level `DailyPlan`, asks the planner model for account-oriented topic suggestions, and stores them as `DailyPlanItem` rows. It does not support user-defined recurring creation batches, direct selection from a creative-asset directory, semantic reuse decisions, or automatic creation of several X drafts from one rule.

The first desired rule is: select material from the article-asset directory `搞钱副业`, create 10 X short posts, and avoid repetition within seven days. These values must be normal configuration, not product constants.

## Product Model

Add a `DailyCreationRule` alongside the existing account quota planner. A rule has:

- User-defined name.
- Source asset type and exact creative-asset directory.
- Output type, initially `x_short_post`.
- Target count, from 1 through 50.
- Execution mode: `once` or `recurring`.
- For a one-time rule, one target local date.
- For a recurring rule, an enabled flag and daily execution time in the configured local timezone.
- Deduplication lookback in days, from 1 through 90, defaulting to 7.
- Delivery mode: `drafts` or `plan_items`.
- Optional publishing account. No publishing occurs automatically.
- Optional user instructions appended to the generation requirements.

The rule configuration UI lives on the existing `/daily-plan` page under a distinct `创作规则` region. It supports create, edit, enable or pause, run now, and delete. The first rule can be configured as `搞钱副业 / X 短帖 / 10 / 长期 / 7 天 / 自动生成草稿` entirely through this UI.

## Persistence

### DailyCreationRule

Stores the durable configuration. Directory selection stores both `source_asset_type` and the exact directory name because creative-asset directories are unique only within an asset type. Deleting a directory does not silently retarget a rule; the next run fails visibly with `source_directory_unavailable`.

### DailyCreationRun

Represents one execution of one rule for one local date. It stores status (`queued`, `running`, `succeeded`, `partial`, `failed`, `cancelled`), requested count, created count, ContentJob ID, failure summary, start and finish timestamps, and a snapshot of the rule configuration. A unique idempotency key prevents a recurring rule from running twice for the same scheduled date. `Run now` uses a separate explicit-run key.

### ContentUsageLedger

Records evidence only after an output has been persisted successfully:

- Rule and run IDs.
- Creative asset ID.
- Draft or plan-item ID.
- Output type and optional account ID.
- AI-selected topic and angle summary.
- A compact content fingerprint and generated-text excerpt.
- AI reuse decision, including whether it was a permitted within-window reuse and its explanation.
- Creation timestamp.

The ledger stores no duplicate copy of the full creative-asset body. Failed generations do not reserve or consume an asset.

`ArticleDraft.draft_type` gains the durable value `x_post` for automatically generated X drafts. Generated drafts remain unpublished and appear in the existing draft-management surface.

## AI Decision Tools

Business operations are implemented once in a service module and exposed both as AI SDK tools for the worker and as MCP tools for other agents.

### `list_creative_asset_candidates`

Inputs: `asset_type`, exact `directory`, optional query, and bounded limit.

Returns compact candidate evidence: asset ID, title, summary, tags, source URL, creation date, and content length. The model must call the existing single-asset reader for any candidate it intends to use so the full body is loaded progressively rather than embedding the entire directory in one prompt.

### `get_recent_content_usage`

Inputs: `lookback_days`, output type, optional rule ID, optional account ID, and bounded limit.

Returns recent asset IDs, topic and angle summaries, generated excerpts, timestamps, rule names, and previous reuse explanations. The default scope is global across all creation rules. Rule and account filters are optional diagnostic refinements, not the default deduplication boundary.

### `record_content_usage`

This is not directly callable before output persistence. The worker calls the underlying service transaction only after saving a draft or plan item. The MCP wrapper requires the referenced output to exist and rejects duplicate `(run_id, output_id)` records.

## AI Selection and Deduplication Contract

The AI receives the rule snapshot, candidate catalog, recent global usage, and the requested count. It must produce a bounded structured selection containing:

- Candidate asset ID.
- Proposed topic and distinct angle.
- Similar recent entries considered.
- Decision: `fresh`, `reuse_allowed`, or `reject_duplicate`.
- Concrete deduplication explanation.

The AI evaluates more than asset identity: subject, core claim, example, hook, structure, and intended takeaway. Reusing the same asset inside the lookback window is allowed only when the angle and reader takeaway are materially different and the explanation identifies that difference. Similar outputs from different assets can still be rejected.

The service validates that every selected asset belongs to the configured directory and that every referenced recent entry came from the supplied tool result. The AI cannot invent asset IDs or history. If fewer than the requested number survive, the run becomes `partial`; the system never pads the batch with known duplicates.

Before persistence, a second model validation compares the proposed outputs with each other and with the recent ledger. One revision is allowed for rejected items. Items that still fail are omitted and reported.

## Execution Flow

1. At local daily-plan scheduling time, load enabled recurring rules whose execution time is due and create idempotent `DailyCreationRun` plus `content_jobs` records.
2. A one-time rule is queued only for its configured date. `Run now` uses the same execution path.
3. The worker loads the rule snapshot and exposes only the candidate, asset-reader, recent-usage, and draft/plan persistence operations required by this flow.
4. The model selects non-duplicate candidate-angle pairs with evidence.
5. The model generates up to the requested count of independent X short posts. Each output must be a standalone post rather than a thread, must not invent personal experience, and must respect the optional publishing-account profile when supplied.
6. The validator checks factual grounding, within-batch uniqueness, recent-history uniqueness, and X-post requirements.
7. For `drafts`, persist one `ArticleDraft(draft_type="x_post")` per accepted output. For `plan_items`, append items to the current date's plan without replacing planner-generated items.
8. In the same successful output transaction, append the usage-ledger record.
9. Mark the run `succeeded`, `partial`, or `failed`, including requested and created counts and concise exclusion reasons.

Existing `DailyPlan` regeneration must not delete rule runs, generated drafts, ledger entries, or appended rule items. The current planner endpoint's replace-all semantics therefore remain limited to planner-owned items; rule-generated plan items require an explicit origin field and separate append path.

## UI

The `/daily-plan` page gains two regions:

### Today's Work

Keep the existing planner items. Add rule-run cards showing rule name, requested and completed counts, status, source directory, output type, and delivery mode. A run expands to show selected assets, AI uniqueness explanations, exclusions, linked drafts or plan items, and job failure information.

### Creation Rules

Display a compact rule list with status, schedule, source, target count, and deduplication window. The primary action is `立即执行`; secondary actions are edit, enable or pause, and delete. The create/edit dialog validates directory existence, quantity bounds, target date or recurring schedule, lookback bounds, account availability, and delivery mode.

Deleting a rule requires confirmation, does not delete historical runs or drafts, and removes future scheduling only.

## Failure and Concurrency Behavior

- A database uniqueness constraint prevents duplicate scheduled runs.
- `Run now` is disabled while the same rule already has a queued or running explicit run.
- Candidate shortage produces `partial`, not failure.
- Missing directory, unavailable AI configuration, invalid structured output, or total persistence failure produces `failed` with a user-visible reason.
- Each output is persisted independently. A failure on item 7 does not roll back six already accepted drafts, and the run reports the exact partial count.
- Usage ledger insertion and its referenced output persistence share one database transaction.
- Pausing a rule prevents future scheduling but does not cancel an already running job.

## Security and Approval

Candidate and history tools are read-only. Draft or plan-item creation is authorized by the user when saving the rule with automatic delivery or when pressing `立即执行`. No rule can publish to X. MCP clients outside this product must still obtain approval for direct write-tool calls.

## Verification

- Model and migration tests cover rule, run, origin, and usage-ledger constraints.
- Service tests verify exact directory scoping, global lookback behavior, no full asset-body leakage, validated IDs, transactional ledger writes, and idempotent scheduling.
- AI flow tests use arbitrary directory names and counts to prove there are no `搞钱副业`, `10`, or `7` code branches.
- Tests cover fresh selection, semantic duplicate rejection, justified within-window reuse, insufficient candidates, within-batch duplicates, one revision, and partial completion.
- Route tests cover CRUD, pause, run now, invalid dates and bounds, missing directory, and preservation of history after rule deletion.
- UI tests cover one-time versus recurring fields, delivery mode, directory selection, status display, and linked output navigation.
- Live verification creates a temporary rule against a test directory, runs a small batch, inspects the ledger and drafts, and confirms a second run receives the first run's usage evidence.

## Out of Scope

- Automatic publishing to X.
- Calendar expressions beyond one-time or daily recurring execution.
- Embedding or vector-index infrastructure. This can later prefilter candidates before the same AI decision contract.
- Hard-coded rules for `搞钱副业` or any other named directory.
