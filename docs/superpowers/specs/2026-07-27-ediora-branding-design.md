# Ediora · 述策 Branding Design

## Goal

Replace the user-facing WeMedia Studio product name with **Ediora · 述策** and establish the constraints for a subsequent logo asset.

## Scope

### User-facing brand copy

- The primary product name is `Ediora · 述策`.
- The Chinese descriptor is `AI 内容工作台`.
- The English descriptor is `AI Content Operations` when an English-only surface needs one.
- The browser title is `Ediora · 述策 — AI 内容工作台`.
- The sidebar and application header use `Ediora · 述策` without an additional descriptor.
- The top-level README title and introductory copy identify the project as `Ediora · 述策`.

### Technical identifiers that remain unchanged

Do not rename database names, API paths, environment variables, local URLs, or internal code symbols. They are operational identifiers and renaming them would introduce migration and compatibility work without changing the product experience. The frontend directory and package were later renamed from `wemedia-studio` to `web` / `ediora`.

## Approaches considered

1. **Display-only brand replacement — selected.** Change visible application and documentation copy while retaining operational identifiers. This delivers the new name safely and keeps startup, data, and integrations stable.
2. **Full repository rename.** Rename packages, folders, databases, APIs, and environment variables. This would look internally consistent but needs migrations and risks breaking local data, scripts, and integrations.
3. **Alias-only rollout.** Keep `WeMedia Studio` visible with `Ediora · 述策` as a subtitle. This reduces transition risk but leaves the duplicate-name problem unresolved.

## Logo direction

The logo is a separate deliverable after the copy replacement is verified. It should be a compact, vector-friendly mark that communicates: source material becoming an editorial decision and then publishable output. The logo must work at favicon size, beside the `Ediora · 述策` wordmark, and in light and dark interfaces. It must not contain generated text or imitate another product's mark.

Before an asset is accepted, present two or three distinct mark directions for selection. Save the selected project-bound logo under the workspace and update the application only after the visual is selected.

## Validation

- A frontend test asserts the layout metadata title and visible sidebar name use `Ediora · 述策`.
- Existing frontend tests and the production frontend build pass.
- A repository search confirms that user-facing files changed in this scope do not retain `WeMedia Studio`; intentionally retained technical identifiers are excluded from that check.
