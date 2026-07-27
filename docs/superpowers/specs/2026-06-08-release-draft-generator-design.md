# Release Draft Generator — Design Spec

**Date:** 2026-06-08  
**Status:** Approved

## Overview

When the GitHub scheduler detects that the latest release of a tracked repo has no draft yet, it automatically calls an LLM to generate one or two `ArticleDraft` records (tech-facing and/or product-facing) with fine-grained `[TODO: ...]` annotations embedded at each changed feature. Drafts land in the existing `/drafts` page for editing.

---

## Data Model Changes

### `GithubRelease` — add one column

```python
draft_generated_at: Mapped[datetime | None]  # None = not yet generated; set after generation (or intentional skip)
```

Used for idempotency. Once set, the scheduler never re-processes this release.

### `GithubRepo` — add two columns

```python
release_draft_enabled: Mapped[bool]   # default True; owner can turn off per-repo
release_draft_types: Mapped[list]     # JSON, default ["tech", "product"]; can be ["tech"] or ["product"]
```

### `ArticleDraft` — no schema changes

Existing fields are sufficient:

| Field | Value |
|---|---|
| `topic_id` | `"release:{owner}/{repo}:{tag}"` |
| `draft_type` | `"article"` |
| `title` | `"[tech] {repo} {tag} 发布解读"` or `"[product] {repo} {tag} 更新亮点"` |
| `content` | Generated markdown with inline `[TODO: ...]` lines |
| `sources` | `[{"url": html_url, "title": tag_name}]` |
| `status` | `"drafting"` |

---

## New Module: `release_drafter.py`

### `generate_release_drafts(release, repo, db) -> int`

Generates drafts for a single release. Returns number of drafts created (0, 1, or 2).

Steps:
1. Build context: `release.body` (changelog markdown) + repo name + tag + `html_url`
2. Call `llm.generate_release_article(context, draft_types)` — one LLM call, returns JSON with requested draft type(s)
3. For each draft type, assemble markdown: heading → content → inline `[TODO: ...]` lines per section
4. Write `ArticleDraft` rows (skip if `topic_id` already exists — belt-and-suspenders idempotency)
5. Set `release.draft_generated_at = now()` and commit

### `generate_pending_drafts(db) -> int`

Called by scheduler. Iterates enabled, non-muted repos; for each, fetches its single latest release. If `draft_generated_at IS NULL`, calls `generate_release_drafts`. Returns total drafts created.

**Skip logic for old releases:** If the latest release's `published_at` is older than 30 days, mark `draft_generated_at = now()` without generating (prevents flooding on first run with repos that have old releases).

---

## LLM Function: `llm.generate_release_article()`

### Input

```python
{
  "repo": "owner/repo",
  "tag": "v1.2.3",
  "release_name": "Release 1.2.3",
  "html_url": "https://github.com/...",
  "body": "... changelog markdown ...",
  "draft_types": ["tech", "product"]
}
```

### Output (JSON)

```json
{
  "tech": {
    "title": "[tech] repo v1.2.3 发布解读",
    "sections": [
      {
        "heading": "## 核心变更：xxx",
        "content": "...",
        "todos": [
          "[TODO: 截图 - 对比旧版 API 签名 vs 新版签名]",
          "[TODO: 录制 GIF - xxx 功能完整操作流程]"
        ]
      }
    ]
  },
  "product": {
    "title": "[product] repo v1.2.3 更新亮点",
    "sections": [...]
  }
}
```

### Prompt constraints
- `[TODO: ...]` must be **specific** to each change point — infer the exact screenshot/recording needed, never write generic "补充截图"
- If `body` is empty: generate a one-paragraph stub noting no changelog is available, add `[TODO: 访问 {html_url} 查看完整 changelog]`
- Prerelease: prefix title with `[pre]`, add a callout block noting it's a pre-release and may be unstable
- Output must be valid JSON; no markdown fences wrapping the JSON

---

## Scheduler Integration (`scheduler.py`)

In `scheduled_github()`, after `collect_all_repos()`:

```python
from release_drafter import generate_pending_drafts
draft_count = await generate_pending_drafts(bg_db)
# Append to log message: "草稿 +{draft_count}"
```

Draft generation errors are caught per-repo and logged as warnings — they never block the collection run.

---

## Frontend Changes

### Releases tab — draft badge

Each release card gets a small green badge `草稿已生成` when `draft_generated_at` is not null. Badge links to `/drafts` (no query filter — the generated drafts have distinctive `[tech]` / `[product]` prefixed titles and appear near the top of the list).

This requires:
- `GithubReleaseOut` schema to expose `draft_generated_at`
- The badge rendered in `ReleasesTab` in `GithubClient.tsx`

### Repo settings drawer — draft config

In the existing repo edit form, add:
- Toggle: `生成发布稿`（maps to `release_draft_enabled`）
- Checkbox group: `草稿类型` — `技术向` / `产品向`（maps to `release_draft_types`）

PATCH endpoint (`/github/repos/{owner}/{repo}`) already exists; extend `GithubRepoUpdate` schema with the two new fields.

### Drafts page

No changes. Drafts with `topic_id` prefix `release:` appear naturally in the list.

---

## Database Migration

Two `ALTER TABLE` statements (no migration framework):

```sql
ALTER TABLE github_releases ADD COLUMN draft_generated_at TIMESTAMPTZ;
ALTER TABLE github_repos ADD COLUMN release_draft_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE github_repos ADD COLUMN release_draft_types JSONB NOT NULL DEFAULT '["tech","product"]';
```

---

## Out of Scope

- Manual "generate draft" button per release (auto-only)
- Retry queue for failed LLM calls (scheduler retries on next run naturally)
- Draft preview inside the Releases tab (drafts live in `/drafts`)
- Notifications / push alerts when drafts are ready
