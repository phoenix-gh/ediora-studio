# Skill Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent Skill registry and Settings UI that can enable/disable every Skill, upload validated ZIP packages, and delete uploaded Skills while protecting bundled Skills and rejecting name conflicts.

**Architecture:** A server-only `SkillRegistry` is the single source of truth. It reads bundled Skills from `web/skills/`, uploaded Skills from `web/.runtime/skills/`, and atomically persists enablement in `.runtime/skills-state.json`; chat discovery and automatic image flows consume the registry so disabled Skills are unavailable everywhere. Next Route Handlers expose metadata-only management operations, and a client Settings section drives them.

**Tech Stack:** Next.js 16 Route Handlers, TypeScript, Node `fs/promises`, `fflate` for dependency-free ZIP parsing, Vitest/Testing Library, ESLint, Playwright smoke checks.

## Global Constraints

- Bundled Skills are never deletable; uploaded Skills may be deleted.
- Disabled Skills must be absent from chat discovery and rejected by automatic Skill-dependent flows.
- A ZIP name conflict with any bundled or uploaded Skill rejects the entire upload and never overwrites existing files.
- ZIP extraction rejects absolute paths, `..` traversal, symlink entries, missing `SKILL.md`, invalid frontmatter names, duplicate names, and configured archive/file-count/expanded-size limits.
- State writes use a temporary file plus rename and an in-process serialized mutation queue.
- API responses expose only `name`, `description`, `version`, `source`, and `enabled`; never return full instructions.
- Existing unrelated worktree changes remain untouched and are not staged.
- Every implementation slice follows TDD: write a focused failing test, run the test to observe RED, implement the smallest fix, run GREEN, then commit only that slice.

## File Map

- Create `web/lib/skills/registry.ts`: server-only registry types, discovery, state persistence, ZIP validation/install, enable/disable/delete operations.
- Create `web/lib/skills/registry.test.ts`: registry, persistence, security, and rollback tests using temporary fixture directories.
- Modify `web/lib/ai/discover-skills.ts`: delegate enabled discovery to the registry while preserving the existing public shape.
- Modify `web/lib/ai/content-job.ts`: resolve Baoyu Skill files through the registry so disabled Skills cannot be loaded and uploaded Skill directories can be resolved safely.
- Create `web/app/api/skills/route.ts`, `app/api/skills/[name]/route.ts`, and `app/api/skills/upload/route.ts`: metadata list, toggle, delete, and multipart ZIP endpoints.
- Create `web/app/api/skills/route.test.ts`: Route Handler success/error contract tests.
- Create `web/lib/api/skills.ts`: typed browser API client for management operations.
- Create `web/app/settings/sections/SkillsSection.tsx` and its test: list, toggle, upload, source labels, and deletion confirmation.
- Modify `web/app/settings/SettingsClient.tsx`: add the “技能管理” navigation item and render the section.
- Modify `web/lib/ai/discover-skills.test.ts` and relevant chat/content-job tests: disabled Skill regressions.
- Modify `web/package.json`, `web/pnpm-lock.yaml`: add `fflate`.
- Modify `.gitignore`: ignore `web/.runtime/`.

---

### Task 1: Add the registry contract and bundled-state discovery

**Files:**
- Create: `web/lib/skills/registry.test.ts`
- Create: `web/lib/skills/registry.ts`

**Interfaces:**
- `type SkillSource = 'builtin' | 'uploaded'`
- `type ManagedSkill = { name: string; description: string; version: string; source: SkillSource; enabled: boolean }`
- `type RegisteredSkill = ManagedSkill & { instructions: string; directory: string }`
- `listSkills(): Promise<ManagedSkill[]>`
- `listEnabledSkills(): Promise<RegisteredSkill[]>`
- `getEnabledSkill(name: string): Promise<RegisteredSkill | null>`
- `setSkillEnabled(name: string, enabled: boolean): Promise<ManagedSkill>`
- `deleteUploadedSkill(name: string): Promise<void>`
- `installSkillArchive(buffer: Uint8Array): Promise<ManagedSkill[]>`
- `SkillRegistryError` carries a stable `code` (`not_found`, `conflict`, `forbidden`, `invalid_archive`, `too_large`) for Route Handler mapping.

- [ ] **Step 1: Write failing registry tests**

Create temporary bundled/runtime directories in `beforeEach`, set `SKILLS_BUNDLED_DIR` and `SKILLS_RUNTIME_DIR`, write fixture `SKILL.md` files, and assert:

