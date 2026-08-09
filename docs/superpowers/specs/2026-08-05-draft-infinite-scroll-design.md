# Draft inbox incremental loading

The draft inbox must not transfer every draft before it can render. It will load
the newest 50 drafts, then automatically append the next page when the list
reaches its end.

`GET /write/drafts` remains the compatibility endpoint for existing consumers.
The inbox uses a new cursor endpoint which accepts the active status and topic
filters. Results are ordered by `updated_at DESC, id DESC`; the cursor records
both values so entries cannot be duplicated or skipped when timestamps match.

Changing either filter clears the batch selection and replaces the loaded list
with the first matching page. Batch actions therefore operate only on entries
currently loaded for the active result set. A manual refresh or creating a draft
also replaces the list with its first page.

