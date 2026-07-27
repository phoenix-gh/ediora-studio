# Chat Skill Discovery and Draft Context Design

## Goal

Let a Chat turn select one automatically discovered local skill and one article
draft, so the model can answer or act using the skill's instructions and the
full draft context.

## Skill Discovery

The application scans `wemedia-studio/skills/*/SKILL.md` at request time and
parses each file's YAML frontmatter. Every discoverable skill appears in the
Chat skill selector using its `name`, `description`, and `version`; no custom
metadata, allowlist, or per-skill frontend registration is required.

The selector supports exactly one skill per turn. This keeps skill instructions
from conflicting while retaining automatic discovery for future skill folders.

## Draft Context

Chat loads a compact list of article drafts for the selector. A selected draft
is sent by ID, read server-side, and contributes its title and complete content
to the selected turn's model instructions. The client never sends the full draft
body as an untrusted request payload.

## Runtime Behavior

The Chat API validates the optional `skillName` and `draftId`. It reads the
selected `SKILL.md` only after matching its discovered name and rejects unknown
or malformed selections. It reads the draft through the existing draft API and
adds both contexts to the model instructions for that request. Existing local
source tools remain read-only and unchanged.

The first implementation treats a skill as instruction context. It does not
automatically grant arbitrary tools based on the skill file. Existing chat tools
remain the explicit application tool surface; future generic skill-tool routing
can extend this boundary without changing discovery or the selector.

## Validation

- Test skill directory discovery and rejection of unknown names.
- Test draft list/detail APIs used by the selector.
- Test that selected skill and draft context are included in Chat model
  instructions, while client-provided draft text is not trusted.
- Test selector request serialization and Chat UI state.
- Run frontend/backend suites, TypeScript checking, and production build.
