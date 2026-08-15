# Remove Draft Adaptations Design

Date: 2026-08-04
Status: Approved in conversation; pending written-spec review

## Goal

Remove the draft adaptation/version model from Ediora. Every draft becomes an independent record. `draft_type` remains only as a publishing-platform marker and must not imply parent/child relationships or restrict image generation.

## Scope

### Remove

- The `article_drafts.linked_draft_id` database column.
- Existing adapted child drafts. The current local database has two such rows, IDs 11 and 60; the migration must delete every row where `linked_draft_id IS NOT NULL` rather than hard-code IDs.
- Backend model and API fields for `linked_draft_id`.
- MCP logic that resolves a child draft to a root draft.
- Frontend draft grouping, variant tabs/badges, variant switching, main-version synchronization, and the “适配平台” creation menu.
- Group-specific bulk deletion and article-main-version lookup.

### Keep

- `draft_type` as an independent draft's publishing-platform marker.
- Existing supported platform markers: `article`, `x`, `mp`, `bili`, and `xhs`.
- Draft selection, editing, publishing, image assets, and bulk operations.
- Existing parent drafts and all drafts that are already independent.

## Data Migration

The migration runs in this order:

1. Delete all rows in `article_drafts` whose `linked_draft_id` is not null.
2. Normalize independent draft rows from `draft_type = 'x_post'` to `draft_type = 'x'`.
3. Rename `draft_images.root_draft_id` to `draft_images.draft_id`; existing images remain attached to the former root draft.
4. Drop the `linked_draft_id` column.

The migration must be idempotent under the repository's existing startup migration model. It must work for both PostgreSQL and SQLite where the project supports them. It must not delete parent drafts or unrelated independent drafts.

## Backend Contract

`ArticleDraft`, `ArticleDraftOut`, `ArticleDraftCreate`, and `ArticleDraftUpdate` no longer expose `linked_draft_id`. `DraftImage` stores `draft_id` instead of `root_draft_id`. Draft image lookup, upload, and publishing operate on the requested draft ID directly.

MCP and router helpers must stop resolving a “root” draft. Any code that needs images or content uses the explicit draft ID supplied by the caller.

`draft_type` remains a string in persisted data for compatibility, but all application-owned writers must use the canonical values defined above. Daily creation must write `x`, not `x_post`.

## Frontend Behavior

The drafts sidebar renders a flat list of individual drafts. Each row has its own selection checkbox and platform badge. Unknown `draft_type` values must display the raw value or an explicit unknown label; they must never silently appear as “文章”.

The editor removes:

- Platform-version tabs.
- “适配平台”.
- “同步主版本内容”.
- Any messaging about a main article or platform versions.

The image library uses the selected draft ID directly.

## Bulk Operations

Bulk selection is per visible draft, not per group. “全选当前结果” selects every draft in the current filtered result. Changing filters removes hidden selections.

- Bulk delete deletes each selected draft exactly once, with concurrency limited to three. Successful items are removed from selection; failures remain selected. The list is refreshed once after all operations settle.
- Bulk cover sends every selected draft directly to `/studio/regenerate-cover`, regardless of `draft_type`.
- Bulk illustrations sends every selected draft directly to `/studio/illustrate-body`, regardless of `draft_type`.
- Bulk image success and failure semantics remain unchanged: successes are deselected and failures remain selected with their reason.

`draft_type` is metadata for publishing suitability only. It is not an eligibility gate for cover or illustration generation.

## Error Handling

- The destructive migration is explicit and tested: adapted child rows are deleted before the column is dropped.
- API requests containing the removed field must not silently recreate adaptation behavior. Normal response-model extra-field behavior may ignore stale clients, but application code will no longer send the field.
- Unknown platform markers remain visible as unknown values instead of being mislabeled.
- Partial bulk-operation failures retain only failed draft selections and present the existing per-item reasons.

## Testing

### Backend

- PostgreSQL/SQLite migration coverage proves adapted children are removed, parents survive, `x_post` becomes `x`, `root_draft_id` becomes `draft_id`, and `linked_draft_id` no longer exists.
- Draft router contract tests prove create/update/read responses no longer depend on the removed field.
- Daily creation tests expect canonical `draft_type = 'x'`.
- Image route and MCP tests use the explicit draft ID.

### Frontend

- Drafts render as a flat list with one checkbox per draft.
- The “适配平台” entry, variant tabs, and main-version synchronization are absent.
- Existing platform markers render correctly, including canonical `x`.
- Unknown markers are not labeled as “文章”.
- Bulk cover and illustrations submit selected `x` and `article` drafts directly.
- Bulk delete deletes each selected draft once and preserves partial-failure selections.

### Verification

- Run focused backend and frontend tests.
- Run the full frontend test suite and production build.
- Run relevant backend tests using the repository's configured Python environment.
- Use rendered browser QA for flat selection, batch dialogs, and the absence of adaptation UI.

## Non-goals

- Removing `draft_type`.
- Deleting independent `x`, `mp`, `bili`, or `xhs` drafts.
- Redesigning publishing flows.
- Adding a replacement relationship or versioning system.
- Migrating adapted child content into parent drafts; the user explicitly chose deletion.
