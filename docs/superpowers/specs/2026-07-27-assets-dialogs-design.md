# Creative Assets Dialog Design

## Goal

Replace browser-native prompts, confirms, and alerts in Creative Assets with accessible application Dialogs so article material creation reliably accepts multi-line content and optional source URLs.

## Scope

- A single controlled form Dialog handles new and edited article material: required `content` textarea and optional `url` input.
- Controlled Dialog forms handle directory creation/rename and X topic-rule configuration (subscription select plus optional keywords).
- Application Dialogs replace Creative Assets deletion confirms; inline state replaces alert-only feedback.
- No `window.prompt`, `window.confirm`, or `window.alert` remains in `AssetsClient.tsx`.
- Other pages' deletion confirmations remain out of scope because they contain no text input.

## Behavior

Submitting a valid article form calls the existing create or update API, closes only after success, updates local state, and selects a newly created article. Empty content stays in the form and shows a validation message. Cancel and close discard unsaved form state.

## Validation

- A jsdom interaction test opens the new-material Dialog, enters multiline content and an optional URL, submits it, and asserts the create API payload and selected result.
- A source guard test confirms no browser-native dialog APIs remain in `AssetsClient.tsx`.
- Existing frontend tests and the production build pass.
