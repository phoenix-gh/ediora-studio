# Chat Global Tool Registry Design

## Goal

Make Chat a global, tool-using interface for Ediora. Every tool
registered by the local MCP server becomes available automatically, while Chat
also exposes application-native image generation. A selected skill guides tool
use; it no longer merely supplies inert text instructions.

## Tool Discovery and Lifetime

For each Chat request, the Next.js route opens an MCP HTTP client to the local
FastAPI `/mcp` endpoint and calls `client.tools()`. This dynamically discovers
all MCP tools, including future additions, without a Chat-side allowlist.
The route closes the MCP client after the UI message stream finishes or errors.

The existing source-search wrappers are removed in favor of the MCP tools that
own the same data. Chat retains a small application-native tool set for actions
that are intentionally implemented in Next.js rather than FastAPI.

## Image Generation

`generateImage` is an application-native Chat tool. It requires a selected
draft and starts the existing durable `cover` or `illustrations` content job for
that draft. It returns the job ID, state, and destination draft rather than
pretending that a queued image is already complete. The running worker remains
the sole component that calls the image provider and saves generated assets.

For `baoyu-cover-image` and `baoyu-article-illustrator`, Chat injects the
existing runtime-adapter instructions rather than the complete CLI-oriented
`SKILL.md`. These instructions require `generateImage` and prohibit first-time
setup, local-file probing, and prompt-file workflows. Other discovered skills
continue to contribute their selected instruction text.

## Confirmed-Action Boundary

Read-only tools and image-job creation execute immediately. Tools with external
publication, deletion, or full-record overwrite effects pause with an approval
request. The Chat client renders the requested tool name and arguments with
Approve / Reject controls, sends the decision back as an AI SDK tool approval
response, and only then resumes the server-side tool loop. Rejection is added
to model context so the model does not retry the same action.

Tool names are classified from the MCP registry by an explicit sensitive-action
predicate: publish, delete, update, save, create, add, or upload. The predicate
is deliberately conservative; newly added MCP tools are discoverable by
default, while names matching one of these verbs require approval.

## Chat Persistence and Audit

The UI stream persists assistant messages, including native and MCP tool parts,
to the existing Chat session. The prior custom source-tool audit row mechanism
is retired because MCP and native tool calls are represented directly in the
assistant message stream. The collapsed tool-activity UI continues to group
sequential calls and additionally displays pending approval state.

## Validation

- Verify the registry discovers tools from the running local `/mcp` endpoint
  and closes the request-scoped client.
- Verify sensitive names require AI SDK approval while read-only names and
  `generateImage` do not.
- Verify a selected cover skill emits a `generateImage` job for the selected
  draft and records the job ID in Chat.
- Verify approval/rejection resumes the same conversation safely and is
  persisted.
- Run frontend/backend suites, TypeScript checking, production build, and a
  local MCP discovery smoke test.
