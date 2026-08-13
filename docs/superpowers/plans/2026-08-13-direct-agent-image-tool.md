# Direct Agent Image Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Agent `generateImage` calls execute image generation and asset persistence directly, without creating or waiting on a child content Job or Redis queue item.

**Architecture:** Extract the existing provider/configuration/upload path into a direct image-generation service. The global Agent tool receives that service as a host dependency; each tool call waits for its own terminal result, while the AI SDK may execute multiple tool calls concurrently. Existing non-Agent content flows keep their durable job behavior.

**Tech Stack:** TypeScript, Vercel AI SDK, FastAPI asset upload endpoint, Vitest.

## Global Constraints

- `generateImage` must return only after the image is generated and saved as a CreativeAsset.
- Agent image calls must not create `standalone_image` jobs, enqueue Redis work, or poll job status.
- Three independent Agent image calls may run concurrently.
- `upload_image_from_url` remains for external URLs; generated assets are not uploaded again.

### Task 1: Extract direct image generation service

**Files:**
- Create: `wemedia-studio/lib/ai/image-generation.ts`
- Modify: `wemedia-studio/lib/ai/content-job.ts`
- Test: `wemedia-studio/lib/ai/image-generation.test.ts`

- [x] Write a failing test proving a direct call loads image settings, calls the image provider once, uploads one CreativeAsset, and returns the saved asset.
- [x] Run the focused test and confirm it fails because the service does not exist.
- [x] Move the shared settings, provider call, event/upload behavior behind a direct function with no content-job creation or queue calls.
- [x] Update standalone/prompt image flows to use the extracted service without changing their durable outer job lifecycle.
- [x] Run the focused test and the existing `content-job.test.ts` tests.

### Task 2: Wire Agent `generateImage` to the direct service

**Files:**
- Modify: `wemedia-studio/lib/ai/global-chat-tools.ts`
- Modify: `wemedia-studio/lib/ai/daily-creation-agent-job.ts`
- Modify: `wemedia-studio/lib/ai/content-response-output-job.ts`
- Modify: `wemedia-studio/app/api/chat/route.ts`
- Modify: `wemedia-studio/lib/ai/agent-runtime.ts`
- Test: `wemedia-studio/lib/ai/global-chat-tools.test.ts`

- [x] Add a failing tool test asserting `generateImage` invokes the direct host generator and never calls `/jobs`.
- [x] Replace `ImageJobClient`/HTTP and inline child-job clients with a direct `ImageGenerator` dependency.
- [x] Pass the current parent job ID only as the trusted upload correlation header for Worker-hosted Agents; interactive chat uses the existing worker token without a child job.
- [x] Remove Agent-path job creation, waiting, and child-job imports.
- [x] Run all affected Agent tests and confirm direct results preserve `asset_id`, `asset_url`, title, and directory.

### Task 3: Verify runtime and remove obsolete behavior

**Files:**
- Modify: no additional production files unless verification exposes a call site.

- [x] Search all Agent call sites for `createHttpImageJobClient`, `createInlineImageJobClient`, `/jobs`, or image-job polling.
- [x] Run TypeScript focused tests, ESLint, backend MCP tests, and `git diff --check`.
- [x] Report pre-existing full typecheck failures separately from this change.
