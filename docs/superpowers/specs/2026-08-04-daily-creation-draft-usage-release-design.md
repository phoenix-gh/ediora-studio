# Daily Creation Draft Usage Release Design

## Goal

Deleting a draft created by `daily_creation` must immediately release its source asset from recent-use deduplication, while preserving the historical Agent run and its audit trail.

## Behavior

- The existing draft deletion endpoint remains the single entry point.
- Before deleting the draft, the endpoint deletes `ContentUsageLedger` rows whose `output_kind` is `draft` and whose `draft_id` matches the deleted draft.
- The usage deletion and draft deletion are committed in the same database transaction. A failure rolls back both changes.
- Deleting an ordinary draft remains unchanged because it has no matching usage row.
- `DailyCreationRun`, `ContentJob`, `AgentExecution`, and `DailyCreationOutputBatch` records are retained as immutable execution history. Their stored output IDs remain historical evidence and are not treated as active deduplication state.

## Data Flow

1. Load the requested `ArticleDraft`; return 404 if it does not exist.
2. Delete matching draft images using the existing behavior.
3. Delete matching `ContentUsageLedger` rows scoped by both `output_kind="draft"` and `draft_id`.
4. Delete the `ArticleDraft` and commit once.
5. Subsequent `get_recent_content_usage` calls no longer return the released usage, so an Agent may select the source asset again.

## Safety Boundaries

- Do not delete usage rows for other drafts, plan items, or other output kinds.
- Do not alter the creative asset itself.
- Do not delete or rewrite task execution and batch audit records.
- Preserve the current image-cleanup behavior.

## Verification

- A regression test creates a daily-creation draft and matching usage row, deletes the draft through the API, and asserts that both are gone while the run and output batch remain.
- A regression test deletes a normal draft and asserts that unrelated usage rows remain.
- Run the focused drafts router tests and the related daily-creation service tests.
