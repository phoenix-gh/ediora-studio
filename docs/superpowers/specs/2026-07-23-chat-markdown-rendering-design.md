# Chat Markdown Rendering Design

## Goal

Render assistant chat replies as readable Markdown while preserving the existing
streaming, tool-call cards, persisted message format, and no-login local-first
architecture.

## Scope

- Render text parts in assistant messages as Markdown, including headings,
  paragraphs, lists, quotes, links, tables, and fenced code blocks.
- Keep user messages as literal plain text bubbles.
- Keep tool-event and tool-audit cards unchanged.
- Treat raw HTML in Markdown as text rather than executable or rendered HTML.

## Design

Add a focused presentational Markdown component used by `MessageBubble` for
assistant text parts. It will use the already-installed Markdown dependency,
disable raw HTML rendering, and apply local prose/code/table styles that work in
both light and dark themes. Each streamed text part is rendered independently,
so partial responses remain visible while tokens arrive.

The component does not alter API payloads, persistence, session switching, or
the model tool loop. This keeps the change compatible with existing stored
plain-text messages and protects the existing tool activity UI.

## Safety and Failure Handling

Raw HTML is not inserted with `dangerouslySetInnerHTML`. Markdown links retain
normal browser handling and rendered output falls back to the literal text when
the parser cannot produce content. This prevents model or source content from
injecting executable markup into the chat page.

## Validation

- Add a component-level test proving assistant Markdown produces semantic
  heading/list/code/link output.
- Add a regression assertion that raw HTML is not rendered as an element.
- Run the focused test, full frontend tests, TypeScript checking, and production
  build.
