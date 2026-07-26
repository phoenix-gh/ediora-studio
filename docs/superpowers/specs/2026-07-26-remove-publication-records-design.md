# Remove Publication Records Design

## Goal

Remove the unused publication-record management layer completely while
preserving every user-facing draft publishing capability.

The removed layer is the sidebar "发布" page used to list publication records,
mark them as published, and manually enter performance statistics. It does not
include the draft publishing dialog or publish-account profiles.

## Scope

### Remove

- The `/published` Next.js page and its client component.
- The sidebar "发布" navigation item.
- The frontend publication-record API client.
- All `/api/published-articles` backend routes.
- The MCP `get_recent_performance` tool backed by publication records.
- The `PublicationCreate`, `PublicationUpdate`, and `PublicationOut` schemas.
- The SQLAlchemy `Publication` model.
- Automatic creation or update of a publication record after a successful
  WeChat draft upload.
- The `publications` database table and all historical rows.
- Tests and README text that describe the removed record-management layer.

### Preserve

- The draft-box "发布" button and unified publishing dialog.
- Publishing drafts to the WeChat draft box.
- Copying X long-form content for manual publishing.
- Submitting drafts to the configured Blog service.
- Publish-account profiles, credentials, voice/style settings, and account
  selection throughout creation workflows.
- Draft statuses, draft data, writing plans, content jobs, assets, and actual
  platform-side content.
- Information-source timestamps and fields named `published_at`; these describe
  external source items and are unrelated to publication records.
- Historical design and implementation documents under `docs/superpowers`.

## Architecture

### Database cleanup

Add an idempotent startup migration that executes:

```sql
DROP TABLE IF EXISTS publications
```

The migration runs before `Base.metadata.create_all`. Removing the
`Publication` model ensures metadata creation cannot recreate the table.
Running startup repeatedly remains safe on SQLite and PostgreSQL.

The deletion is intentionally destructive and includes all historical
publication statistics, as approved. No archive or compatibility view is kept.

### Backend cleanup

Remove the `published` router from the application and delete its CRUD module.
Remove its request/response schemas, model, and the MCP performance-query tool
that reads the same records.

The WeChat publishing endpoint currently performs two actions:

1. Upload the rendered article into the WeChat draft box.
2. Best-effort create or update a local `Publication` row.

Only the second action is removed. After a successful WeChat API response, the
endpoint still returns the `media_id` exactly as before. WeChat failures retain
their existing error behavior.

### Frontend cleanup

Delete the publication-record page, client component, and API module. Remove
the sidebar item and its now-unused icon import. No replacement page or redirect
is introduced; `/published` becomes a normal Next.js 404.

The draft publishing dialog and its WeChat, X, and Blog tabs are unchanged.

## Data Flow After Removal

```text
Draft
  -> publish dialog
  -> WeChat / X copy / Blog
  -> platform result
```

There is no longer a local publication-record write or a performance-statistics
feedback path.

## Error Handling

- Database cleanup is safe if the `publications` table does not exist.
- Removing the local record write eliminates the previous non-fatal
  "publication record write failed" warning path.
- Actual WeChat and Blog request errors continue to surface through their
  existing endpoint behavior.
- Removed backend endpoints and the removed frontend page return 404.

## Verification

- Migration tests prove that `publications` is dropped, existing rows are
  deleted, and repeated migration calls succeed.
- Backend route tests prove `/api/published-articles` is no longer registered.
- WeChat publishing tests prove a successful upload still returns its
  `media_id` without writing a publication record.
- Frontend source/layout tests prove the sidebar item and `/published` runtime
  files are gone.
- Full backend and frontend tests pass.
- Next.js type generation, TypeScript checking, and production build pass.
- Runtime checks confirm:
  - `/published` returns 404.
  - `/api/published-articles` returns 404.
  - the draft page and retained publishing endpoints remain available.