```ts
it('lists bundled Skills enabled by default and persists a toggle', async () => {
  writeSkill(bundledDir, 'alpha', 'Alpha', '1.0.0')
  expect(await listSkills()).toEqual([
    expect.objectContaining({ name: 'Alpha', source: 'builtin', enabled: true }),
  ])
  await setSkillEnabled('Alpha', false)
  expect((await listSkills())[0].enabled).toBe(false)
  expect((await listEnabledSkills())).toHaveLength(0)
})

it('does not allow deleting a bundled Skill and allows deleting an uploaded Skill', async () => {
  writeSkill(bundledDir, 'alpha', 'Alpha', '1.0.0')
  writeSkill(runtimeDir, 'custom', 'Custom', '1.0.0')
  await expect(deleteUploadedSkill('Alpha')).rejects.toMatchObject({ code: 'forbidden' })
  await deleteUploadedSkill('Custom')
  expect(await listSkills()).toHaveLength(1)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `cd web && pnpm vitest run lib/skills/registry.test.ts`.
Expected: FAIL because `lib/skills/registry.ts` and its exported functions do not exist.

- [ ] **Step 3: Implement the minimal registry and state file**

Implement frontmatter parsing compatible with the current discovery parser, derive directories from the two environment-overridable roots, treat missing bundled state as enabled, and persist a JSON map `{ [name]: { source, enabled } }` with `mkdir`, write-to-unique-temp-file, and `rename`. Serialize mutations with a module-level promise queue. Keep reads metadata-only unless `listEnabledSkills`/`getEnabledSkill` is requested.

- [ ] **Step 4: Run registry tests and verify GREEN**

Run `cd web && pnpm vitest run lib/skills/registry.test.ts`.
Expected: all default-enable, persistence, enabled lookup, bundled-protection, and uploaded-delete tests pass.

- [ ] **Step 5: Commit the registry slice**

```bash
git add web/lib/skills/registry.ts web/lib/skills/registry.test.ts
git commit -m "feat: add persistent skill registry"
```

### Task 2: Make all existing Skill consumers honor enablement

**Files:**
- Modify: `web/lib/ai/discover-skills.ts`
- Modify: `web/lib/ai/content-job.ts`
- Modify: `web/lib/ai/discover-skills.test.ts`
- Test/modify: the existing content-job test file covering Baoyu image steps

**Interfaces:** Consume `listEnabledSkills()` and `getEnabledSkill()` from Task 1; preserve `discoverSkills(): Promise<DiscoveredSkill[]>`.

- [ ] **Step 1: Add failing disabled-consumer regressions**

Extend discovery tests to disable a fixture Skill and assert it disappears, then re-enable it and assert it returns. Add a content-job regression that disables a Baoyu fixture and expects the exported Skill-rule loader to reject with an unavailable/disabled error rather than reading `skills/<name>/SKILL.md` directly.

```ts
await setSkillEnabled('baoyu-cover-image', false)
await expect(loadBaoyuSkillRulesForTest(step)).rejects.toThrow(/unavailable|disabled/i)
```

- [ ] **Step 2: Run tests and verify RED**

Run `cd web && pnpm vitest run lib/ai/discover-skills.test.ts <content-job-test-file>`.
Expected: the disabled discovery test still returns the Skill and the content loader still reads the direct path.

- [ ] **Step 3: Implement registry-backed consumers**

Replace `discoverSkills` directory scanning with `listEnabledSkills`, mapping only `{ name, description, version, instructions }`. Refactor `loadBaoyuSkillCore` and `loadBaoyuSkillRules` to use `getEnabledSkill(skillName)` and its `directory`; throw a stable unavailable error when null. Export the rule loader only if needed by the test, without changing callers. Preserve reference-file lookup relative to the resolved directory.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run `cd web && pnpm vitest run lib/ai/discover-skills.test.ts <content-job-test-file> app/api/chat/route.test.ts`.
Expected: bundled discovery shape remains unchanged, disabled Skills disappear, selected disabled Skills are rejected, and enabled Baoyu references still load.

- [ ] **Step 5: Commit the consumer integration**

```bash
git add web/lib/ai/discover-skills.ts web/lib/ai/discover-skills.test.ts web/lib/ai/content-job.ts <content-job-test-file>
git commit -m "feat: enforce skill enablement across ai flows"
```

### Task 3: Add safe ZIP installation with atomic rollback

**Files:**
- Modify: `web/lib/skills/registry.test.ts`
- Modify: `web/lib/skills/registry.ts`
- Modify: `web/package.json`, `web/pnpm-lock.yaml`

**Interfaces:** `installSkillArchive(buffer)` returns all newly installed metadata and leaves both existing files and state unchanged on any validation failure.

- [ ] **Step 1: Add failing ZIP tests**

Use `fflate.zipSync` in tests to cover a root `SKILL.md`, one-level directory, wrapper directory, multiple Skills, default enabled state, duplicate names, existing-name conflict, traversal (`../escape`), symlink-looking entries, missing frontmatter name, and a deliberately over-limit archive. Assert failed multi-Skill uploads leave the runtime directory and state file byte-for-byte unchanged.

```ts
const archive = zipSync({ 'one/SKILL.md': utf8Encode(skillMarkdown('One')) })
await expect(installSkillArchive(archive)).resolves.toEqual([
  expect.objectContaining({ name: 'One', source: 'uploaded', enabled: true }),
])
```

- [ ] **Step 2: Run ZIP tests and verify RED**

Run `cd web && pnpm vitest run lib/skills/registry.test.ts -t "archive|ZIP|upload"`.
Expected: FAIL because `fflate` is not installed and `installSkillArchive` is not implemented.

- [ ] **Step 3: Add `fflate` and implement validation/install**

Run `cd web && pnpm add fflate`. Parse with `unzipSync(new Uint8Array(buffer))`; reject unsafe path components, directory/symlink entries, unsupported file layout, duplicate names, invalid names (`^[A-Za-z0-9._-]{1,80}$`), archive bytes over 10 MiB, more than 500 files, or expanded bytes over 50 MiB. Stage each Skill in a unique runtime temp directory, copy only regular validated files, verify `SKILL.md`, then rename staged directories into the runtime root and persist all state in one serialized mutation. On conflict or any error, remove only the staging directory and do not mutate existing content.

- [ ] **Step 4: Run ZIP tests and verify GREEN**

Run `cd web && pnpm vitest run lib/skills/registry.test.ts`.
Expected: all valid layouts install, malicious/invalid archives fail with stable error codes, conflicts return `conflict`, and rollback leaves prior state intact.

- [ ] **Step 5: Commit ZIP support**

```bash
git add web/lib/skills/registry.ts web/lib/skills/registry.test.ts web/package.json web/pnpm-lock.yaml
git commit -m "feat: safely install uploaded skills"
```

### Task 4: Expose management Route Handlers and typed client API

**Files:**
- Create: `web/app/api/skills/route.ts`
- Create: `web/app/api/skills/[name]/route.ts`
- Create: `web/app/api/skills/upload/route.ts`
- Create: `web/app/api/skills/route.test.ts`
- Create: `web/lib/api/skills.ts`

**Interfaces:**
- `GET /api/skills -> ManagedSkill[]`
- `PATCH /api/skills/:name` with `{ enabled: boolean } -> ManagedSkill`
- `POST /api/skills/upload` multipart field `file` -> `ManagedSkill[]`
- `DELETE /api/skills/:name -> 204`
- Client exports `fetchSkills`, `updateSkillEnabled`, `uploadSkillArchive`, `deleteSkill`.

- [ ] **Step 1: Write failing Route Handler tests**

Mock/fixture the registry roots and assert GET metadata excludes `instructions`, PATCH accepts only boolean `enabled`, upload requires a ZIP `file`, successful upload returns metadata, conflicts map to 409, too-large archives map to 413, invalid archives map to 400, delete returns 204, and bundled deletion maps to 409.

- [ ] **Step 2: Run Route Handler tests and verify RED**

Run `cd web && pnpm vitest run app/api/skills/route.test.ts`.
Expected: FAIL because the route modules and client do not exist.

- [ ] **Step 3: Implement handlers and client**

Use `NextResponse.json`, `request.formData()`, and `file.arrayBuffer()`. Decode the dynamic name with `decodeURIComponent`; map `SkillRegistryError.code` to the exact statuses above; reject malformed JSON and non-boolean toggles with 400. Keep API payloads metadata-only. Implement client methods through the existing `apiFetch` conventions and throw the existing normalized API error type.

- [ ] **Step 4: Run Route Handler tests and verify GREEN**

Run `cd web && pnpm vitest run app/api/skills/route.test.ts`.
Expected: all list/toggle/upload/delete status and payload assertions pass.

- [ ] **Step 5: Commit the API slice**

```bash
git add web/app/api/skills web/lib/api/skills.ts
git commit -m "feat: add skill management api"
```

### Task 5: Build the Settings “技能管理” section

**Files:**
- Create: `web/app/settings/sections/SkillsSection.tsx`
- Create: `web/app/settings/sections/SkillsSection.test.tsx`
- Modify: `web/app/settings/SettingsClient.tsx`

**Interfaces:** `SkillsSection` renders management metadata, calls Task 4 client methods, and exposes accessible controls with stable labels/test IDs.

- [ ] **Step 1: Write failing component tests**

Mock the typed client and render a bundled plus uploaded Skill. Assert both are visible and enabled, source labels read “预制”/“已上传”, the bundled row has no delete button, toggling calls `updateSkillEnabled`, upload uses a hidden input accepting `.zip` and refreshes after success, and deleting an uploaded Skill requires `window.confirm` then refreshes.

```tsx
expect(screen.getByText('预制')).toBeInTheDocument()
expect(screen.queryByRole('button', { name: '删除 Alpha' })).not.toBeInTheDocument()
await user.click(screen.getByRole('switch', { name: '启用 Custom' }))
expect(updateSkillEnabled).toHaveBeenCalledWith('Custom', false)
```

- [ ] **Step 2: Run component tests and verify RED**

Run `cd web && pnpm vitest run app/settings/sections/SkillsSection.test.tsx`.
Expected: FAIL because `SkillsSection` and its Settings navigation entry do not exist.

- [ ] **Step 3: Implement the section and navigation**

Use existing `FormSection`, `Switch`, `Button`, and lucide icons. Load on mount, preserve the current list when a request fails, show an inline error, disable the upload control during submission, show an explicit empty state, and use `window.confirm` before uploaded deletion. Add `skills` to `SectionId`, `NAV`, `SECTION_TITLE`, and the render switch in `SettingsClient.tsx`; keep the default active section unchanged.

- [ ] **Step 4: Run component tests and verify GREEN**

Run `cd web && pnpm vitest run app/settings/sections/SkillsSection.test.tsx`.
Expected: all labels, switch, upload, error, empty-state, and delete-confirmation assertions pass.

- [ ] **Step 5: Commit the Settings UI**

```bash
git add web/app/settings/sections/SkillsSection.tsx web/app/settings/sections/SkillsSection.test.tsx web/app/settings/SettingsClient.tsx
git commit -m "feat: add skill management settings"
```

### Task 6: Persist runtime data safely and finish regression coverage

**Files:**
- Modify: `.gitignore`
- Modify: `web/lib/ai/discover-skills.test.ts`, chat/content-job tests as needed
- Create/modify: any small route/client regression tests needed to cover restart persistence

- [ ] **Step 1: Add the failing persistence and boundary tests**

Add a test that writes an uploaded Skill and disabled state, clears the module cache or reloads the registry, and verifies both survive. Add a chat endpoint regression that a disabled selected name returns the existing unavailable error, and a rule-loading regression that disabled automatic image Skills fail closed.

- [ ] **Step 2: Run the tests and verify RED**

Run `cd web && pnpm vitest run lib/skills/registry.test.ts lib/ai/discover-skills.test.ts app/api/chat/route.test.ts <content-job-test-file>`.
Expected: at least the persistence/reload and disabled automatic-flow assertions fail before final boundary wiring.

- [ ] **Step 3: Apply ignore rule and minimal boundary fixes**

Add exactly `web/.runtime/` to `.gitignore`; ensure all registry state and uploaded content are under that directory, no route writes to bundled paths, and all consumers use enabled registry lookups. Do not alter unrelated runtime/database files.

- [ ] **Step 4: Run the boundary tests and verify GREEN**

Run the same focused Vitest command. Expected: restart persistence, disabled chat selection, disabled automatic loading, and existing enabled flows all pass.

- [ ] **Step 5: Commit persistence and ignore rules**

```bash
git add .gitignore web/lib/skills web/lib/ai web/app/api/chat
git commit -m "fix: persist skill management boundaries"
```

### Task 7: Full verification and browser smoke test

**Files:** No new source files; only test/build artifacts outside Git may be created.

- [ ] **Step 1: Run all frontend tests**

Run `cd web && pnpm test`.
Expected: Vitest exits 0 with no failed or skipped required tests.

- [ ] **Step 2: Run lint and production build**

Run `cd web && pnpm lint && pnpm build`.
Expected: ESLint and Next production build both exit 0.

- [ ] **Step 3: Exercise the live Settings page**

Use the existing dev server at `http://127.0.0.1:3000`; the Browser plugin is not available in this session, so use the project’s Playwright tooling as the fallback. Open `/settings`, click “技能管理”, verify the two bundled Skills appear with switches and no delete buttons, toggle one off and back on, upload a temporary valid ZIP, verify it appears as “已上传”, then delete it after confirmation. Confirm `GET /api/chat/skills` excludes a disabled Skill during the check.

- [ ] **Step 4: Inspect the final diff**

Run `git status --short`, `git diff --check`, and `git diff --stat`; verify only the Skill feature files plus the planned dependency/ignore changes are staged, and existing unrelated worktree edits remain unstaged.

- [ ] **Step 5: Commit verification-only adjustments if required**

If verification exposes a real defect, add a focused RED test, fix it, rerun the affected command, and commit with a specific message. Otherwise leave the verification results documented in the final response without creating a no-op commit.

