# Human Social Copy Bundled Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy `x-post` Skill with a curated, attributed, account-aware `human-social-copy` bundled Skill that uses on-demand references.

**Architecture:** Add one compact bundled `SKILL.md` and eight focused references under the Next.js Skill registry root. Preserve upstream MIT provenance, remove upstream personal/runtime assumptions, update active legacy handoffs, and delete the old project-level `x-post` directory. Validate the package through the real registry and Chat discovery paths.

**Tech Stack:** Markdown Agent Skill format, TypeScript Skill registry, Vitest, Next.js Chat Skill API.

## Global Constraints

- Default voice: explicit account profile first; neutral human Chinese when account context is absent or ambiguous.
- Do not include `0xmulight-voice-profile`, `hot-tools-tweet`, cron, Hermes paths, or missing reference dependencies.
- Preserve the upstream MIT `LICENSE` and pin commit `e9c11bed71e74171d114dbb641075d61bdf2fca3` in `UPSTREAM.md`.
- Use version `1.0.0-wms.1` and Skill name `human-social-copy`.
- Delete `skills/x-post/`; update only active Skill handoffs, not historical documents or unrelated X URL helpers.
- Do not alter unrelated dirty-worktree files.

---

### Task 1: Define failing bundled-Skill acceptance tests

**Files:**
- Create: `wemedia-studio/lib/skills/bundled-skills.test.ts`

**Interfaces:**
- Consumes: real `listSkills`, `listSkillReferences`, `readSkillReference`, `setSkillEnabled`, `deleteUploadedSkill`, and `discoverSkills` APIs.
- Produces: executable acceptance contract for package structure, behavior, provenance, safe content, disable/restore, and legacy removal.

- [ ] **Step 1: Write the package acceptance test**

Assert that the real registry reports `human-social-copy` as enabled `builtin` version `1.0.0-wms.1`; its reference catalog equals the eight specified paths; each reference can be read; bundled deletion is forbidden; disable hides it from `discoverSkills` and reference access; re-enable restores it. Read `LICENSE`, `UPSTREAM.md`, `SKILL.md`, `skills/article-drafting/SKILL.md`, and `skills/content-ideation/SKILL.md` to assert provenance and current routing. Assert `skills/x-post` is absent and active adapted files contain none of the prohibited upstream-private/runtime terms.

- [ ] **Step 2: Run the test and verify RED**

```bash
cd wemedia-studio
pnpm test lib/skills/bundled-skills.test.ts
```

Expected: FAIL because `human-social-copy` is not bundled and `skills/x-post` still exists.

### Task 2: Author and validate the curated Skill package

**Files:**
- Create: `wemedia-studio/skills/human-social-copy/SKILL.md`
- Create: `wemedia-studio/skills/human-social-copy/LICENSE`
- Create: `wemedia-studio/skills/human-social-copy/UPSTREAM.md`
- Create: `wemedia-studio/skills/human-social-copy/references/adaptive-hooks.md`
- Create: `wemedia-studio/skills/human-social-copy/references/writing-clean-rules.md`
- Create: `wemedia-studio/skills/human-social-copy/references/patterns.md`
- Create: `wemedia-studio/skills/human-social-copy/references/finance-writing.md`
- Create: `wemedia-studio/skills/human-social-copy/references/layout-playbook.md`
- Create: `wemedia-studio/skills/human-social-copy/references/sourcing-playbook.md`
- Create: `wemedia-studio/skills/human-social-copy/references/kol-brief-workflow.md`
- Create: `wemedia-studio/skills/human-social-copy/references/voice-system.md`

**Interfaces:**
- Consumes: the shared reference catalog/read tool and upstream MIT material.
- Produces: one bundled Skill with a compact routing entrypoint and eight independently useful references.

- [ ] **Step 1: Read the skill-authoring instructions**

Use `skill-creator` and `superpowers:writing-skills` before authoring. Apply their frontmatter, trigger-description, progressive-disclosure, and pressure-testing requirements.

- [ ] **Step 2: Pin and inspect the upstream source**

