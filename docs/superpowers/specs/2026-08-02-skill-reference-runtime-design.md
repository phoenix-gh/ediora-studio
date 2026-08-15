# Skill Reference Runtime Design

## Summary

Ediora currently discovers a Skill by reading only its `SKILL.md`. Files under `references/` survive ZIP installation but are unavailable to the general Chat runtime, while a small number of background content jobs read selected files through bespoke filesystem code.

This change introduces one secure Skill-reference runtime shared by Chat and background jobs. The main `SKILL.md` remains the automatically loaded entrypoint. Chat discovers available references and lets the model read only the files needed for the current turn. Background jobs explicitly declare and preload the references required for deterministic execution.

## Goals

- Make text references in bundled and uploaded Skills usable at runtime.
- Apply the same discovery, authorization, path validation, file limits, and errors to Chat and background jobs.
- Keep Chat context small by loading references on demand.
- Keep background creation jobs deterministic by loading an explicit reference list.
- Immediately prevent reference access when a Skill is disabled.
- Preserve existing Skill upload, duplicate-name, disable, and deletion behavior.

## Non-goals

- Do not inject every reference into every model request.
- Do not execute scripts or other files found in a Skill.
- Do not add reference editing or browsing controls to the Skill management UI.
- Do not infer a background job's required references from arbitrary Markdown links.
- Do not introduce cross-Skill reference access.
- Do not vendor `human-social-copy` as part of this change. It will be evaluated after the runtime is available.

## Architecture

### Shared registry API

The existing registry remains the authority for bundled and uploaded Skills and gains three public operations:

```ts
type SkillReference = {
  path: string
  bytes: number
}

listSkillReferences(skillName: string): Promise<SkillReference[]>
readSkillReference(skillName: string, relativePath: string): Promise<{
  path: string
  content: string
  bytes: number
}>
loadSkillContext(skillName: string, referencePaths: string[]): Promise<{
  name: string
  instructions: string
  references: Array<{ path: string; content: string; bytes: number }>
}>
```

All operations resolve the Skill through `getEnabledSkill`. A missing or disabled Skill is unavailable. `loadSkillContext` always returns the main `SKILL.md` instructions and reads only the explicitly supplied references.

Reference paths use `/` separators regardless of host platform and are returned in stable lexical order. `SKILL.md` is never included in `listSkillReferences`; it is already represented by `instructions`.

### Reference discovery

Discovery recursively walks the selected Skill directory and includes regular text files with one of these extensions:

- `.md`
- `.txt`
- `.json`
- `.yaml`
- `.yml`

Hidden files and hidden directories are ignored. Symbolic links are not listed. Directories, images, archives, executables, and unknown extensions are ignored rather than exposed to the model.

The result is limited to 200 references. Exceeding the limit produces an explicit `too_large` registry error; it does not silently truncate the catalog.

### Safe reads

Every requested path is validated independently even if it came from the discovery catalog.

The reader rejects:

- empty paths;
- absolute paths;
- NUL characters;
- `.` or `..` path components;
- backslash-based alternate paths;
- paths that resolve to `SKILL.md`;
- unsupported extensions;
- directories and non-regular files;
- symbolic links in any path component;
- real paths outside the selected Skill directory.

Each reference is limited to 128 KiB measured in bytes before UTF-8 decoding. Malformed UTF-8 or NUL-containing decoded content is rejected as an invalid reference rather than replaced silently.

`loadSkillContext` applies a 512 KiB cumulative reference limit. Duplicate paths are read once and returned once in first-request order.

### Chat integration

When Chat receives a selected `skillName`:

1. Resolve the enabled Skill.
2. Inject its `SKILL.md` instructions as today.
3. Append a compact, stable catalog containing reference paths and byte sizes.
4. Instruct the model to call `readSkillReference` when the Skill requires a listed file, and to report a missing required reference instead of inventing its contents.
5. Register a local read-only `readSkillReference` tool scoped to that selected Skill.

The tool schema is:

```ts
z.object({ path: z.string().min(1).max(500) }).strict()
```

The model cannot supply a Skill name. The server closes over the selected enabled Skill name, preventing cross-Skill access.

