# Chat Workspace Layout Design

## Goal

Make the Chat page read as one coherent workspace by aligning the header,
conversation content, and composer to one shared content column.

## Root Cause

The message list and composer each independently apply `max-w-4xl`, but live in
different full-width parent containers. The composer also owns a separate page
background, border, and horizontal padding, so its visual boundary and left/right
edges do not match the conversation column.

## Design

The right-hand Chat pane remains a full-height flex column. Its header stays
full width to retain the page-level title. Inside the pane, both the scrollable
conversation and composer receive a shared `max-w-4xl` inner wrapper with the
same responsive horizontal padding.

The composer becomes a compact bottom action area within that shared column:
it retains its rounded input surface, but removes the competing full-width panel
appearance. A light top separator belongs to the pane; the composer itself is
visually connected to the conversation through identical alignment, background,
and spacing rhythm.

On narrow screens, the common wrapper uses smaller padding while preserving the
same column alignment. No session, API, stream, message, or Markdown behavior
changes.

## Validation

- Add a focused layout regression test for the shared wrapper class contract.
- Run frontend tests, TypeScript checking, and production build.
- Inspect the `/chat` route at desktop width; browser tooling is unavailable in
  this environment, so visual inspection will use the running development page
  and source-level layout checks.
