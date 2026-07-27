# Chat Tool Activity and Session Lifecycle Design

## Goal

Make Chat tool activity concise without losing durable audit data, add permanent
session deletion, and avoid creating empty sessions before a user sends a first
message.

## Tool Activity Design

The backend continues to persist every tool audit message for traceability. The
frontend treats those `role: tool` records as an internal audit ledger and does
not render them as separate chat entries. It renders the assistant message's
tool parts once, as a single collapsed activity group directly associated with
that answer.

The closed summary describes the outcome in plain language: a search-only group
uses “已检索本地资料”; a read-only group uses “已阅读 N 条资料”; mixed groups use
“已检索本地资料，并阅读 N 条相关内容”. Expanding the group reveals concise per-call
labels and status, not raw JSON payloads by default.

## Session Lifecycle

Clicking “新建对话” creates only a client-side empty state: no backend session is
created and no empty item appears in the sidebar. The existing first-send flow
creates and persists the session just before the first user message is streamed.

Each persisted sidebar session gains a delete action. It asks for browser-native
confirmation, deletes the session and its messages through a backend `DELETE`
endpoint, refreshes the sidebar, and returns to the client-side empty state when
the deleted session was active.

## Data and Safety

- Tool-audit persistence is unchanged and remains excluded from model history.
- Session deletion is permanent and applies only to the selected session ID.
- New empty conversations are not persisted, so they cannot be deleted and do
  not create orphan rows.
- Existing stored sessions and message formats remain compatible.

## Validation

- Backend tests cover successful deletion, 404 deletion, and removal of the
  session's messages.
- Frontend tests cover the delete API request, activity summary text, hidden
  audit-only message rendering, and the lazy new-conversation state.
- Run focused tests, full frontend/backend suites, TypeScript checking, and the
  production build.
