# Skill Reference Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Chat and background creation jobs one secure, bounded runtime for discovering and reading enabled Skill references.

**Architecture:** Extend the existing Skill registry with reference discovery, safe reads, and deterministic context loading. Chat receives a compact catalog plus a request-scoped read-only tool; background jobs use the same loader with explicit reference paths. Main Skill instructions remain automatic and no scripts or binary assets are exposed.

**Tech Stack:** TypeScript, Node.js filesystem APIs, Next.js Route Handlers, Vercel AI SDK tools, Vitest.

## Global Constraints

- Main `SKILL.md` is always the entrypoint; references are not injected wholesale.
- Chat may read only the selected enabled Skill; background jobs explicitly list required references.
- Support only `.md`, `.txt`, `.json`, `.yaml`, and `.yml` regular UTF-8 files.
- Reject path traversal, absolute/backslash paths, hidden paths, `SKILL.md`, NUL content, malformed UTF-8, and symlinks.
- Defaults: 200 catalog entries, 131072 bytes per file, 524288 bytes per context/request.
- Do not modify Skill management UI or vendor `human-social-copy` in this change.
- Preserve the dirty worktree and touch only files named in this plan.

---

### Task 1: Add the bounded Skill-reference registry API

**Files:**
- Modify: `wemedia-studio/lib/skills/registry.ts`
- Modify: `wemedia-studio/lib/skills/registry.test.ts`

**Interfaces:**
- Produces: `SkillReference`, `SkillReferenceContent`, `SkillContext`, `listSkillReferences(name)`, `readSkillReference(name, path)`, and `loadSkillContext(name, paths)`.
- Consumes: existing enabled-Skill discovery and `SkillRegistryError`.

- [ ] **Step 1: Add failing registry behavior tests**

Create nested supported and unsupported files under a temporary bundled Skill. Assert stable discovery, reads, context loading, duplicate-path removal, disabled rejection, traversal/absolute/backslash/hidden/`SKILL.md` rejection, symlink rejection, malformed UTF-8/NUL rejection, and configured count/file/context limits. Extend cleanup to delete the three new limit environment variables.

- [ ] **Step 2: Run the registry tests and verify RED**

```bash
cd wemedia-studio
pnpm test lib/skills/registry.test.ts
```

Expected: FAIL because the new exports and error codes do not exist.

- [ ] **Step 3: Implement the shared API**

Add reference-specific error codes and constants. Use `lstat`, `realpath`, recursive `readdir`, byte reads, and fatal UTF-8 decoding. Normalize only validated `/`-separated relative paths. Resolve every operation through an enabled Skill, enforce real-path containment and the configured limits, and return user-safe relative paths without absolute directories.

- [ ] **Step 4: Run registry tests and verify GREEN**

Run the Step 2 command. Expected: all registry tests pass.

### Task 2: Add a request-scoped Chat reference tool and catalog

**Files:**
- Modify: `wemedia-studio/lib/ai/global-chat-tools.ts`
- Modify: `wemedia-studio/lib/ai/global-chat-tools.test.ts`
- Modify: `wemedia-studio/app/api/chat/route.ts`
- Modify: `wemedia-studio/app/api/chat/route.test.ts`

**Interfaces:**
- Consumes: `listSkillReferences`, `readSkillReference`, and configured context-byte limit from Task 1.
- Produces: selected-Skill catalog instructions and `readSkillReference({ path })`, scoped and cached per `openGlobalChatTools` call.

- [ ] **Step 1: Add failing Chat tool tests**

Mock the MCP client and registry reader. Assert the tool is absent without `skillName`, present with a selected Skill, reads only through the closed-over Skill name, caches repeated paths, shares a cumulative byte budget, and does not require approval.

- [ ] **Step 2: Add failing selected-context catalog tests**

