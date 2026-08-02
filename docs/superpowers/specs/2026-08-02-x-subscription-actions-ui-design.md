# X Subscription Actions UI Design

## Problem

The X subscription management dialog renders every available action inline for each subscription. A timeline subscription can expose edit, instant response, asset ingestion, AI screening, enablement, collect, backfill, and delete controls at the same time. These controls consume the row width, squeeze subscription metadata, and deform the layout at ordinary laptop and narrow dialog widths.

## Goal

Keep the high-frequency collect action immediately available while making each subscription row stable, readable, and responsive. Preserve every existing operation and backend behavior.

## Row Structure

Each subscription uses one consistent three-part row:

1. A flexible information region containing the source icon, label, type, query or URL, post count, last collection time, asset-ingestion rule count, and error state.
2. A compact enablement switch with an accessible label.
3. A fixed action cluster containing the primary `采集` button and a `更多操作` menu trigger.

The information region may wrap internally. The action cluster never participates in that wrapping and must not be compressed by long URLs, queries, labels, or errors.

## Action Hierarchy

`采集` is the only visible button because it is the confirmed high-frequency operation.

The overflow menu contains actions in this order:

- 编辑 or 重命名
- 即时响应开关, for timeline subscriptions only
- 素材入库
- AI 筛选入库
- 回溯采集, for timeline subscriptions only
- A separator
- 删除订阅, styled as destructive

Search subscriptions omit timeline-only actions. Existing dialogs and inline edit behavior remain unchanged after an action is selected.

## Interaction States

- While a subscription operation is running, its collect button shows the existing loading spinner and the row's switch and menu actions are disabled.
- While AI screening is running, the corresponding menu item displays a spinner and cannot be triggered again.
- The menu closes after an action is chosen. Actions that open dialogs continue through the existing topic-ingestion and backfill dialogs.
- Delete retains the existing confirmation prompt and destructive behavior.
- Disabled subscriptions retain their muted visual treatment without reducing control legibility below an accessible level.
- Menu trigger and items support keyboard navigation, visible focus, accessible names, and screen-reader labels.

## Responsive Behavior

At regular dialog widths, metadata and actions share one row. At narrow widths, the information region occupies the first line and the switch plus action cluster form a compact trailing area without horizontal overflow. Long labels, URLs, queries, and error messages wrap or truncate within the information region only.

The subscription list retains its existing scroll boundary. The redesign must not enlarge the dialog or introduce a second nested horizontal scroller.

## Component Boundary

Extract the subscription row and overflow action menu from the large management dialog into focused components in the X feature area. The row receives subscription state and action callbacks; it does not fetch data or duplicate mutation logic. Existing parent handlers remain the source of truth.

Use the project's existing shadcn/Base UI conventions and Lucide icon family. Add the smallest menu primitive needed by the project if no dropdown menu component currently exists.

## Verification

- Component tests verify that `采集` remains visible and all other actions move into the overflow menu.
- Tests verify timeline-only and search-only action visibility.
- Tests verify disabled/busy states, edit selection, and destructive confirmation wiring.
- Browser verification covers the current desktop dialog width and a narrow viewport, checking for clipping, overlap, unintended wrapping, and horizontal scrolling.
- Existing collection, notification, ingestion, screening, backfill, editing, enablement, and deletion behavior must remain intact.

## Out of Scope

- Backend or API changes.
- Changes to collection scheduling or subscription semantics.
- Redesigning the rest of the X feed, sidebar, or subscription creation forms.
- Replacing the management dialog with a full page or side panel.
