# Chat image preview dialog

## Goal

Generated images shown in Chat open in an in-page dialog instead of navigating to the image URL.

## Interaction

- A generated-image thumbnail remains visible below its associated tool activity.
- Clicking the thumbnail opens a modal dialog in the current Chat page.
- The dialog displays the selected image with its natural aspect ratio, scales it to fit the viewport, and closes through the existing close button or backdrop.
- No new tab or navigation is triggered.

## Implementation

- Reuse the project `Dialog`, `DialogContent`, and accessible title/description primitives.
- Keep preview state local to `ImageJobPreview`, so multiple generated-image results do not interfere.
- Replace the thumbnail anchor with a button and retain the native `<img>` for the thumbnail and dialog content.

## Verification

- Add a source-contract test that asserts the Chat preview uses the shared Dialog and a button trigger.
- Run the focused Chat tests, typecheck, and validate the rendered click path where browser tooling is available.
