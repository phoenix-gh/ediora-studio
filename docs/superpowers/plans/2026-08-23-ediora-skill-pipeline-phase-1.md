# Ediora Skill Pipeline Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish standard Agent Skills compatibility and the durable database primitives required by ordered Skill pipelines without changing existing Chat or Job execution behavior.

**Architecture:** The Next.js server remains the Skill package host and gains a standards-aware parser, deterministic package digest, external Ediora binding registry, and a Pi-compatible invocation formatter. The FastAPI service keeps the existing physical Job tables, adds transitional `ExecutionJob*` domain aliases, Stage-scoped Agent execution attempts, append-only artifacts, and one idempotent PostgreSQL startup migration.

**Tech Stack:** Next.js 16, TypeScript 5, Node.js crypto/filesystem APIs, `yaml`, Vitest 4, FastAPI, SQLAlchemy async, PostgreSQL, Pydantic v2, pytest.

**Spec:** `docs/superpowers/specs/2026-08-23-ediora-skill-pipeline-design.md`

## Phase boundary

This plan implements only design Phase 1:

- Standard `SKILL.md` parsing and package discovery without mandatory `SKILL.json`.
- Uploaded-Skill disabled/pending-review state.
- External `SkillBinding` and restrictive generic fallback.
- Pi-compatible Skill invocation formatting.
- `ExecutionJob*` domain aliases and persistent pipeline columns.
- Stage-attempt `AgentExecution` identity.
- Append-only `execution_artifacts` storage.
- A repeatable, data-preserving PostgreSQL upgrade test.

It does not create pipeline commands, runners, Chat chips, parameter pickers,
plan confirmation, retries/reruns, or the four first-party writing Skills.
Those are Phase 2–4 plans and depend on this phase's interfaces.
The restrictive binding is frozen in Phase 1; Phase 2 applies its capability
intersection to pipeline tools. Existing single-Skill Chat keeps its current
interactive approval policy in this phase.

## Global constraints

- Work only on `feat/skill-pipeline-design` or a successor isolated feature branch; do not edit `develop` or `main` directly.
- Keep `/api/jobs` and the physical tables `content_jobs`, `content_job_steps`, and `content_job_events`.
- New pipeline code imports Ediora aliases. Existing `ContentJob*` mapped classes and physical tables remain available unchanged.
- `SKILL.md` is sufficient for importing and running a standard Skill. `SKILL.json` remains optional legacy metadata.
- Agent Skills `name` validation is 1–64 lowercase letters, numbers, or hyphens; no leading, trailing, or consecutive hyphens; the installed directory name matches `name`.
- Agent Skills `description` is required, non-empty, and at most 1024 characters. Optional `compatibility` is at most 500 characters; `metadata` values are strings.
- `allowed-tools` is parsed as a request only. It never grants an Ediora tool permission.
- Uploaded packages are persisted disabled with review state `pending`. Explicitly enabling one records review state `approved`.
- Package `scripts/` and `assets/` are preserved, but Phase 1 exposes only validated text files under `references/` to the Agent. No package script can execute.
- PostgreSQL is authoritative. The migration is additive, idempotent, and runs in the existing `init_db()` transaction.
- Historical `agent_executions` rows retain `step_id = NULL` and legacy one-execution-per-job semantics.
- Existing plain Chat, single-Skill Chat, scheduled flows, Job APIs, and Agent logs must remain green.
- Use `/home/violet/miniconda3/envs/wems/bin/python -m pytest` for backend tests and `pnpm exec vitest run <exact files>` from `web` for frontend tests.
- Use focused tests; do not run the full repository suite unless focused coverage exposes an unbounded regression.

## File map

### Skill package layer

- Create `web/lib/skills/standard.ts`: Agent Skills frontmatter parsing, compatibility diagnostics, installed-directory validation, resource inventory, and deterministic package digest.
- Create `web/lib/skills/standard.test.ts`: specification boundaries, legacy discovery, directory matching, and digest tests.
- Modify `web/package.json` and `web/pnpm-lock.yaml`: add direct `yaml` dependency.
- Modify `web/lib/skills/registry.ts`: consume the standard parser, expose normalized metadata/digest/review state, preserve legacy `SKILL.json`, disable new uploads, and restrict readable resources to `references/`.
- Modify `web/lib/skills/registry.test.ts` and `web/lib/skills/bundled-skills.test.ts`: new registry contract and compatibility regressions.
- Create `web/lib/skills/bindings.ts`: Ediora-owned binding types, static built-in binding map, and restrictive generic fallback.
- Create `web/lib/skills/bindings.test.ts`: binding resolution and immutability tests.
- Create `web/lib/skills/invocation.ts`: Pi-compatible `formatSkillInvocation` adapter using a logical `skill://` location.
- Create `web/lib/skills/invocation.test.ts`: exact formatting and instruction-boundary tests.

### Skill management surface

- Modify `web/lib/api/skills.ts`: normalized metadata, digest, compatibility, and review-state response types.
- Modify `web/app/api/skills/route.test.ts`: metadata privacy and disabled-upload API tests.
- Modify `web/app/settings/sections/SkillsSection.tsx`: pending-review display and explicit enable action.
- Modify `web/app/settings/sections/SkillsSection.test.tsx`: pending-review and approval interaction tests.

### Durable execution layer

- Modify `backend/models.py`: additive Job columns, Stage-scoped Agent executions, partial unique indexes, `ExecutionArtifact`, and `ExecutionJob*` aliases.
- Create `backend/execution_jobs.py`: canonical imports for new pipeline code while re-exporting existing Job transition functions.
- Create `backend/execution_artifacts.py`: validated append/list/supersede operations without implicit commits or deletes.
- Create `backend/tests/test_execution_artifacts.py`: artifact invariants and history tests.
- Modify `backend/agent_execution_service.py`: `step_id`/`attempt` identity and legacy defaults.
- Modify `backend/routers/agent_executions.py`, `backend/routers/jobs.py`, and `backend/routers/creation_rules.py`: optional Stage-attempt fields and deterministic latest-by-job compatibility reads.
- Modify `backend/tests/test_agent_execution_service.py`, `backend/tests/test_agent_executions_router.py`, `backend/tests/test_jobs_router.py`, and `backend/tests/test_daily_creation_rules_router.py`: legacy and Stage-scoped execution tests.
- Modify `backend/database.py`: `migrate_skill_pipeline_schema()` before and after metadata creation.
- Create `backend/tests/test_database_skill_pipeline_migration.py`: populated previous-schema upgrade, second-run idempotency, and data-integrity proof.
- Modify `backend/tests/test_database_init_postgres.py` and `backend/tests/test_models_schema.py`: current schema assertions.

