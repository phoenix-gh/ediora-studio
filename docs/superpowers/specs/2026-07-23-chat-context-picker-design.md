# Chat Context Picker Design

## Goal

Replace the Chat composer's two permanent native selects with one compact
Codex-style “添加上下文” entry. The entry lets a user add one local skill and one
article draft without reducing the message editing area.

## Interaction

The composer shows a small “添加上下文” button beside its secondary controls. On
click it opens a popover with two actions:

- **技能** opens an in-place searchable skill list. The user selects one skill
  or clears the active skill. The list continues to use automatic
  `skills/*/SKILL.md` discovery.
- **草稿** opens a modal dialog. It contains a focused search field and filters
  the existing draft summaries by title as the user types. Selecting one closes
  the dialog and returns focus to the composer context area.

The composer displays each current selection as a compact chip with an `×`
control. Chips and the add-context entry sit inside the same bordered composer
surface, above the text area; the text area and send button remain on the lower
row. Removing a chip immediately clears only that selection. One skill and one
draft remain the maximum context for a Chat turn.

## State and Accessibility

The existing `skillName` and `draftId` state remain the sole selection state.
No draft body is added to the browser. New conversation clears both values;
opening, closing, searching, or cancelling a picker does not clear a prior
selection.

The popover and modal use semantic buttons, labels, keyboard focus, and Escape
to close. While a response is streaming, the add entry, both chip removal
controls, and picker choices are disabled.

## Scope

This changes only the composer interaction and presentation. Skill discovery,
server-side draft loading, request serialization, model instruction context,
and the read-only Chat tool boundary are unchanged.

## Validation

- Source/UI tests cover the one add-context entry, picker actions, chip removal,
  and existing serialized `skillName`/`draftId` values.
- Run TypeScript, the complete frontend test suite, and a production build.
- Verify the running `/chat` UI opens the skill list and draft search dialog,
  selects a result, and renders removable chips.