Extract/export a small `selectedSkillContext(skillName)` helper from the route. Assert it contains `SKILL.md`, a stable path/byte catalog, and explicit on-demand-read instructions without embedding reference content.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
cd wemedia-studio
pnpm test lib/ai/global-chat-tools.test.ts app/api/chat/route.test.ts
```

Expected: FAIL because the selected reference tool and catalog helper are absent.

- [ ] **Step 4: Implement request-scoped Chat integration**

Pass `skillName` into `openGlobalChatTools`, add a strict `{ path }` schema, close over the selected name, cache successful reads, and track distinct bytes up to the registry context limit. Build selected Skill context from the enabled registry record plus catalog; keep the existing Baoyu runtime adapter instruction while still appending its catalog.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 3 command. Expected: all focused tests pass.

### Task 3: Migrate deterministic background Skill consumers

**Files:**
- Modify: `wemedia-studio/lib/ai/content-job.ts`
- Modify: `wemedia-studio/lib/ai/content-job.test.ts`

**Interfaces:**
- Consumes: `loadSkillContext(name, referencePaths)` from Task 1.
- Produces: unchanged `loadBaoyuSkillRulesForTest(step)` behavior backed by the shared reference runtime.

- [ ] **Step 1: Add a failing loader-boundary test**

Mock or spy on the shared registry loader and assert cover rules request exactly `references/auto-selection.md` and `references/workflow/prompt-template.md`; illustration rules request no references and still extract `SKILL.md: Three Dimensions`.

- [ ] **Step 2: Run focused content-job tests and verify RED**

```bash
cd wemedia-studio
pnpm test lib/ai/content-job.test.ts
```

Expected: FAIL because content jobs still use direct filesystem reads.

- [ ] **Step 3: Replace direct Skill filesystem reads**

Remove `readFile`, `join`, and `getEnabledSkill` usage from the Baoyu loader. Call `loadSkillContext` with the explicit cover list or an empty illustration list, extract core instructions from `context.instructions`, and assemble rules from `context.references` in declared order. Preserve current error text where public tests depend on it, but fail closed for shared registry errors.

- [ ] **Step 4: Run focused content-job tests and verify GREEN**

Run the Step 2 command. Expected: all content-job tests pass.

### Task 4: Verify the complete runtime

**Files:**
- Verify all files modified in Tasks 1-3.
- Modify: `wemedia-studio/app/api/skills/errors.ts`
- Create: `wemedia-studio/app/api/skills/errors.test.ts`
- Modify only tests listed above if verification exposes a regression caused by this feature.

**Interfaces:**
- Consumes: completed registry, Chat, and background integration.
- Produces: final regression evidence and a scoped commit.

- [ ] **Step 1: Run all focused Skill and Chat tests**

```bash
cd wemedia-studio
pnpm test lib/skills/registry.test.ts lib/ai/discover-skills.test.ts lib/ai/global-chat-tools.test.ts app/api/chat/route.test.ts lib/ai/content-job.test.ts
```

- [ ] **Step 2: Run changed-file lint**

```bash
cd wemedia-studio
pnpm exec eslint lib/skills/registry.ts lib/skills/registry.test.ts lib/ai/global-chat-tools.ts lib/ai/global-chat-tools.test.ts app/api/chat/route.ts app/api/chat/route.test.ts lib/ai/content-job.ts lib/ai/content-job.test.ts
```

- [ ] **Step 3: Run the full frontend suite**

```bash
cd wemedia-studio
pnpm test
```

Expected: all tests pass; run outside the sandbox when provider-server tests need a local listener.

- [ ] **Step 3a: Keep Skill API error mapping exhaustive**

If TypeScript reports that new `SkillRegistryErrorCode` members are absent from the HTTP mapping, first add a failing test asserting `invalid_reference → 400` and `reference_not_found → 404`, then add those mappings and rerun the test.

- [ ] **Step 4: Run TypeScript validation**

```bash
cd wemedia-studio
pnpm exec tsc --noEmit
```

Expected: no new errors in changed files. Record existing unrelated dirty-worktree errors without editing those files.

- [ ] **Step 5: Review and commit only scoped files**

```bash
git diff --check -- docs/superpowers/plans/2026-08-02-skill-reference-runtime.md wemedia-studio/lib/skills/registry.ts wemedia-studio/lib/skills/registry.test.ts wemedia-studio/lib/ai/global-chat-tools.ts wemedia-studio/lib/ai/global-chat-tools.test.ts wemedia-studio/app/api/chat/route.ts wemedia-studio/app/api/chat/route.test.ts wemedia-studio/lib/ai/content-job.ts wemedia-studio/lib/ai/content-job.test.ts
git add docs/superpowers/plans/2026-08-02-skill-reference-runtime.md wemedia-studio/lib/skills/registry.ts wemedia-studio/lib/skills/registry.test.ts wemedia-studio/lib/ai/global-chat-tools.ts wemedia-studio/lib/ai/global-chat-tools.test.ts wemedia-studio/app/api/chat/route.ts wemedia-studio/app/api/chat/route.test.ts wemedia-studio/app/api/skills/errors.ts wemedia-studio/app/api/skills/errors.test.ts wemedia-studio/lib/ai/content-job.ts wemedia-studio/lib/ai/content-job.test.ts
git commit -m "feat: load skill references safely"
```
