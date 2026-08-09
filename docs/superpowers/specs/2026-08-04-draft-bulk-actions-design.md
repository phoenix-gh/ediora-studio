# Draft Bulk Actions Design

## Goal

Add multi-select bulk actions to the draft inbox for deleting draft groups and creating covers or inline illustrations for several articles at once.

## Scope

- Selection is group-based. One row represents the root draft and all of its platform variants.
- Bulk selection applies only to draft groups visible under the current topic and status filters.
- Bulk cover and illustration jobs target only the group's `article` draft.
- A selected group without an `article` draft is reported as failed and remains selected.
- The existing single-draft editor, asset dialog, publishing flows, and backend APIs remain unchanged.

## User Interface

Each visible draft row remains a single clickable target. A normal click opens that draft in the editor and does not change bulk selection. Ctrl + click toggles that row in the bulk selection (with Cmd + click supported on macOS). There are no checkboxes. Selected rows use a distinct background color, while the active editor row keeps its existing left-border affordance.

A compact toolbar below the existing filters appears when drafts are available. It provides:

- Select all current results or clear the current selection.
- The selected group count.
- Bulk delete.
- Bulk cover generation.
- Bulk illustration generation.
- Cancel selection.

Changing either filter intersects the selection with the newly visible group IDs, so hidden drafts cannot be changed accidentally.

Bulk delete uses the existing confirmation dialog and states the number of groups that will be deleted. Bulk image actions use a dedicated dialog:

- Cover mode: one publish account, its default cover style, optional style overrides, and an optional instruction shared by every selected article.
- Illustration mode: one publish account, a per-article maximum of 1-4 images, and an optional instruction shared by every selected article.

While an operation is running, relevant controls are disabled and the dialog shows progress such as `3 / 12`. Completion reports the exact successful and failed group counts. Failed titles remain visible in the dialog.

## Architecture

The frontend orchestrates bulk work with the existing APIs:

- `deleteDraft(id)` for deletion.
- `regenerateCover(...)` for cover jobs.
- `illustrateBody(...)` for illustration jobs.

No batch endpoint, parent job type, schema migration, or task-state extension is introduced.

Bulk execution is isolated in a small utility that accepts group operations, runs no more than three concurrently, reports progress, and returns a per-group settled result. This keeps request scheduling and result accounting independently testable while the page component owns selection and presentation state.

The image-task dialog loads active publish accounts using the existing account API and uses the existing `CoverStyleEditor` and cover-style builder. Its submitted values match the current single-draft asset flow.

## Data Flow

1. The page derives visible groups from the existing topic and status filters.
2. Ctrl/Cmd + click actions store selected draft IDs in a `Set<number>` without changing the active editor selection.
3. A filter change removes IDs that are no longer visible.
4. Starting an image action resolves exactly one `draft_type === "article"` target per selected group.
5. The bounded runner submits up to three group operations at a time and emits completed/total progress.
6. Successful group IDs are removed from selection; failed group IDs remain selected.
7. The page refreshes drafts after deletion so partially completed deletion reflects backend truth.

## Deletion Semantics

Selecting a group for deletion means deleting the entire group. Within each group, platform variants are deleted first and the root draft is deleted last. Groups are processed through the bounded runner.

Frontend orchestration is not transactional. If deletion fails after some members were removed, the group is reported as failed, remains selected when it still exists, and the page reloads drafts from the server. The UI must not claim that a partially deleted group succeeded.

## Error Handling

- One failed group does not stop unrelated groups.
- Account-loading failures prevent image-task submission and show the existing toast error style.
- Groups without an article target fail locally without an API call.
- A bulk summary distinguishes complete success, partial success, and complete failure.
- Successful image-job submission means the asynchronous job was accepted; it does not claim that image generation has already finished.
- Repeated submission is disabled while the current bulk operation is running.

## Testing

Tests cover:

- Ctrl/Cmd + clicking individual rows selects them without changing the active editor draft.
- Normal clicking a selected row opens it without clearing or changing the bulk selection.
- Selected rows have the selection background and no checkbox is rendered.
- Selecting all visible results and clearing selection.
- Removing hidden IDs when filters change.
- Deleting every variant before its root.
- Refreshing after deletion and retaining failed selections.
- Resolving only article drafts for cover and illustration actions.
- Sharing one account and parameter set across all submitted image jobs.
- Rejecting groups without an article target.
- Enforcing a maximum concurrency of three.
- Removing successful selections while retaining failures.
- Preserving existing draft save, refresh, chat, asset, and publishing behavior through the current regression suite.

## Non-Goals

- Atomic multi-draft deletion.
- A backend batch API or persistent parent task.
- Per-draft settings inside one bulk run.
- Selecting drafts hidden by the current filters.
- Bulk publishing, status updates, or platform adaptation.
