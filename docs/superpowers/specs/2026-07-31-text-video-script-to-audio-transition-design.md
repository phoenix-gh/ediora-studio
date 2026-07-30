# Text Video Script-to-Audio Transition Design

## Context

The text-video script stage currently renders a permanently disabled
`生成配音（下一步）` button. A project can contain a valid non-empty speech
segment and still have no usable way to continue from that call to action.
Users can manually click the top `配音制作` tab, but the primary workflow
suggests that the disabled button should perform the transition.

The workflow banner also treats every unconfirmed segment as though audio
already exists. A draft segment therefore displays `还需确认 1 段配音` before
TTS has generated anything.

## Approved Behavior

### Script-stage call to action

- Rename the primary action to `进入配音设置`.
- Enable it when:
  - the project contains at least one speech segment with non-whitespace text;
  - a continuation handler is available;
  - no continuation request is already running.
- Clicking it saves all current project edits before changing stages.
- Only a successful save opens the audio stage.
- While saving, the button is disabled and displays `正在保存…`.
- If saving fails, the editor stays on the script stage and displays the
  existing error message without starting a speech job.
- Entering the audio stage does not automatically call TTS. The user can
  review voice settings and explicitly choose `生成当前段` or
  `生成全部未生成段落`.

### Audio workflow banner

The banner must distinguish generation state from confirmation state:

- Draft or failed audio: `还需生成 N 段配音，生成后请试听并确认`.
- Generating audio: `正在生成 N 段配音`.
- Ready but unconfirmed audio:
  - single segment:
    `还需确认 1 段配音，确认后将直接复用该段音频`;
  - multiple segments:
    `还需确认 N 段配音，确认后可生成主音频`.
- Mixed draft/failed and ready states:
  `还需生成 X 段、确认 Y 段配音`.
- All segments confirmed:
  - single segment:
    `配音已确认，正在准备成片时间轴`;
  - multiple segments:
    retain the existing master-audio guidance.

The single-segment optimization remains unchanged: after the generated audio
is confirmed, that segment is reused as the master audio and only the global
timeline needs preparation.

## Component and Data Flow

1. `ScriptStage` receives an asynchronous continuation callback and owns only
   the pending/error presentation for that click.
2. `TextVideoWorkbench` awaits the continuation callback and switches its
   local stage to `audio` only after the promise resolves.
3. `TextVideoEditorClient` implements the callback with
   `autosave.flush()`, preserving server conflict and canonical-project
   handling.
4. Existing speech-generation handlers remain owned by the audio stage.
5. Banner text is derived from explicit segment status counts:
   `draft/failed`, `generating`, `ready`, and `confirmed`.

No new backend endpoint, database field, or background job is required.

## Error Handling

- Autosave rejection keeps the user on the script stage.
- The call to action becomes available again after the failed request.
- The error is visible near the action and is not converted into a successful
  stage transition.
- Existing autosave conflict behavior remains authoritative.

## Tests

- `ScriptStage`:
  - enables the action for a non-empty segment;
  - disables it for an empty segment or while saving;
  - invokes the continuation callback once;
  - stays in place and displays an error after rejection.
- `TextVideoWorkbench`:
  - does not show the audio stage before the save promise resolves;
  - shows the audio stage after it resolves;
  - renders correct banner text for draft, generating, ready, mixed, and
    confirmed states.
- `TextVideoEditorClient`:
  - supplies a continuation callback that flushes autosave.
- Live development verification:
  - open the current draft project;
  - confirm `进入配音设置` is enabled;
  - click it and verify the audio controls render without console errors.

## Non-goals

- Automatically starting TTS from the script stage.
- Changing voice settings, TTS provider configuration, confirmation rules, or
  the single-segment master-audio optimization.
- Altering video-stage readiness or scene-generation behavior.
