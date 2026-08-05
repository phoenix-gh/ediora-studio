# Intelligence Station: Content Value Triage and Editorial Handoff

Date: 2026-08-05  
Status: Design approved in conversation; pending written-spec review

## Summary

Replace the current “待响应” action inbox with an “情报站” focused on content intelligence rather than social replies. The station collects X and YouTube items, shows the original source beside an AI editorial assessment, classifies each item, and routes it to either an article draft seed, a reusable creative asset, or no further processing.

The product must keep the original source visible. AI output is an advisory evaluation layer and must never replace, silently rewrite, or obscure the source material.

The design borrows the useful part of [QMReader](https://rss.qiaomu.ai/): source-oriented reading, preserved original material, AI-assisted interpretation, and durable content assets. It does not copy QMReader’s public contribution, annotation, or comment-community model.

## Goals

1. Make the primary user decision “is this worth putting into my content system?”, not “should I reply to this post?”.
2. Let the user inspect the full original source and AI evaluation at the same time.
3. Separate content type classification from content destination.
4. Reuse the existing article draft and creative asset systems instead of creating a parallel content repository.
5. Preserve source traceability, AI-evaluation snapshots, evidence, and risks when material is handed off.
6. Keep the workflow lightweight and suitable for a single-user self-hosted installation.

## Non-goals

- No comment, reply, quote-reply, or social-response generation in the new workflow.
- No automatic full-article generation when an item is marked worth writing.
- No automatic publishing to X, WeChat, Blog, or any other platform.
- No generic Todo features such as deadlines, subtasks, projects, reminders, or assignees.
- No public contribution, community discussion, public profile, or shared-asset layer.
- No replacement of the existing `/drafts` or `/assets` workspaces.
- No requirement to physically delete historical comment-related database rows in the first product migration; legacy records must not appear as new UI choices or AI outputs.

## Product vocabulary

### Item lifecycle

`workflow_status` remains the analysis pipeline state:

```text
queued -> processing -> ready
                   \-> failed
```

`disposition` is the user-facing content decision:

```text
pending | worth_writing | creative_asset | not_processed
```

`pending` means the analysis may be ready but the user has not made a destination decision. It is not the same as an analysis job being queued.

### Content types

The first release uses a small, editable taxonomy:

- `tool`: product, software, service, or workflow tool;
- `industry_update`: company, market, policy, or ecosystem change;
- `case`: a concrete implementation, example, experiment, or outcome;
- `tutorial`: a how-to, method, or step-by-step explanation;
- `research`: paper, benchmark, technical report, or structured investigation.

The AI proposes one or more types. The user can change them. Types are tags and filters, not mutually exclusive workflow states.

### Content destinations

- `worth_writing`: there is a clear editorial angle and the user intends to create content around it;
- `creative_asset`: the source is worth preserving for later reuse, but there is no immediate writing decision;
- `not_processed`: the item is low-value, redundant, stale, or outside the current content direction.

There is deliberately no “值得跟踪” or “资料收藏” destination in this release.

## Information architecture

### Navigation

Rename the sidebar entry and page title from “待响应” to “情报站”. Keep `/responses` as the primary route. Keep `/x-responses` as a compatibility redirect to `/responses?source_type=x_post`; there is no separate X response inbox in the new UI.

The left rail contains:

```text
情报站
  待判断
  值得写
  创作资产
  暂不处理

来源
  全部
  X
  YouTube
```

The counts are server-provided filtered counts. Content-type filters (`工具`, `行业动态`, `案例`, `教程`, `研究`) and search remain available above or below the list without becoming additional workflow states.

### List

The primary sort is descending AI content-value score, with a user option for newest-first. Each decision-summary card shows:

- content-value score;
- disposition (`待判断`, `值得写`, `创作资产`, `暂不处理`);
- source title;
- source type, source name, and relative/absolute time;
- content-type tags;
- one concise AI editorial judgment.

The list must remain scannable. It does not contain full source text or a full AI report.

### Detail workbench

The detail view uses a source-first 60/40 split:

- approximately 60% for the original source;
- approximately 40% for the AI evaluation and decision controls.

Both panes remain visible on desktop. On narrow screens they stack in source-first order rather than replacing one another with tabs.

#### Original source pane

The original pane contains:

- source title, author/channel, source type, publication time, and source URL;
- full original X content, article body, or YouTube transcript when available;
- an independently scrolling reading area;
- an explicit “打开原文” action;
- source language and transcript metadata where applicable.

The original text is read-only in this workflow. AI summaries, classifications, and evidence references must not be rendered as replacements for the original. Evidence references may point to source locations or quote bounded snippets, but they must be visibly labeled as AI analysis.

#### AI editorial assessment pane

The first screen of the evaluation pane contains:

- content-value score (`0-100`);
- recommended disposition;
- recommended content types;
- “why this matters / why it is worth writing”;
- evidence list;
- risks and verification notes;
- suggested editorial angle.

Additional value dimensions and historical analysis versions are expandable. The first release should prioritize an editorial decision over a long report.

The evaluation pane contains no comment, reply, quote, or social-response controls.

## AI evaluation contract

The analysis worker should produce a structured evaluation with at least:

```json
{
  "content_value_score": 86,
  "value_dimensions": {
    "novelty": {"score": 82, "reason": "..."},
    "practicality": {"score": 91, "reason": "..."},
    "credibility": {"score": 78, "reason": "..."},
    "writing_space": {"score": 88, "reason": "..."},
    "evergreen_value": {"score": 84, "reason": "..."}
  },
  "summary_cn": "...",
  "core_thesis": "...",
  "value_points": ["..."],
  "risks": ["..."],
  "verification_items": ["..."],
  "recommended_content_types": ["tool", "tutorial"],
  "recommended_disposition": "worth_writing",
  "recommendation_reason": "...",
  "suggested_angle": "...",
  "target_reader": "...",
  "evidence": [{"text": "...", "source": "...", "type": "fact"}]
}
```

`writing_space` replaces the old response-oriented discussion value. The implementation may preserve the old database column temporarily for migration compatibility, but new analysis must not ask the model to optimize for comments or replies.

The server validates the score range, exact dimension set, content-type values, disposition values, evidence shape, and source attribution before persisting the analysis. The user may override AI-recommended types and disposition.

## User actions and dialogs

### Mark as worth writing

The user clicks `值得写`, then confirms in a standard centered dialog (not a drawer). The dialog shows:

- suggested title;
- target destination: article draft;
- fields that will be carried in;
- explicit statement that the result is a draft and will not be published automatically.

Confirmation creates a structured article-draft seed in the existing draft system:

- `topic_id = response:{response_item_id}`;
- `draft_type = article`;
- `status = drafting`;
- suggested title;
- Markdown seed containing the core thesis, value points, suggested structure, target reader, risks, and verification notes;
- source entries containing the original URL, source title, and attribution note.

The seed is editable in `/drafts`. It does not call a full-article generation flow.

### Save as creative asset

The user clicks `创作资产`, then confirms in the same dialog pattern. The dialog shows:

- destination: article-type creative asset;
- selected article-asset directory, if available;
- what will be saved;
- explicit statement that no article draft will be created.

The asset stores an original snapshot and an AI-evaluation snapshot:

- source title, author, URL, and publication time;
- original body/transcript snapshot or a durable source reference according to source availability;
- AI summary, value score, types, evidence, risks, and suggested angle;
- source and intelligence tags;
- `source = response`.

The asset is opened from the existing `/assets` workspace. Future source changes must not silently overwrite the saved evaluation snapshot.

### Mark as not processed

`暂不处理` is a direct disposition action. It records a user event and keeps the item in history. It does not delete the source, analysis, or evidence. A reset action returns the item to `pending`.

## Backend and API direction

### Reuse

Reuse the existing source-neutral response models and durable analysis jobs:

- `ContentResponseItem` for source identity and disposition;
- `ContentAnalysisRun` for immutable analysis versions;
- `ContentAccountScore` only if account-fit analysis remains useful for future editorial routing;
- `ContentResponseEvent` for user actions and destination creation;
- existing `ArticleDraft` and `CreativeAsset` persistence for handoff.

### Changes

1. Replace the user-facing decision values with `pending`, `worth_writing`, `creative_asset`, and `not_processed`, with an explicit migration for existing unified items.
2. Add durable destination linkage to the response item, such as `destination_type` and `destination_id`, or equivalent typed nullable links. The link is required for idempotent dialogs and for showing the resulting draft/asset in the detail pane.
3. Extend response detail payloads with a source object containing the full original content needed by the UI. List payloads must remain summary-only.
4. Add content-type filters and return counts for disposition/source filters.
5. Add an idempotent destination endpoint for dialog confirmation. The endpoint must verify the current analysis run, create or return the existing draft/asset, update disposition, write an event, and return the destination link.
6. Remove comment-oriented output types from the new worker contract and UI. Existing historical rows can remain read-only during the first migration.
7. Do not enqueue a `content_response_output` AI generation job for the initial `worth_writing` handoff. Creating the structured seed is a deterministic persistence operation using the already stored analysis.

Suggested destination request:

```json
POST /api/responses/{id}/destination
{
  "destination": "draft",
  "analysis_run_id": 123,
  "directory": null
}
```

The response contains the updated item and a typed destination reference. Repeating the same request returns the existing destination instead of creating a duplicate.

## State and migration rules

For existing unified response items:

| Existing state | New state | Rule |
| --- | --- | --- |
| `pending` | `pending` | No user decision yet |
| `adopted` | `worth_writing` | Preserve historical adoption intent |
| `rejected` | `not_processed` | Preserve negative decision |
| `later` | `pending` | There is no tracking destination in the new model |

Existing analysis versions and event history remain. Existing comment-related output rows are historical and are not shown as available new output choices. The first rollout should avoid destructive deletion of those rows; a separate cleanup migration can be proposed after the new flow is stable.

## Failure handling and safety

- Analysis failure: show `failed`, preserve the source, show a retry action where the current UI can safely expose it, and do not allow destination creation without a successful current analysis.
- Missing source body: show available metadata and an original-link action; do not fabricate source content. The item can remain pending until the source is available.
- Stale analysis: destination creation must include and verify `analysis_run_id == current_analysis_run_id`.
- Duplicate dialog submission: use the item/analysis/destination identity as an idempotency boundary and return the existing draft or asset.
- Destination persistence failure: leave the item pending and keep the dialog retryable; do not claim the handoff succeeded.
- Source and AI pane race: preserve the existing selected-response and creation-session identity checks so list refreshes cannot cause a destination to be created for another item.
- Publishing: no destination action invokes a platform publish API.

## Testing and acceptance

### Backend

- Validate the new analysis schema and reject comment-oriented output fields in new worker payloads.
- Test disposition transitions, reset, event payloads, and migration from the four old unified decision values.
- Test full-source detail payloads for X and YouTube without adding source bodies to list responses.
- Test content-type filtering, disposition counts, value-score sorting, and newest sorting.
- Test destination creation for article draft and creative asset, including directory selection, source/evaluation snapshots, idempotency, and stale analysis rejection.
- Test that no new comment/reply/quote output job is created.

### Frontend

- Test the “情报站” navigation and `/x-responses` compatibility redirect.
- Test the left status/source filters and value-score list ordering.
- Test decision cards and content-type tags.
- Test the 60/40 source-first detail layout contract: full original and AI evaluation are both rendered; neither is replaced by a tab-only view.
- Test the standard confirmation dialog, cancellation, destination success, destination failure, and duplicate-click behavior.
- Test that `值得写` creates/opens a structured draft seed and `创作资产` opens the existing article asset with both snapshots.
- Test that no comment/reply/quote controls or output labels are rendered.

### End-to-end

Exercise one X item and one YouTube item through:

```text
source -> analysis ready -> pending
      -> worth writing -> dialog -> structured draft seed
      -> creative asset -> dialog -> original/evaluation asset
      -> not processed -> history
```

Confirm that no external publishing call occurs and that the original source remains accessible after each handoff.

## Open implementation decisions for the plan

These are intentionally deferred to the implementation plan, not product ambiguity:

- exact database link fields for draft/asset destinations;
- whether the source snapshot is stored inline or represented by a durable source-reference record when it is very large;
- exact Markdown headings for the structured draft seed;
- whether legacy comment tables/columns are cleaned in the same migration or retained until a later cleanup;
- how source-type-specific transcript/source payloads are normalized in TypeScript.

## Success criteria

The feature is successful when a user can process an incoming item in one screen, see the original and AI evaluation together, make one of three clear destination decisions, and reliably find the result in the existing draft or creative-asset workspace without any comment-generation or automatic-publishing behavior.
