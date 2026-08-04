# Creative Assets Article Editor UX Design

## Goal

Improve article editing in Creative Assets without changing the behavior of other Markdown editor consumers.

## Scope

- Show each article asset's update time in the article list as `更新于 YYYY-MM-DD HH:mm`, formatted in the browser's local time zone.
- Render article list items as compact two-line rows: a single-line title followed by the update time.
- Do not render article body excerpts or the redundant `文章` label in article rows.
- When an article has no saved title, use the first non-empty body line as its visible list title and remove a leading Markdown heading marker (`#` through `######`).
- Display `未命名文章` only when neither the saved title nor a usable body line exists.
- Open the Creative Assets Markdown editor in edit-only mode by default.
- Keep the editor's existing toolbar control available so the user can enable Markdown preview on demand.
- Save the currently selected article with `Ctrl+S` on Windows/Linux and `Cmd+S` on macOS.
- Prevent the browser's native save-page action when the article save shortcut is handled.
- Do not use the shortcut to submit the new-article dialog.
- Ignore repeated shortcut presses while an article save is already in progress.

## Design

`MarkdownEditor` will accept an optional initial preview-mode prop. Its existing default remains unchanged, while `ArticleAssetWorkspace` passes edit-only mode. This keeps the behavior scoped to Creative Assets and avoids changing the draft editor.

`ArticleAssetWorkspace` will format and render `updated_at` below each article title. Invalid or missing timestamps will not render misleading text.

Article rows will use compact `px-4 py-3` spacing. The first line contains only the truncated display title, and the second line contains the muted update time. The display title prefers the trimmed saved title, then the first non-empty body line with a leading Markdown heading marker removed, then `未命名文章`. Later body lines never appear in the list. Existing selected and hover states remain unchanged so density changes do not alter navigation feedback.

`AssetsClient` will register a window-level keyboard listener while mounted. The listener will recognize `Ctrl/Cmd+S`, skip handling when the new-article dialog is open, prevent the browser default, and call the existing selected-article save function. The existing saving guard remains the single source of truth for duplicate prevention.

## Error Handling

Shortcut-triggered saves use the current save path and therefore retain the existing inline error message and server-response merge behavior. No new persistence path is introduced.

## Verification

Tests will prove that:

- article rows render a locally formatted update time;
- article rows omit body excerpts and the `文章` label, use compact spacing, prefer the saved title, and otherwise use only the first non-empty body line without its Markdown heading marker;
- empty titles and bodies fall back to `未命名文章`;
- the Creative Assets editor requests edit-only initial mode while other callers keep the existing default;
- `Ctrl+S` and `Cmd+S` save the selected article and prevent the browser default;
- the shortcut does not submit the new-article dialog or issue duplicate requests while saving;
- existing Creative Assets tests continue to pass.