One request-scoped byte counter enforces a 512 KiB cumulative limit across tool calls. Reading the same path again returns the cached result without consuming the budget again. The tool is absent when no Skill is selected.

Approval is not required because the operation is local and read-only.

### Background-job integration

Background content jobs use `loadSkillContext` rather than reading Skill directories directly.

The existing deterministic mappings remain explicit:

- `baoyu-cover-image` loads the references currently required for cover auto-selection and prompt construction.
- `baoyu-article-illustrator` loads the references currently required for illustration behavior.

The jobs continue to assemble their specialized runtime instructions from those known sources; only discovery, validation, reading, and limits move into the shared runtime. A disabled Skill, missing required reference, invalid file, or size violation fails the job with an actionable error. The job must not continue with incomplete rules.

Future background Skill consumers must call `loadSkillContext` with an explicit reference list. They must not recursively inject all references or directly read from the Skill filesystem.

## Errors

`SkillRegistryErrorCode` expands with reference-specific codes:

- `invalid_reference`: unsafe path, unsupported file, symlink, malformed UTF-8, or NUL content.
- `reference_not_found`: valid relative path that does not identify an allowed regular file.
- Existing `not_found` covers missing or disabled Skills at the public reference boundary.
- Existing `too_large` covers per-file, catalog-count, and cumulative-byte limits.

User-facing Chat tool results contain concise messages without absolute filesystem paths. Server logs may retain the underlying error for diagnosis.

## Limits

The defaults are constants and may be overridden by positive integer environment variables for testing and deployment:

| Limit | Default | Environment variable |
|---|---:|---|
| Reference catalog entries | 200 | `WMS_SKILLS_MAX_REFERENCES` |
| Single reference bytes | 131072 | `WMS_SKILLS_MAX_REFERENCE_BYTES` |
| Context or Chat request reference bytes | 524288 | `WMS_SKILLS_MAX_REFERENCE_CONTEXT_BYTES` |

These limits are separate from ZIP archive and unpacked-size limits.

## Data flow

### Chat

```text
selected skill
  -> registry resolves enabled Skill
  -> SKILL.md + reference catalog enter instructions
  -> model requests one reference path
  -> request-scoped tool validates and reads through registry
  -> reference content enters the next model step
```

### Background job

```text
job declares required reference paths
  -> loadSkillContext resolves enabled Skill
  -> shared validation and bounded reads
  -> deterministic job prompt assembly
  -> model generation
```

## Testing

### Registry

- Lists nested supported references in stable order.
- Ignores hidden, binary, unsupported, directory, and symbolic-link entries.
- Reads bundled and uploaded Skill references.
- Rejects disabled or unknown Skills.
- Rejects absolute, traversal, backslash, NUL, `SKILL.md`, unsupported-extension, and symlink paths.
- Rejects oversized, malformed UTF-8, and NUL-containing files.
- Deduplicates `loadSkillContext` paths and enforces cumulative limits.
- Produces explicit errors when the catalog exceeds its limit.

### Chat

- A selected Skill injects its main instructions and reference catalog.
- `readSkillReference` exists only with a selected enabled Skill.
- The tool reads a nested reference from the selected Skill.
- The tool cannot read another Skill or escape the selected directory.
- Repeated reads use the request cache; distinct reads share the cumulative budget.
- Missing or invalid references return a bounded user-safe error.

### Background jobs

- Cover and illustration jobs load their current required rules through `loadSkillContext`.
- Missing or disabled Skills and missing required references fail closed.
- Existing prompt-source assertions and generated-job behavior remain unchanged.

### Regression

- Skill upload, duplicate-name rejection, enabling, disabling, and uploaded-only deletion continue to pass.
- Full frontend tests and changed-file lint pass.
- Type checking must introduce no new errors in Skill, Chat, or content-job files; unrelated dirty-worktree failures are reported separately.

## Rollout

1. Add and verify the shared registry reference API.
2. Integrate request-scoped Chat discovery and reading.
3. Migrate current background Skill consumers to `loadSkillContext`.
4. Run focused and full regression tests.
5. After this runtime is stable, adapt and vendor `human-social-copy` as a separate change.
