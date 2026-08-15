# Human Social Copy Bundled Skill Design

## Summary

Ediora will replace the legacy project-level `x-post` Skill with a curated, bundled `human-social-copy` Skill derived from [0xMulight/human-social-copy](https://github.com/0xMulight/human-social-copy). The new Skill will use the shared reference runtime, preserve generally useful Chinese social-copy guidance, and remove upstream author-specific and Hermes-specific behavior.

The bundled Skill is intended for any configured publishing account. It uses an explicitly available account voice profile when one exists. If no account is selected, no usable voice profile exists, or multiple accounts are present without a clear selection, it must not guess; it writes in a neutral, human, information-dense Chinese style.

## Goals

- Provide one bundled Chinese social-copy Skill for X and other short social platforms.
- Replace the obsolete `x-post` Skill and update active Skill-to-Skill references.
- Use the new on-demand references runtime instead of a monolithic prompt.
- Preserve useful upstream rules while removing the upstream author's private persona and deployment assumptions.
- Keep source attribution and MIT licensing intact.
- Make the Skill enabled by default, user-disableable, and non-deletable through existing bundled-Skill behavior.

## Non-goals

- Do not import the upstream `hot-tools-tweet` Skill.
- Do not reproduce 0xMulight's personal voice profile.
- Do not add a publishing-account selector to Chat.
- Do not automatically choose among multiple publishing accounts.
- Do not add post scheduling, cron integration, source scouting automation, or publishing.
- Do not preserve historical design and plan documents merely mentioning `x-post`; they remain an audit trail.
- Do not modify unrelated X collection or publishing code whose filenames contain `x-post` but do not refer to the Skill.

## Source and licensing

The adapted content is based on upstream commit:

```text
e9c11bed71e74171d114dbb641075d61bdf2fca3
```

The bundled directory includes:

- `LICENSE`: the upstream MIT license and copyright notice without modification.
- `UPSTREAM.md`: repository URL, pinned commit, adaptation date, and a concise list of material changes.

The Skill frontmatter uses version `1.0.0-wms.1` to identify the first Ediora adaptation rather than claiming to ship an unmodified upstream release.

## Directory structure

```text
web/skills/human-social-copy/
  SKILL.md
  LICENSE
  UPSTREAM.md
  references/
    adaptive-hooks.md
    writing-clean-rules.md
    patterns.md
    finance-writing.md
    layout-playbook.md
    sourcing-playbook.md
    kol-brief-workflow.md
    voice-system.md
```

The following upstream content is intentionally excluded:

- `references/0xmulight-voice-profile.md`
- `hot-tools-tweet/`
- root files for Claude, Gemini, Hermes, Codex, and repository contribution workflows
- cron, terminal-security, structure-tracker, and other missing or environment-specific references
- duplicated root and nested `SKILL.md` variants

## Main Skill behavior

`SKILL.md` remains compact and defines the workflow and reference-routing rules.

### Trigger and scope

Use the Skill when the user asks to draft, rewrite, critique, or humanize Chinese social content for X, Threads, Instagram, TikTok, or comparable short-form platforms. It covers AI tools, products, GitHub projects, crypto, finance, product experiences, practical tutorials, commentary, and personal observations.

Do not use it for long-form articles when `article-drafting` is more appropriate, or for idea generation alone when `content-ideation` is more appropriate.

### Voice resolution

Voice priority is deterministic:

1. Factual accuracy and user-provided facts.
2. Explicit instructions in the current request.
3. An explicitly selected or supplied publishing-account voice profile.
4. Neutral human Chinese style from this Skill.

The Skill must not call `list_publish_accounts` merely to choose a voice when the user did not identify an account. It must not infer that the first account is current. If account context is absent or ambiguous, it uses the neutral fallback.

The neutral fallback is direct, specific, restrained, and conversational. It avoids corporate copy, AI filler, invented personal experience, fake authority, and the upstream author's crypto persona.

### Workflow

1. Identify the task as drafting, rewriting, critique, or humanization.
2. Preserve facts, links, names, numbers, uncertainty, and required disclosures.
3. Read only the references relevant to the task through `readSkillReference`:
   - Always read `references/writing-clean-rules.md` for final drafting or rewriting.
   - Read `references/adaptive-hooks.md` when creating or changing the opening.
   - Read `references/patterns.md` when restructuring body flow or CTA.
   - Read `references/finance-writing.md` for finance, crypto, macro, earnings, or investment-adjacent material.
   - Read `references/layout-playbook.md` for long social posts, image-text posts, or platform layout.
   - Read `references/sourcing-playbook.md` only when evaluating or organizing supplied source material; it does not authorize web research by itself.
   - Read `references/kol-brief-workflow.md` for sponsored or partnership briefs.
   - Read `references/voice-system.md` only when the user supplies writing samples or asks to build/reuse a voice profile.
4. Draft the content without requiring a preliminary menu of hooks unless the user asks for alternatives.
5. Run the compact final check in `SKILL.md` and return the usable copy first.

The Skill may ask one blocking question when the requested platform, objective, or required factual input cannot be inferred safely. It must not force a multi-step confirmation workflow for ordinary rewrites.

## Adapted references

References are curated rather than copied blindly. Each retains useful upstream concepts while removing contradictions, missing-file dependencies, author-private behavior, and environment-specific commands.

### `writing-clean-rules.md`

Defines concrete language, prohibited corporate filler, restrained punctuation, factual integrity, natural Chinese/English spacing, short paragraphs, and rules against invented experience. It replaces absolute stylistic bans with narrowly explained defaults where platform or user requirements may differ.

### `adaptive-hooks.md`

Provides content-signal-to-hook guidance without mandatory rotation history, fixed catchphrases, or claims that hooks must be copied verbatim. Hooks must remain faithful to the source and may not invent results, urgency, popularity, or personal experience.

### `patterns.md`

Provides body structures for tools, tutorials, observations, comparisons, and lightweight CTA. Patterns are options chosen by content fit, not a quota or rotation table.

### `finance-writing.md`

Preserves event, expectation, impact, signal, and risk framing. It requires source-aware uncertainty and a concise disclosure for investment-adjacent claims. It must not impersonate the upstream author's crypto worldview.

### `layout-playbook.md`

Covers title, opening, paragraph rhythm, lists, image placement suggestions, and platform-specific length adaptation without assuming external image tools are installed.

### `sourcing-playbook.md`

Helps assess the usefulness, freshness, verifiability, and reader action of supplied sources. It removes mandatory Chinese-X first-post checks, GitHub-star thresholds, and commands for unavailable tools.

### `kol-brief-workflow.md`

Converts partnership briefs into concrete reader scenarios while preserving required claims, prohibited claims, disclosures, and risk boundaries. It must not hide sponsorship.

### `voice-system.md`

Defines how to infer a reusable voice profile only from user-supplied samples or explicit account context. It must separate observed traits from guesses, avoid copying distinctive phrases mechanically, and fall back to neutral style when evidence is insufficient.

## Legacy `x-post` removal

Delete the complete directory:

```text
skills/x-post/
```

Update current, executable Skill references:

- `skills/article-drafting/SKILL.md`: replace routing and related-Skill references from `x-post` to `human-social-copy`.
- `skills/content-ideation/SKILL.md`: replace the handoff workflow from `x-post` to `human-social-copy` and remove references to the deleted Skill's private skeleton/voice sequence.

Historical documents under `docs/superpowers/` are not rewritten. Files such as `web/app/x/x-post-url.ts` are unrelated URL helpers and remain unchanged.

## Runtime behavior

Placing the adapted Skill under `web/skills/` makes it a bundled Skill through the existing registry:

- enabled by default;
- visible in Skill management and Chat selection;
- disableable through persisted state;
- not deletable through the Skill API;
- name-protected against uploaded duplicates;
- references discoverable and readable only while enabled.

No new application code is required unless tests reveal an incompatibility with the bundled version string or reference format.

## Testing

### Structure and content

- `SKILL.md` frontmatter parses as `human-social-copy`, version `1.0.0-wms.1`.
- The expected eight references, `LICENSE`, and `UPSTREAM.md` exist.
- `references/0xmulight-voice-profile.md` and `hot-tools-tweet` do not exist.
- No active adapted file instructs the model to impersonate 0xMulight, update a structure tracker, run cron, or invoke unavailable Hermes paths.
- All relative reference paths named by `SKILL.md` exist and are discoverable by the registry.

### Registry and Chat discovery

- `listSkills` reports `human-social-copy` as `builtin`, enabled, and non-deletable.
- `discoverSkills` and the Chat skills API include it while enabled.
- Disabling removes it from enabled discovery and reference access; enabling restores it.
- Uploading another Skill named `human-social-copy` is rejected as a conflict.

### Legacy removal

- `skills/x-post` no longer exists.
- Active files outside historical documentation contain no Skill routing to `x-post`.
- `article-drafting` and `content-ideation` route social-copy work to `human-social-copy`.

### Regression

- Focused Skill registry, discovery, Chat skills API, and Skill management tests pass.
- The full frontend test suite passes.
- Changed-file lint passes.
- Type checking introduces no new errors; unrelated dirty-worktree errors are reported without modifying those files.

## Rollout

1. Add the curated bundled Skill and provenance files.
2. Update active cross-Skill routing.
3. Delete the legacy `x-post` directory.
4. Run structural, registry, Chat discovery, and full regression tests.
5. Verify the running Skill management API reports `human-social-copy` as bundled and does not report `x-post`.
