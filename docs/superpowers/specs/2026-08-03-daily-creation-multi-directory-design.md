# Daily Creation Multi-Directory Rules Design

## Goal

Allow one daily creation rule to draw candidates from multiple creative-asset directories of the same asset type. Preserve existing single-directory rules and historical run snapshots without requiring manual migration.

## Product Behavior

- A rule keeps one `asset_type`: `article` or `media`.
- The user selects one or more directories belonging to that asset type.
- Switching the asset type clears the selected directories so a rule cannot mix article and media directories.
- Candidate assets from all selected directories form one combined pool. The pool is deduplicated by asset ID, sorted with the existing candidate ordering, and bounded by the existing limit. There is no per-directory quota.
- AI selection, global semantic deduplication, partial completion, delivery mode, scheduling, and account behavior remain unchanged.
- Rule cards and run details display a readable comma-separated directory summary.

## Data Compatibility

Add `DailyCreationRule.directories` as a JSON array of strings. Keep the existing `directory` column during the compatibility period.

- New and updated rules write `directories` and also mirror the first selected directory into `directory` for older code and rollback compatibility.
- Existing rows with an empty or missing `directories` value are read as `[directory]`.
- New run snapshots contain `directories` and the mirrored `directory` value.
- Historical snapshots containing only `directory` are read as a single-directory list.
- The database initialization migration adds the JSON column idempotently and backfills each non-empty legacy `directory` as a one-element JSON array.

No association table is introduced because directories are immutable rule input values in the current single-user product and do not need relationship metadata.

## API Contract

Creation and replacement payloads use `directories: string[]` with 1–50 unique, non-blank directory names. During the compatibility period, a payload that omits `directories` may provide the legacy non-empty `directory`, which is normalized to a one-element list. Patch requests may update `directories` independently; if both fields are present, `directories` is authoritative.

The API:

1. trims directory names;
2. removes duplicates while preserving user order;
3. verifies every directory exists for the selected or existing `asset_type`;
4. rejects an empty selection, unknown directories, or directories belonging to another asset type;
5. revalidates existing directory selections when `asset_type` changes.

Responses expose `directories` and retain `directory` during compatibility. Existing clients that only read `directory` continue to receive the first selected directory.

## Candidate and Persistence Flow

The daily creation service accepts a directory list. Candidate loading uses one database query with `CreativeAsset.directory.in_(directories)`, preserves the existing compact candidate response, orders once across the combined pool, and applies one overall limit.

The MCP candidate tool accepts `directories`. A legacy `directory` argument remains temporarily supported and is normalized to a one-element list. The worker sends `directories` from the run context.

Before persisting an output, the service verifies that the selected asset type matches the snapshot and its directory is included in the normalized snapshot directory list. An asset from any selected directory is valid; all others fail closed.

## Frontend

`CreationRuleDialog` replaces the single `<select>` with an accessible checkbox list scoped to the selected asset type. It shows the selected count and requires at least one directory. Editing a legacy rule initializes the checkbox state from `directories`, falling back to `directory`.

The rule and run panels use a shared display convention: join up to three directory names with `、`; when more are selected, append `等 N 个目录`.

## Error Handling

- Empty selection: `请选择至少一个素材目录`.
- Unknown or cross-type directory: HTTP 400 with the offending directory name.
- A historical rule whose legacy directory no longer exists remains readable, but saving it requires selecting a valid directory.
- Worker snapshots with neither a valid `directories` array nor a non-empty legacy `directory` fail explicitly rather than querying all assets.

## Testing

- Schema and migration tests cover legacy backfill and idempotency.
- Service tests cover merged candidates, global limit/order, duplicate directory normalization, and allowed/forbidden output assets.
- Router tests cover create, patch, cross-type rejection, legacy response compatibility, and run snapshots.
- MCP and worker tests verify directory arrays are passed through the entire execution path.
- Frontend tests verify multi-select submission, edit hydration, type-switch clearing, validation, and directory summaries.
- Existing single-directory fixtures remain valid through compatibility normalization until they are deliberately migrated.

## Out of Scope

- Mixing article and media directories in one rule.
- Per-directory candidate quotas or weighting.
- Recursive inclusion of descendant directories.
- Directory permissions or rule-directory relationship metadata.
