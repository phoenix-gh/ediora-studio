# X Article Writing Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bundled `x-article-writing` Skill that Agents can autonomously discover and load for independent X/Twitter Article writing and matching intelligence-center `expanded_article` jobs.

**Architecture:** Add one bundled Skill package under the existing `wemedia-studio/skills` registry root. Keep the main `SKILL.md` concise and route detailed structure, opening/layout, and quality guidance into three on-demand Markdown references; extend the bundled-skill integration test to verify discovery, boundaries, readable references, and lifecycle behavior.

**Tech Stack:** Markdown Agent Skills, `WMS_SKILL.json`, TypeScript, Vitest, existing WeMediaStudio Skill registry.

## Global Constraints

- The Skill identifier is `x-article-writing`; its human-facing meaning is “X Article Writing”.
- It covers the independent X/Twitter Article format and matching `expanded_article` work, not ordinary long posts, Threads, short posts, replies, or general social copy.
- It must never invent facts, numbers, personal experience, revenue, screenshots, tests, or sources.
- Unverified algorithm weights, interaction multipliers, click-through claims, and viral guarantees from the source prompt must not become factual rules.
- Intelligence-center delivery defaults to one title plus one complete Markdown article; title menus, image plans, operations advice, and CTA are conditional, not mandatory.
- Existing user changes in the mixed worktree must be preserved.
- `.git` is read-only in the current environment, so verification uses focused tests and diff checks instead of commits.

---

### Task 1: Define the bundled Skill contract with a failing integration test

**Files:**
- Modify: `wemedia-studio/lib/skills/bundled-skills.test.ts`

**Interfaces:**
- Consumes: `listSkills()`, `discoverSkills()`, `listSkillReferences()`, `readSkillReference()`, `getEnabledSkill()`, `setSkillEnabled()`, and `deleteUploadedSkill()` from the existing registry.
- Produces: A regression contract for the bundled name, version, references, trigger boundary, safety rules, and built-in lifecycle.

- [ ] **Step 1: Add the failing integration contract**

Add a second describe block using `skillName = 'x-article-writing'` and these expected references:

```ts
const expectedXArticleReferences = [
  'references/article-structure.md',
  'references/hooks-and-layout.md',
  'references/quality-check.md',
]
```

The tests must assert:

```ts
expect(await listSkills()).toContainEqual(expect.objectContaining({
  name: 'x-article-writing',
  source: 'builtin',
  enabled: true,
  version: '1.0.0-wms.1',
}))
expect((await discoverSkills()).map(skill => skill.name)).toContain('x-article-writing')
expect((await listSkillReferences('x-article-writing')).map(item => item.path))
  .toEqual(expectedXArticleReferences)
```

Load the Skill and assert its metadata/body contains `X/Twitter Article`, `expanded_article`, `不适用于普通 X 长帖或 Thread`, `不得编造`, `save_draft`, and all three `readSkillReference` paths. Read every reference and assert non-empty content. Verify disabling removes it from discovery, restoring adds it back, and deleting it rejects with `{ code: 'forbidden' }`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd wemedia-studio
pnpm exec vitest run lib/skills/bundled-skills.test.ts
```

Expected: FAIL because `x-article-writing` is absent from bundled discovery.

---

### Task 2: Add the concise Skill package and references

**Files:**
- Create: `wemedia-studio/skills/x-article-writing/SKILL.md`
- Create: `wemedia-studio/skills/x-article-writing/WMS_SKILL.json`
- Create: `wemedia-studio/skills/x-article-writing/references/article-structure.md`
- Create: `wemedia-studio/skills/x-article-writing/references/hooks-and-layout.md`
- Create: `wemedia-studio/skills/x-article-writing/references/quality-check.md`
- Test: `wemedia-studio/lib/skills/bundled-skills.test.ts`

**Interfaces:**
- Consumes: Existing folder-based bundled discovery and `loadSkill`/`readSkillReference` Agent tools.
- Produces: A discoverable Skill named `x-article-writing` with three on-demand references and no executable assets.

- [ ] **Step 1: Create `SKILL.md` with valid metadata and the delivery workflow**

Use this frontmatter contract:

```yaml
---
name: x-article-writing
description: "Use when writing, rewriting, or expanding an independent X/Twitter Article, including an intelligence-center expanded_article based on an X post, research item, product release, or industry update; not for ordinary X posts, long posts, Threads, replies, or general social copy."
version: 1.0.0-wms.1
---
```

The body must require: format confirmation, one central thesis, an evidence ledger, conditional reference reads, a complete Markdown article, final factual/structural review, and delivery through the workflow-required save tool. It must state that `expanded_article` uses one title and complete body via `save_draft`, without publishing or adding unrelated extras.

- [ ] **Step 2: Create focused on-demand references**

`article-structure.md` must define the opening promise, evidence-backed development, counterpoint/limits, practical value, and ending for news analysis, mechanism explanation, tutorial, case study, and opinion Article forms.

`hooks-and-layout.md` must define an accurate first 280-character preview, mobile-readable paragraphs, restrained emphasis, concrete scenes/data, and conditional bookmark-value elements without fabricated virality claims.

`quality-check.md` must define the evidence boundary, source attribution, inference labeling, anti-fabrication checks, anti-template checks, link placement, and final delivery checklist.

- [ ] **Step 3: Add a minimal execution manifest**

Create:

```json
{
  "preloadReferences": [],
  "execution": {
    "planRequired": true,
    "verificationRequired": true,
    "maxRevisions": 1
  }
}
```

References remain on demand so the Agent only loads guidance relevant to the current Article.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
cd wemedia-studio
pnpm exec vitest run lib/skills/bundled-skills.test.ts lib/skills/registry.test.ts
```

Expected: both files pass, including the new Skill contract.

- [ ] **Step 5: Run focused lint and repository hygiene checks**

Run:

```bash
cd wemedia-studio
pnpm exec eslint lib/skills/bundled-skills.test.ts
cd ..
git diff --check -- wemedia-studio/skills/x-article-writing wemedia-studio/lib/skills/bundled-skills.test.ts
```

Expected: exit code 0 with no warnings or whitespace errors.

---

### Task 3: Verify runtime discovery and Agent-facing catalog text

**Files:**
- Verify: `wemedia-studio/skills/x-article-writing/**`
- Verify: `wemedia-studio/lib/ai/discover-skills.ts`

**Interfaces:**
- Consumes: `discoverSkills()` and `getEnabledSkill('x-article-writing')`.
- Produces: Evidence that a future `content_response_output` Agent receives a clearly matching catalog entry and can load the Skill by exact name.

- [ ] **Step 1: Run a read-only registry probe**

Use a focused Vitest assertion or the existing test environment to verify that the catalog description includes both `X/Twitter Article` and `expanded_article`, while excluding ordinary `Thread` work.

- [ ] **Step 2: Inspect the final package for source-prompt regressions**

Run:

```bash
rg -n "编造|95%|150|4\.0|保证爆款|必须.*配图|五个标题" wemedia-studio/skills/x-article-writing
```

Expected: only explicit anti-fabrication language may match; no unsupported metric or unconditional extras remain.

- [ ] **Step 3: Report the deployment boundary**

State that the Skill is bundled and discoverable immediately by newly created Agent runs. Historical Job `#1093` remains an immutable execution record and will not retroactively show a Skill call; a new X Article job is required to observe `loadSkill("x-article-writing")` in its logs.