Clone the public repository into a temporary directory, verify the selected commit and MIT license, and use it only as adaptation input. Do not copy `hot-tools-tweet` or the personal voice profile.

- [ ] **Step 3: Write the main Skill and provenance files**

Create frontmatter with the exact name/version and a trigger-rich Chinese description. Keep workflow, voice priority, reference routing, factual-integrity rules, and final check in `SKILL.md`. Copy the MIT license unchanged and document upstream URL, commit, date, and material adaptations.

- [ ] **Step 4: Write the eight curated references**

Each reference must be self-contained, task-specific, neutral by default, and free of missing links or unavailable commands. Preserve useful concepts but rewrite contradictions and author-private assumptions according to the approved design.

- [ ] **Step 5: Run acceptance tests and verify package GREEN**

Run the Task 1 test. At this checkpoint, package assertions may pass while legacy-removal assertions remain RED until Task 3.

### Task 3: Replace active legacy `x-post` routing

**Files:**
- Modify: `skills/article-drafting/SKILL.md`
- Modify: `skills/content-ideation/SKILL.md`
- Delete: `skills/x-post/SKILL.md`
- Delete: every file under `skills/x-post/references/`

**Interfaces:**
- Consumes: bundled Skill name `human-social-copy`.
- Produces: no active Skill handoff to `x-post` and no legacy `skills/x-post` package.

- [ ] **Step 1: Update active handoffs**

Replace `x-post` related-skill metadata and prose in `article-drafting`; route short social content to `human-social-copy`. Update `content-ideation` output ownership and handoff text, replacing the deleted skeleton/voice sequence with the new Skill's own workflow.

- [ ] **Step 2: Delete the complete legacy directory**

Delete exactly `skills/x-post/SKILL.md` and its ten reference files. Do not touch `wemedia-studio/app/x/x-post-url.ts` or historical `docs/superpowers` references.

- [ ] **Step 3: Run acceptance tests and verify GREEN**

Run the Task 1 test. Expected: all package, registry, routing, and removal assertions pass.

### Task 4: Pressure-test and verify runtime integration

**Files:**
- Modify only Task 1-3 files if a test identifies a defect in the approved behavior.

**Interfaces:**
- Consumes: completed package and routing replacement.
- Produces: Skill-quality, registry, Chat API, full-suite, and running-API evidence.

- [ ] **Step 1: Run Skill pressure tests**

Use the writing-skills validation method on representative prompts: ordinary rewrite, AI tool recommendation, finance/crypto content, sponsored brief, account-profile input, ambiguous/no-account input, and attempts to force 0xMulight impersonation or unavailable tool use. Correct Skill text if observed behavior violates the design.

- [ ] **Step 2: Run focused automated tests**

```bash
cd wemedia-studio
pnpm test lib/skills/bundled-skills.test.ts lib/skills/registry.test.ts lib/ai/discover-skills.test.ts app/api/chat/skills/route.test.ts app/api/skills/route.test.ts
```

- [ ] **Step 3: Run changed-file lint and Markdown checks**

```bash
cd wemedia-studio
pnpm exec eslint lib/skills/bundled-skills.test.ts
git diff --check -- ../skills/article-drafting/SKILL.md ../skills/content-ideation/SKILL.md skills/human-social-copy
```

- [ ] **Step 4: Run the full frontend suite and TypeScript validation**

```bash
cd wemedia-studio
pnpm test
pnpm exec tsc --noEmit
```

Run the test suite outside the sandbox when local provider tests need a listener. Require no new changed-file type errors and report unrelated dirty-worktree errors separately.

- [ ] **Step 5: Verify the running API**

Restart or rely on development hot reload, then request `/api/skills` and `/api/chat/skills`. Confirm `human-social-copy` appears as bundled/enabled with version `1.0.0-wms.1`, `x-post` is absent, and the expected references are readable through a registry smoke.

- [ ] **Step 6: Review and commit only scoped files**

Stage the plan, test, new bundled Skill directory, two active routing files, and exact deleted `skills/x-post` files. Commit with:

```bash
git commit -m "feat: bundle human social copy skill"
```