---

### Task 1: Parse and fingerprint standard Agent Skills

**Files:**

- Create: `web/lib/skills/standard.ts`
- Create: `web/lib/skills/standard.test.ts`
- Modify: `web/package.json`
- Modify: `web/pnpm-lock.yaml`

**Interfaces:**

```ts
export type SkillDocument = {
  name: string
  description: string
  version: string
  license?: string
  compatibility?: string
  metadata: Readonly<Record<string, string>>
  requestedAllowedTools: readonly string[]
  body: string
  standardCompatible: boolean
  diagnostics: readonly SkillDiagnosticCode[]
}

export type SkillDiagnosticCode =
  | 'legacy_name'
  | 'legacy_directory'
  | 'legacy_metadata'

export type SkillPackageFile = {
  path: string
  bytes: number
  kind: 'reference' | 'asset' | 'script' | 'other'
}

export function parseSkillDocument(
  contents: string,
  options: { expectedDirectoryName?: string; allowLegacy: boolean },
): SkillDocument

export async function inspectSkillPackage(
  directory: string,
): Promise<{ digest: string; files: readonly SkillPackageFile[] }>
```

`inspectSkillPackage` computes SHA-256 over each regular file's normalized
relative path, byte length, and bytes in lexical path order. It rejects
symlinks and does not execute or decode binary package files.

- [ ] **Step 1: Write the failing standard-document tests**

Create `standard.test.ts` with concrete cases:

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { inspectSkillPackage, parseSkillDocument } from './standard'

const valid = `---\nname: source-research\ndescription: Researches attributable sources when a user needs evidence.\nmetadata:\n  version: "1.2.0"\n  ediora-display-name: "资料研究"\nallowed-tools: search fetch\n---\n\n# Workflow\n\nResearch first.\n`

describe('standard Agent Skill document', () => {
  it('normalizes standard frontmatter and keeps allowed-tools non-authoritative', () => {
    const parsed = parseSkillDocument(valid, {
      expectedDirectoryName: 'source-research',
      allowLegacy: false,
    })

    expect(parsed).toMatchObject({
      name: 'source-research',
      version: '1.2.0',
      metadata: {
        version: '1.2.0',
        'ediora-display-name': '资料研究',
      },
      requestedAllowedTools: ['search', 'fetch'],
      body: expect.stringContaining('# Workflow'),
      standardCompatible: true,
    })
  })

  it.each([
    'Uppercase',
    '-leading',
    'trailing-',
    'double--hyphen',
    'a'.repeat(65),
  ])('rejects invalid standard name %s', name => {
    const document = valid.replace('source-research', name)
    expect(() => parseSkillDocument(document, {
      expectedDirectoryName: name,
      allowLegacy: false,
    })).toThrow(/name/i)
  })

  it('rejects an empty description and a parent-directory mismatch', () => {
    expect(() => parseSkillDocument(
      valid.replace(
        'description: Researches attributable sources when a user needs evidence.',
        'description: ""',
      ),
      { expectedDirectoryName: 'source-research', allowLegacy: false },
    )).toThrow(/description/i)

    expect(() => parseSkillDocument(valid, {
      expectedDirectoryName: 'different-name',
      allowLegacy: false,
    })).toThrow(/directory/i)
  })

  it('keeps a discoverable legacy name only in compatibility mode', () => {
    const legacy = valid.replace('source-research', 'Legacy_Name')
    const parsed = parseSkillDocument(legacy, { allowLegacy: true })
    expect(parsed.standardCompatible).toBe(false)
    expect(parsed.diagnostics).toContain('legacy_name')
    expect(() => parseSkillDocument(legacy, { allowLegacy: false })).toThrow()
  })
})
```

- [ ] **Step 2: Run the new test and verify the missing-module failure**

Run:

```bash
cd web
pnpm exec vitest run lib/skills/standard.test.ts
```

Expected: FAIL because `./standard` does not exist.

- [ ] **Step 3: Add the direct YAML dependency**

Run:

```bash
cd web
pnpm add yaml
```

Confirm `yaml` appears in `dependencies` and `web/pnpm-lock.yaml` changes only as
required for that direct dependency.

- [ ] **Step 4: Implement strict parsing with an explicit legacy fallback**

Use `parseDocument` from `yaml`, reject duplicate YAML keys and non-object
frontmatter, and apply these constants:

```ts
const standardName = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/
const legacyName = /^[A-Za-z0-9._-]{1,80}$/
const MAX_DESCRIPTION = 1024
const MAX_COMPATIBILITY = 500
```

Read version from `metadata.version` first, then from a string top-level
`version` for existing Ediora packages. Validate that every `metadata` value is
a string. Parse `allowed-tools` as whitespace-separated requested names, but
return no approval boolean or effective-tool list.

- [ ] **Step 5: Add deterministic package inspection tests and implementation**

Extend `standard.test.ts`:

```ts
it('fingerprints all regular package files and classifies resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ediora-standard-skill-'))
  try {
    await mkdir(join(root, 'references'))
    await mkdir(join(root, 'scripts'))
    await writeFile(join(root, 'SKILL.md'), valid)
    await writeFile(join(root, 'references', 'rules.md'), 'rules')
    await writeFile(join(root, 'scripts', 'collect.py'), 'print("no execution")')

    const first = await inspectSkillPackage(root)
    await writeFile(join(root, 'references', 'rules.md'), 'changed rules')
    const second = await inspectSkillPackage(root)

    expect(first.files).toEqual(expect.arrayContaining([
      { path: 'references/rules.md', bytes: 5, kind: 'reference' },
      { path: 'scripts/collect.py', bytes: 21, kind: 'script' },
    ]))
    expect(second.digest).not.toBe(first.digest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
```

Implement recursive, lexical traversal with `lstat`. Reject every symlink before
hashing. Normalize separators to `/` and feed path, byte count, and bytes into
one `createHash('sha256')` instance.

- [ ] **Step 6: Run and commit Task 1**

Run:

```bash
cd web
pnpm exec vitest run lib/skills/standard.test.ts
pnpm exec eslint lib/skills/standard.ts lib/skills/standard.test.ts
```

Expected: all tests pass and ESLint exits 0.

Commit:

```bash
git add web/package.json web/pnpm-lock.yaml web/lib/skills/standard.ts web/lib/skills/standard.test.ts
git commit -m "feat: parse standard agent skills"
```

### Task 2: Make the Skill registry standards-aware and review-gated

**Files:**

- Modify: `web/lib/skills/registry.ts`
- Modify: `web/lib/skills/registry.test.ts`
- Modify: `web/lib/skills/bundled-skills.test.ts`

**Interfaces:**

```ts
export type SkillReviewState = 'approved' | 'pending'

export type ManagedSkill = {
  name: string
  description: string
  version: string
  digest: string
  source: 'builtin' | 'uploaded'
  enabled: boolean
  reviewState: SkillReviewState
  standardCompatible: boolean
  diagnostics: readonly string[]
}

export type RegisteredSkill = ManagedSkill & {
  instructions: string
  content: string
  directory: string
  packageFiles: readonly SkillPackageFile[]
  requestedAllowedTools: readonly string[]
  execution?: SkillExecutionHints
}
```

Persisted state becomes:

```ts
type PersistedSkillState = {
  source: SkillSource
  enabled: boolean
  reviewState: SkillReviewState
}
```

- [ ] **Step 1: Change registry tests to the standard lowercase contract and add failing trust-state cases**

Replace uppercase fixture names with matching lowercase directory/name values.
Add:

```ts
it('installs uploaded standard Skills disabled and pending review', async () => {
  const installed = await installSkillArchive(zipSync({
    'custom-skill/SKILL.md': strToU8(skillMarkdown('custom-skill')),
    'custom-skill/scripts/run.sh': strToU8('exit 0'),
  }))

  expect(installed).toEqual([
    expect.objectContaining({
      name: 'custom-skill',
      enabled: false,
      reviewState: 'pending',
      standardCompatible: true,
    }),
  ])
  expect(await getEnabledSkill('custom-skill')).toBeNull()

  const approved = await setSkillEnabled('custom-skill', true)
  expect(approved).toMatchObject({
    enabled: true,
    reviewState: 'approved',
  })
  expect(await getEnabledSkill('custom-skill')).not.toBeNull()
})

it('never exposes package scripts through the reference reader', async () => {
  await installSkillArchive(zipSync({
    'scripted/SKILL.md': strToU8(skillMarkdown('scripted')),
    'scripted/references/rules.md': strToU8('rules'),
    'scripted/scripts/readme.md': strToU8('do not load'),
  }))
  await setSkillEnabled('scripted', true)

  await expect(listSkillReferences('scripted')).resolves.toEqual([
    { path: 'references/rules.md', bytes: 5 },
  ])
  await expect(readSkillReference(
    'scripted',
    'scripts/readme.md',
  )).rejects.toMatchObject({ code: 'invalid_reference' })
})
```

Add a regression proving a `SKILL.md`-only archive has default execution hints
and no manifest error.

- [ ] **Step 2: Run focused registry tests and verify contract failures**

Run:

```bash
cd web
pnpm exec vitest run lib/skills/registry.test.ts lib/skills/bundled-skills.test.ts
```

Expected: FAIL because uploads are currently enabled and the normalized fields
do not exist.

- [ ] **Step 3: Replace local frontmatter parsing with `standard.ts`**

Delete `readFrontmatterValue`, `parseSkillMetadata`, and the permissive local
name pattern from `registry.ts`. Discovery calls `parseSkillDocument` with
`allowLegacy: true` so installed historical packages remain visible. New ZIP
installation calls it with `allowLegacy: false` and writes each Skill under its
validated standard name.

Populate `content` from the Markdown body and `instructions` from the original
`SKILL.md` for existing runtime compatibility. Populate `digest` and
`packageFiles` from `inspectSkillPackage` after installation/discovery.

- [ ] **Step 4: Implement review-state compatibility**

Use these defaults:

```ts
function defaultState(source: SkillSource): PersistedSkillState {
  return source === 'builtin'
    ? { source, enabled: true, reviewState: 'approved' }
    : { source, enabled: false, reviewState: 'pending' }
}
```

When reading an old state entry without `reviewState`, treat an uploaded entry
that already has an explicit `enabled` boolean as `approved`; this preserves
previously managed Skills. A newly discovered runtime directory without a
state entry is disabled/pending. `setSkillEnabled(name, true)` changes pending
to approved. Disabling an approved Skill keeps it approved.

- [ ] **Step 5: Keep `SKILL.json` optional and block script reads**

Retain `readManifestFromDirectory` and its current safe execution-hint schema.
Missing `SKILL.json` returns the current defaults. Require every
`preloadReferences` entry and every `readSkillReference` request to begin with
`references/`. Continue rejecting traversal, symlinks, unsupported extensions,
invalid UTF-8, NUL bytes, and configured size limits.

- [ ] **Step 6: Run registry, bundled-Skill, Chat route, and runtime compatibility tests**

Run:

```bash
cd web
pnpm exec vitest run \
  lib/skills/standard.test.ts \
  lib/skills/registry.test.ts \
  lib/skills/bundled-skills.test.ts \
  lib/ai/discover-skills.test.ts \
  app/api/chat/route.test.ts \
  lib/ai/global-chat-tools.test.ts
```

Expected: all tests pass. Existing bundled Skills remain selectable and a
`SKILL.md`-only package loads with default execution hints.

- [ ] **Step 7: Commit Task 2**

```bash
git add web/lib/skills/registry.ts web/lib/skills/registry.test.ts web/lib/skills/bundled-skills.test.ts
git commit -m "feat: review-gate uploaded skills"
```

### Task 3: Add external Skill bindings and the Pi-compatible invocation boundary

**Files:**

- Create: `web/lib/skills/bindings.ts`
- Create: `web/lib/skills/bindings.test.ts`
- Create: `web/lib/skills/invocation.ts`
- Create: `web/lib/skills/invocation.test.ts`

**Interfaces:**

```ts
export type SkillParameterKind = 'writing_plan' | 'publish_account'
export type SkillPrimaryOutput = 'research_bundle' | 'article' | 'generic'
export type SkillCapabilityProfile =
  | 'restricted'
  | 'research'
  | 'writing'
  | 'draft-writing'
  | 'transform'
  | 'interactive'

export type SkillBinding = {
  skillName: string
  displayName: string
  description?: string
  parameter?: {
    kind: SkillParameterKind
    required: boolean
  }
  primaryOutput: SkillPrimaryOutput
  capabilityProfile: SkillCapabilityProfile
  defaultEnabled: boolean
}

export function createSkillBindingResolver(
  bindings: readonly SkillBinding[],
): (skill: Pick<ManagedSkill, 'name' | 'description'>) => Readonly<SkillBinding>

export function resolveSkillBinding(
  skill: Pick<ManagedSkill, 'name' | 'description'>,
): Readonly<SkillBinding>

export function formatSkillInvocation(
  skill: Pick<RegisteredSkill, 'name' | 'content'>,
  additionalInstructions?: string,
): string
```

- [ ] **Step 1: Write failing binding tests**

```ts
import { describe, expect, it } from 'vitest'

import {
  createSkillBindingResolver,
  resolveSkillBinding,
} from './bindings'

describe('Skill bindings', () => {
  it('uses a restrictive generic binding for a standard package with no binding', () => {
    expect(resolveSkillBinding({
      name: 'portable-skill',
      description: 'Portable',
    })).toEqual({
      skillName: 'portable-skill',
      displayName: 'portable-skill',
      description: 'Portable',
      primaryOutput: 'generic',
      capabilityProfile: 'restricted',
      defaultEnabled: false,
    })
  })

  it('returns an immutable Ediora binding outside the package', () => {
    const resolve = createSkillBindingResolver([{
      skillName: 'bound-skill',
      displayName: '绑定技能',
      primaryOutput: 'article',
      capabilityProfile: 'writing',
      defaultEnabled: true,
    }])
    const binding = resolve({
      name: 'bound-skill',
      description: 'Bound',
    })
    expect(binding.displayName).toBe('绑定技能')
    expect(Object.isFrozen(binding)).toBe(true)
  })
})
```

`createSkillBindingResolver` freezes a private `Map` built from the supplied
array, rejects duplicate `skillName` entries, and returns frozen copies.
Production `resolveSkillBinding` is created from a frozen module-local array.
Do not read binding data from `SKILL.json`.

- [ ] **Step 2: Write the exact invocation-format tests**

```ts
import { describe, expect, it } from 'vitest'
import { formatSkillInvocation } from './invocation'

describe('formatSkillInvocation', () => {
  const skill = {
    name: 'source-research',
    content: '# Workflow\n\nResearch attributable sources.',
  }

  it('matches the Pi skill block semantics with a logical location', () => {
    expect(formatSkillInvocation(skill, 'Focus on local-first AI.')).toBe(
      '<skill name="source-research" location="skill://source-research/SKILL.md">\n'
      + 'References are relative to skill://source-research/.\n\n'
      + '# Workflow\n\nResearch attributable sources.\n'
      + '</skill>\n\n'
      + 'Focus on local-first AI.',
    )
  })

  it('does not add a blank instruction suffix when none is supplied', () => {
    expect(formatSkillInvocation(skill)).toMatch(/<\/skill>$/)
  })
})
```

- [ ] **Step 3: Run the exact tests and verify missing-module failures**

```bash
cd web
pnpm exec vitest run lib/skills/bindings.test.ts lib/skills/invocation.test.ts
```

- [ ] **Step 4: Implement bindings and formatter**

The formatter follows Pi's `<skill name location>` block and relative-reference
sentence, but uses `skill://<name>/SKILL.md` instead of exposing an absolute
server filesystem path. Escape XML attribute values even though standard names
already have a restricted alphabet. Append `additionalInstructions` exactly
once when it is non-empty.

The generic binding requests no parameter, emits `generic`, uses `restricted`,
and is not enabled by binding default. Registry review/enabled state remains
the final availability authority.

- [ ] **Step 5: Run and commit Task 3**

```bash
cd web
pnpm exec vitest run lib/skills/bindings.test.ts lib/skills/invocation.test.ts
pnpm exec eslint \
  lib/skills/bindings.ts \
  lib/skills/bindings.test.ts \
  lib/skills/invocation.ts \
  lib/skills/invocation.test.ts
```

```bash
git add web/lib/skills/bindings.ts web/lib/skills/bindings.test.ts web/lib/skills/invocation.ts web/lib/skills/invocation.test.ts
git commit -m "feat: add skill binding adapter"
```

### Task 4: Expose review state safely in Skill management

**Files:**

- Modify: `web/lib/api/skills.ts`
- Modify: `web/app/api/skills/route.test.ts`
- Modify: `web/app/settings/sections/SkillsSection.tsx`
- Modify: `web/app/settings/sections/SkillsSection.test.tsx`

**Interfaces:**

The public management response includes:

```ts
export type ManagedSkill = {
  name: string
  description: string
  version: string
  digest: string
  source: 'builtin' | 'uploaded'
  enabled: boolean
  reviewState: 'approved' | 'pending'
  standardCompatible: boolean
  diagnostics: readonly string[]
}
```

It never includes `instructions`, `content`, `directory`, package file contents,
or `requestedAllowedTools`.

- [ ] **Step 1: Add failing API assertions**

Normalize its fixture Skill names and directory names to lowercase standard
slugs. Then update `web/app/api/skills/route.test.ts` so a successful upload
expects:

```ts
expect(await uploaded.json()).toEqual([
  expect.objectContaining({
    name: 'custom',
    source: 'uploaded',
    enabled: false,
    reviewState: 'pending',
    standardCompatible: true,
    digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  }),
])
```

Also assert the serialized object has none of:

```ts
expect(Object.keys(listedSkill)).not.toEqual(expect.arrayContaining([
  'instructions',
  'content',
  'directory',
  'requestedAllowedTools',
]))
```

- [ ] **Step 2: Add failing Settings interaction tests**

Populate every new `ManagedSkill` field in the Settings fixtures, use
lowercase standard names, and assert:

```ts
expect(screen.getByText('待审核')).toBeVisible()
expect(screen.getByRole('switch', {
  name: '启用 custom',
})).not.toBeChecked()

fireEvent.click(screen.getByRole('switch', { name: '启用 custom' }))
await waitFor(() => {
  expect(updateSkillEnabled).toHaveBeenCalledWith('custom', true)
})
expect(await screen.findByText('已审核')).toBeVisible()
```

The upload test must assert that the refreshed list shows `待审核` and that the
success copy says the package must be reviewed and enabled before use.

- [ ] **Step 3: Run API and Settings tests and verify failure**

```bash
cd web
pnpm exec vitest run \
  app/api/skills/route.test.ts \
  app/settings/sections/SkillsSection.test.tsx \
  lib/api/skills.test.ts
```

- [ ] **Step 4: Implement the response type and UI state**

Update the client type exactly once in `web/lib/api/skills.ts`. In
`SkillsSection`:

- Show `内置` or `已上传` as the source badge.
- Show `待审核` only for pending uploads and `已审核` for approved uploads.
- Keep the existing switch as the explicit review-and-enable action.
- Keep deletion available only for uploaded Skills.
- Show compatibility diagnostics as non-secret text below an incompatible
  historical package; do not expose package contents.

- [ ] **Step 5: Run and commit Task 4**

```bash
cd web
pnpm exec vitest run \
  app/api/skills/route.test.ts \
  app/settings/sections/SkillsSection.test.tsx \
  lib/api/skills.test.ts
pnpm exec eslint \
  lib/api/skills.ts \
  app/api/skills/route.test.ts \
  app/settings/sections/SkillsSection.tsx \
  app/settings/sections/SkillsSection.test.tsx
```

```bash
git add web/lib/api/skills.ts web/app/api/skills/route.test.ts web/app/settings/sections/SkillsSection.tsx web/app/settings/sections/SkillsSection.test.tsx
git commit -m "feat: surface skill review state"
```

### Task 5: Add durable execution domain models without renaming physical tables

**Files:**

- Modify: `backend/models.py`
- Create: `backend/execution_jobs.py`
- Modify: `backend/tests/test_models_schema.py`

**Interfaces:**

`backend.models` exports:

```python
ExecutionJob = ContentJob
ExecutionJobStep = ContentJobStep
ExecutionJobEvent = ContentJobEvent
```

`ContentJob` gains:

```python
plan_version: Mapped[int] = mapped_column(
    Integer, nullable=False, default=1, server_default=text("1"),
)
run_epoch: Mapped[int] = mapped_column(
    Integer, nullable=False, default=1, server_default=text("1"),
)
updated_at: Mapped[datetime] = mapped_column(
    DateTime(timezone=True),
    default=now_utc,
    onupdate=now_utc,
    server_default=text("CURRENT_TIMESTAMP"),
)
```

`AgentExecution` gains nullable `step_id` and non-null `attempt` with Python
and server defaults of 1, and removes column-level `unique=True` from `job_id`.
`ExecutionArtifact.status` likewise has Python/server default `active`.

`ExecutionArtifact` maps `execution_artifacts` with:

```python
id: int
job_id: int
step_id: int
attempt: int
kind: str
role: str
title: str
text_content: str | None
structured_content: object | None
digest: str
status: str
created_at: datetime
```

- [ ] **Step 1: Write failing metadata tests**

Add to `test_models_schema.py`:

```python
def test_execution_job_aliases_keep_physical_tables():
    from models import (
        ContentJob,
        ContentJobEvent,
        ContentJobStep,
        ExecutionJob,
        ExecutionJobEvent,
        ExecutionJobStep,
    )

    assert ExecutionJob is ContentJob
    assert ExecutionJobStep is ContentJobStep
    assert ExecutionJobEvent is ContentJobEvent
    assert ExecutionJob.__table__.name == "content_jobs"


def test_agent_execution_and_artifact_constraints():
    from models import AgentExecution, ExecutionArtifact

    assert {"step_id", "attempt"} <= set(AgentExecution.__table__.c.keys())
    index_names = {index.name for index in AgentExecution.__table__.indexes}
    assert {
        "uq_agent_executions_legacy_job",
        "uq_agent_executions_stage_attempt",
    } <= index_names
    assert ExecutionArtifact.__table__.name == "execution_artifacts"
    assert {
        "job_id",
        "step_id",
        "attempt",
        "kind",
        "role",
        "digest",
        "status",
    } <= set(ExecutionArtifact.__table__.c.keys())
```

- [ ] **Step 2: Run the model test and verify missing schema failures**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_models_schema.py -q
```

- [ ] **Step 3: Implement additive model fields and partial uniqueness**

Define these `AgentExecution` indexes:

```python
Index(
    "uq_agent_executions_legacy_job",
    "job_id",
    unique=True,
    postgresql_where=text("step_id IS NULL"),
    sqlite_where=text("step_id IS NULL"),
),
Index(
    "uq_agent_executions_stage_attempt",
    "job_id",
    "step_id",
    "attempt",
    unique=True,
    postgresql_where=text("step_id IS NOT NULL"),
    sqlite_where=text("step_id IS NOT NULL"),
),
```

`step_id` references `content_job_steps.id` and is nullable. `attempt` defaults
to 1. Keep the existing non-unique `job_id` lookup index.

For artifacts, add checks for `role IN ('primary', 'auxiliary')` and
`status IN ('active', 'superseded')`, indexes on `job_id` and `step_id`, and a
partial unique index named `uq_execution_artifacts_primary_attempt` on
`(step_id, attempt)` where `role = 'primary'`.
Both content columns remain nullable because the service enforces that at least
one contains data.

- [ ] **Step 4: Add the canonical service-module bridge**

Create `backend/execution_jobs.py`:

```python
"""Canonical Ediora execution-job domain exports."""

from content_jobs import (
    InvalidJobTransition,
    add_locked_job_event,
    cancel_job,
    create_job,
    create_or_get_job,
    fail_locked_step,
    fail_step,
    lock_content_job_row,
    record_event,
    retry_locked_step,
    retry_step,
    start_step,
    succeed_job,
    succeed_locked_step,
    succeed_step,
)
from models import ExecutionJob, ExecutionJobEvent, ExecutionJobStep

__all__ = [
    "InvalidJobTransition",
    "ExecutionJob",
    "ExecutionJobEvent",
    "ExecutionJobStep",
    "add_locked_job_event",
    "cancel_job",
    "create_job",
    "create_or_get_job",
    "fail_locked_step",
    "fail_step",
    "lock_content_job_row",
    "record_event",
    "retry_locked_step",
    "retry_step",
    "start_step",
    "succeed_job",
    "succeed_locked_step",
    "succeed_step",
]
```

Do not move `content_jobs.py` in Phase 1. Phase 2 imports new pipeline code from
`execution_jobs.py` while existing flows keep their old imports.

- [ ] **Step 5: Run and commit Task 5**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_models_schema.py -q
```

```bash
git add backend/models.py backend/execution_jobs.py backend/tests/test_models_schema.py
git commit -m "feat: add execution pipeline models"
```

### Task 6: Migrate a populated previous PostgreSQL schema without data loss

**Files:**

- Modify: `backend/database.py`
- Create: `backend/tests/test_database_skill_pipeline_migration.py`
- Modify: `backend/tests/test_database_init_postgres.py`

**Interfaces:**

```python
async def migrate_skill_pipeline_schema(
    conn,
    *,
    assert_complete: bool = True,
) -> None:
    """Bring execution-pipeline tables to the current additive schema."""
```

`init_db()` calls the helper once before `Base.metadata.create_all` and once
after it. The first call upgrades existing tables so metadata indexes can be
created safely; the second validates or completes a fresh database.

- [ ] **Step 1: Create a failing populated-legacy migration test**

In `test_database_skill_pipeline_migration.py`:

1. Reload `database`/`models` using the existing PostgreSQL test fixture.
2. Run `Base.metadata.create_all`.
3. Drop `execution_artifacts`, the two new partial Agent indexes, and the new
   `agent_executions`/`content_jobs` columns.
4. Restore the previous single-column unique constraint on
   `agent_executions.job_id`.
5. Insert one Job, two Job steps, one Job event, one Agent execution, one tool
   call, one model message, Agent log events, one Chat session/message, and one
   scheduled creation rule with non-empty JSON payloads.
6. Snapshot every inserted row as mappings and hash canonical JSON payloads.
7. Call `init_db()` twice.
8. Assert all IDs, counts, text fields, timestamps, relation IDs, and payload
   hashes equal the pre-upgrade snapshot.

Use these schema assertions:

```python
assert {"plan_version", "run_epoch", "updated_at"} <= tables["content_jobs"]
assert {"step_id", "attempt"} <= tables["agent_executions"]
assert "execution_artifacts" in tables
assert await scalar(
    connection,
    "SELECT COUNT(*) FROM agent_executions WHERE step_id IS NULL",
) == 1
```

Then insert two `ContentJobStep` attempts and two `AgentExecution` rows for the
same Job using non-null step IDs; assert both inserts succeed. Assert a second
legacy null-step execution for that Job and a duplicate
`(job_id, step_id, attempt)` execution each raise `IntegrityError`.

Add a rollback proof using a separate downgraded fixture:

```python
with pytest.raises(RuntimeError, match="abort migration"):
    async with engine.begin() as connection:
        await migrate_skill_pipeline_schema(
            connection,
            assert_complete=False,
        )
        raise RuntimeError("abort migration")

async with engine.connect() as connection:
    columns = await column_names(connection, "agent_executions")
assert "step_id" not in columns
```

This proves PostgreSQL DDL rolls back with the existing `engine.begin()`
boundary instead of leaving a partially upgraded schema.

- [ ] **Step 2: Run the migration test and verify failure**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_database_skill_pipeline_migration.py -q
```

Expected: FAIL because `migrate_skill_pipeline_schema` and current columns do
not exist.

- [ ] **Step 3: Implement the idempotent migration**

The helper must:

- Return without error when neither target table exists.
- Add `content_jobs.plan_version INTEGER NOT NULL DEFAULT 1`,
  `run_epoch INTEGER NOT NULL DEFAULT 1`, and a timezone-aware `updated_at`
  defaulted from existing `created_at` where available.
- Add nullable `agent_executions.step_id` and
  `attempt INTEGER NOT NULL DEFAULT 1`.
- Inspect unique constraints/indexes and drop only the old uniqueness object
  whose ordered column list is exactly `["job_id"]`.
- Add the Stage foreign key only after existing rows are safely null.
- Create `uq_agent_executions_legacy_job` and
  `uq_agent_executions_stage_attempt` with the predicates in Task 5.
- Let metadata create `execution_artifacts` on a fresh or upgraded database.
- Re-inspect and raise `RuntimeError` if required columns, indexes, constraints,
  or the artifact table are absent after the post-create call.

Use `conn.dialect.identifier_preparer.quote(name)` for inspected database
identifier names. Never interpolate an uninspected request value into DDL.

- [ ] **Step 4: Wire migration order into `init_db()`**

The relevant order is:

```python
await migrate_content_job_idempotency_schema(conn)
await migrate_skill_pipeline_schema(conn, assert_complete=False)
await conn.run_sync(Base.metadata.create_all)
await migrate_skill_pipeline_schema(conn, assert_complete=True)
```

Keep both calls inside the existing `async with engine.begin()` transaction.
Do not add a second migration framework, table rename, row rewrite, or cleanup
delete.

- [ ] **Step 5: Extend the current-schema smoke test**

In `test_database_init_postgres.py`, add `execution_artifacts` to the expected
table set and assert the new columns on `content_jobs` and `agent_executions`.
Keep its existing two consecutive `init_db()` calls.

- [ ] **Step 6: Run migration and existing startup regressions**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_database_skill_pipeline_migration.py \
  tests/test_database_init_postgres.py \
  tests/test_content_jobs.py \
  tests/test_models_schema.py -q
```

Expected: all tests pass against PostgreSQL. A skipped or unavailable
PostgreSQL fixture does not satisfy this task's release gate.

- [ ] **Step 7: Commit Task 6**

```bash
git add backend/database.py backend/tests/test_database_skill_pipeline_migration.py backend/tests/test_database_init_postgres.py
git commit -m "feat: migrate skill pipeline schema"
```

### Task 7: Scope Agent executions to Stage attempts while preserving legacy callers

**Files:**

- Modify: `backend/agent_execution_service.py`
- Modify: `backend/routers/agent_executions.py`
- Modify: `backend/routers/jobs.py`
- Modify: `backend/routers/creation_rules.py`
- Modify: `backend/tests/test_agent_execution_service.py`
- Modify: `backend/tests/test_agent_executions_router.py`
- Modify: `backend/tests/test_jobs_router.py`
- Modify: `backend/tests/test_daily_creation_rules_router.py`

**Interfaces:**

```python
async def ensure_agent_execution(
    session: AsyncSession,
    *,
    job_id: int,
    objective: str,
    skill_mode: str,
    skill_name: str | None,
    step_id: int | None = None,
    attempt: int = 1,
) -> AgentExecution:
    ...


async def latest_agent_execution_for_job(
    session: AsyncSession,
    job_id: int,
) -> AgentExecution | None:
    ...
```

Worker API create payload adds:

```python
step_id: int | None = Field(default=None, gt=0)
attempt: int = Field(default=1, gt=0)
```

- [ ] **Step 1: Add failing service tests for identity and ownership**

Create two `ContentJobStep` records for one Job and assert:

```python
first = await ensure_agent_execution(
    db,
    job_id=job.id,
    step_id=step_one.id,
    attempt=1,
    objective="research",
    skill_mode="manual",
    skill_name="source-research",
)
same = await ensure_agent_execution(
    db,
    job_id=job.id,
    step_id=step_one.id,
    attempt=1,
    objective="ignored on replay",
    skill_mode="manual",
    skill_name="source-research",
)
second = await ensure_agent_execution(
    db,
    job_id=job.id,
    step_id=step_two.id,
    attempt=1,
    objective="write",
    skill_mode="manual",
    skill_name="writing-plan",
)

assert same.id == first.id
assert second.id != first.id
assert (first.step_id, first.attempt) == (step_one.id, 1)
```

Also assert a step owned by another Job or an `attempt` different from the
step row's attempt raises `KeyError` before inserting an execution.
Use two independent sessions to race the same Stage identity and assert both
callers receive the same winning execution ID and only one row is persisted.

- [ ] **Step 2: Add failing router compatibility tests**

POST one request without Stage fields and assert the response contains
`step_id: null` and `attempt: 1`. POST two Stage-scoped requests for one Job and
assert distinct IDs. `latest_agent_execution_for_job` and
`GET /by-job/{job_id}` order by `AgentExecution.id.desc()` and return the newest
row. Update the existing Job and creation-rule singular Agent-log projections
to use that helper. In the creation-rule bulk query, order by `(job_id, id)`
ascending before building the dictionary so the newest row wins. This is a
deterministic compatibility projection; Phase 2 replaces it with the complete
pipeline trajectory for pipeline Jobs.

- [ ] **Step 3: Run exact Agent execution tests and verify failure**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_agent_execution_service.py \
  tests/test_agent_executions_router.py -q
```

- [ ] **Step 4: Implement Stage-aware lookup and validation**

For legacy calls, query `job_id == value AND step_id IS NULL`. For Stage calls,
lock/read `ContentJobStep` and validate `step.job_id == job_id` and
`step.attempt == attempt`, then query the exact
`(job_id, step_id, attempt)` identity. Preserve existing event, checkpoint,
capability-pin, tool replay, and terminal-state behavior.

Wrap creation in `session.begin_nested()`. On the partial-unique
`IntegrityError`, re-query and return the winning identity. Do not roll back a
caller-owned outer transaction or create a second `execution/start` event.

Include `step_id` and `attempt` in `execution/start` event payloads and router
responses. Existing callers need no argument changes because defaults preserve
legacy behavior.

- [ ] **Step 5: Run direct and Job API regressions**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_agent_execution_service.py \
  tests/test_agent_executions_router.py \
  tests/test_jobs_router.py \
  tests/test_daily_creation_rules_router.py \
  tests/test_agent_logs_router.py -q
```

- [ ] **Step 6: Commit Task 7**

```bash
git add backend/agent_execution_service.py backend/routers/agent_executions.py backend/routers/jobs.py backend/routers/creation_rules.py backend/tests/test_agent_execution_service.py backend/tests/test_agent_executions_router.py backend/tests/test_jobs_router.py backend/tests/test_daily_creation_rules_router.py
git commit -m "feat: scope agent executions to job steps"
```

### Task 8: Persist append-only execution artifacts

**Files:**

- Create: `backend/execution_artifacts.py`
- Create: `backend/tests/test_execution_artifacts.py`

**Interfaces:**

```python
class ExecutionArtifactError(ValueError):
    pass


async def append_execution_artifact(
    session: AsyncSession,
    *,
    job_id: int,
    step_id: int,
    attempt: int,
    kind: str,
    role: Literal["primary", "auxiliary"],
    title: str,
    text_content: str | None = None,
    structured_content: object | None = None,
) -> ExecutionArtifact:
    ...


async def list_execution_artifacts(
    session: AsyncSession,
    *,
    job_id: int,
    include_superseded: bool = True,
) -> list[ExecutionArtifact]:
    ...


async def supersede_execution_artifacts(
    session: AsyncSession,
    *,
    job_id: int,
    step_ids: Sequence[int],
) -> int:
    ...
```

These functions flush but never commit. A Phase 2 caller can atomically append
an artifact, activate Stage output, and update Job state.

- [ ] **Step 1: Write failing artifact tests**

Test:

```python
primary = await append_execution_artifact(
    db,
    job_id=job.id,
    step_id=step.id,
    attempt=1,
    kind="article",
    role="primary",
    title="Draft",
    text_content="# Draft\n\nBody",
)
auxiliary = await append_execution_artifact(
    db,
    job_id=job.id,
    step_id=step.id,
    attempt=1,
    kind="validation_report",
    role="auxiliary",
    title="Validation",
    structured_content={"valid": True},
)

assert primary.status == "active"
assert primary.digest != auxiliary.digest
assert [item.id for item in await list_execution_artifacts(
    db,
    job_id=job.id,
)] == [primary.id, auxiliary.id]
```

Add cases rejecting:

- No text and no structured content.
- Blank `kind` or `title`.
- A `step_id` belonging to another Job.
- An attempt that differs from `ContentJobStep.attempt`.
- A second primary for the same Step attempt.

Add a supersession case asserting the update changes only active artifacts for
the requested Job/step IDs and never deletes rows or changes digests/content.

- [ ] **Step 2: Run the test and verify missing-module failure**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_execution_artifacts.py -q
```

- [ ] **Step 3: Implement canonical digest and append validation**

Canonical digest input is:

```python
payload = {
    "kind": kind,
    "role": role,
    "title": title,
    "text_content": text_content,
    "structured_content": structured_content,
}
encoded = json.dumps(
    payload,
    ensure_ascii=False,
    sort_keys=True,
    separators=(",", ":"),
).encode("utf-8")
digest = hashlib.sha256(encoded).hexdigest()
```

Validate JSON serializability before constructing the model. Lock/read the
`ContentJobStep`, verify Job and attempt ownership, and check existing primary
before append. Use `session.begin_nested()` around add/flush. Translate a
concurrent primary uniqueness `IntegrityError` from that savepoint to
`ExecutionArtifactError`; leave the caller's outer transaction usable and
uncommitted.

- [ ] **Step 4: Implement ordered list and append-only supersession**

List by `ExecutionArtifact.id.asc()`. When
`include_superseded=False`, filter `status == "active"`.
`supersede_execution_artifacts` performs one scoped update from `active` to
`superseded` and returns `rowcount`. It accepts an empty step list as a no-op
and has no delete path.

- [ ] **Step 5: Run artifact and model/migration regressions**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_execution_artifacts.py \
  tests/test_models_schema.py \
  tests/test_database_skill_pipeline_migration.py -q
```

- [ ] **Step 6: Commit Task 8**

```bash
git add backend/execution_artifacts.py backend/tests/test_execution_artifacts.py
git commit -m "feat: persist execution artifacts"
```

### Task 9: Phase 1 regression gate and handoff

**Files:**

- Modify only files already named if verification exposes a Phase 1 defect.

**Interfaces:**

- `ManagedSkill`/`RegisteredSkill` and `SkillBinding` are the Phase 2 package boundary.
- `formatSkillInvocation` is the Phase 2 single-Skill activation boundary.
- `ExecutionJob*`, Stage-aware `ensure_agent_execution`, and artifact service
  functions are the Phase 2 persistence boundary.

- [ ] **Step 1: Run the complete focused frontend gate**

```bash
cd web
pnpm exec vitest run \
  lib/skills/standard.test.ts \
  lib/skills/registry.test.ts \
  lib/skills/bundled-skills.test.ts \
  lib/skills/bindings.test.ts \
  lib/skills/invocation.test.ts \
  lib/ai/discover-skills.test.ts \
  app/api/skills/route.test.ts \
  app/settings/sections/SkillsSection.test.tsx \
  lib/api/skills.test.ts \
  app/api/chat/route.test.ts \
  lib/ai/global-chat-tools.test.ts \
  lib/ai/skill-run.test.ts
```

Expected: every listed file passes with zero failures.

- [ ] **Step 2: Run the complete focused backend gate**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_models_schema.py \
  tests/test_database_skill_pipeline_migration.py \
  tests/test_database_init_postgres.py \
  tests/test_execution_artifacts.py \
  tests/test_agent_execution_service.py \
  tests/test_agent_executions_router.py \
  tests/test_content_jobs.py \
  tests/test_jobs_router.py \
  tests/test_daily_creation_rules_router.py \
  tests/test_agent_logs_router.py -q
```

Expected: every listed test passes against PostgreSQL; the migration test runs
twice and is not skipped.

- [ ] **Step 3: Run scoped static checks**

```bash
cd web
pnpm exec eslint \
  lib/skills/standard.ts \
  lib/skills/registry.ts \
  lib/skills/bindings.ts \
  lib/skills/invocation.ts \
  lib/api/skills.ts \
  app/settings/sections/SkillsSection.tsx
```

Run:

```bash
git diff --check origin/main...HEAD
git status --short
```

Expected: no whitespace errors and no uncommitted implementation files.

- [ ] **Step 4: Audit the final diff against Phase 1 invariants**

Run:

```bash
git diff --name-status origin/main...HEAD
git log --oneline origin/main..HEAD
rg -n "wms|wemediastudio|WeMediaStudio" \
  web/lib/skills \
  web/app/settings/sections/SkillsSection.tsx \
  backend/execution_jobs.py \
  backend/execution_artifacts.py
```

Expected:

- No new product-facing legacy brand names.
- No physical Job table rename.
- No `SKILL.json` requirement.
- No uploaded Skill enabled by default.
- No package-script execution path.
- No migration delete or historical execution backfill.
- The branch contains only the approved design, this plan, and Phase 1 commits.

- [ ] **Step 5: Prepare the Phase 1 handoff**

Report:

- Exact commit list.
- Exact frontend/backend commands and pass counts.
- PostgreSQL migration fixture evidence from both runs.
- Any skipped check as an unresolved release blocker.
- The frozen interfaces Phase 2 may consume.

Do not begin the Phase 2 pipeline runner until this gate is reviewed.

## Primary references

- [Agent Skills specification](https://agentskills.io/specification)
- [Pi formatter at audited commit](https://github.com/earendil-works/pi/blob/a1f955e9f47fd3379b44f4aace65ab916c80519a/packages/agent/src/harness/skills.ts#L38)
- [Ordered Skill Pipeline design](../specs/2026-08-23-ediora-skill-pipeline-design.md)
