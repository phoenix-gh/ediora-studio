# Text Video Project Management and Editor Fidelity Design

## Goal

Correct the first text-video milestone by separating project management from project editing, persisting real project state, and restoring the approved editor layout structure while continuing to use Ediora's existing visual system.

## Information architecture

The 创作 navigation entry **文字视频** always opens `/text-video`, the project-management page. It never opens a specific editor directly.

- `/text-video` lists persisted text-video projects.
- `/text-video/[projectId]` edits one persisted project.
- Creating a project writes it to the database and then navigates to its editor.
- Clicking a project card or **继续编辑** opens its editor.
- The editor has an explicit back action to return to the project list.
- An unknown or deleted project renders a clear not-found state rather than fixture data.

## Project management page

The management page follows existing Ediora page patterns and semantic design tokens. It includes:

- page title, short description, total project count, and **新建文字视频** action;
- status filters for all, script, audio, video, completed, and archived projects;
- project cards showing title, optional cover, aspect ratio, estimated duration, current stage, updated time, and save/render status;
- empty state with a single creation action;
- card actions for continue editing, rename, and delete;
- rename and delete interactions implemented with project Dialog and AlertDialog components, never browser-native prompts.

Deleting a project is explicit and destructive. The confirmation identifies the exact title. The first implementation deletes project records but does not delete shared creative assets.

## Persisted domain model

Create a dedicated `text_video_projects` table. It does not reuse `talking_video_projects`.

Each record stores:

- `id`: integer primary key;
- `title`: required display title;
- `status`: `draft`, `audio_ready`, `video_ready`, `completed`, or `archived`;
- `stage`: `script`, `audio`, or `video`;
- `script`: master narration text;
- `voice_settings`: JSON object containing selected provider-neutral voice settings;
- `paragraphs`: JSON array containing paragraph id, narration text, duration, audio URL, timing metadata, and confirmation status;
- `render_input`: JSON object containing the validated canonical Remotion contract;
- `cover_asset_url`: optional cover URL;
- `output_asset_url`: optional rendered video URL;
- `revision`: integer optimistic-concurrency revision;
- `created_at` and `updated_at`.

JSON is intentional for this milestone because paragraphs, AI-directed scenes, and template properties are edited as one project document. Rendering and audio assets remain external URLs. If later job queries require paragraph-level indexing, those records can be normalized without changing the API document.

## API

Add `/api/text-videos` endpoints:

- `GET /api/text-videos` lists project summaries, optionally filtered by status.
- `POST /api/text-videos` creates a persisted blank project with valid `tech-text-v1` defaults.
- `GET /api/text-videos/{id}` returns the complete editable project.
- `PATCH /api/text-videos/{id}` updates a project document and requires the current `revision`.
- `DELETE /api/text-videos/{id}` deletes the project record.

The backend validates:

- title and enum values;
- paragraph structure and confirmation state;
- supported aspect ratios;
- canonical render contract, ordered non-overlapping scenes, and template version;
- that `stage=video` is not saved until all narration paragraphs are confirmed.

Successful PATCH increments `revision`. A stale revision returns HTTP 409 with the latest server revision so the client does not silently overwrite another tab.

## Autosave behavior

Editing the title, script, project stage, voice settings, paragraph state, scene data, aspect ratio, or template properties marks the editor dirty. The client debounces autosave for 800 milliseconds.

The top bar displays one of four truthful states:

- `已保存`;
- `正在保存`;
- `有未保存更改`;
- `保存失败，点击重试`.

`Ctrl+S` or `Cmd+S` triggers an immediate save. Navigation while dirty attempts one immediate save. A failed save keeps the local state and exposes retry; it never displays success optimistically.

On HTTP 409, autosave pauses and a Dialog explains that the project changed elsewhere. The user can reload the server version or explicitly overwrite it using the latest revision. No silent last-write-wins behavior is allowed.

## Editor layout fidelity

The editor restores the approved structural layout:

1. a full-width top project bar containing back navigation, editable project title, save state, three production stages, aspect ratio, and template;
2. a left scene/paragraph column using approximately 28% of the primary workspace;
3. a central editing or Remotion preview area;
4. a right settings panel using existing Ediora Field, Select, Button, Dialog, and semantic color tokens;
5. a player-control row below the central video preview;
6. a bottom scene timeline with scene cards, durations, selection state, and a master audio lane placeholder.

The design reference controls structure and density, not its palette. Ediora's existing background, surface, border, primary, muted, success, warning, radius, typography, and focus tokens remain authoritative.

Desktop keeps the three-column workspace and bottom timeline visible. At compact desktop widths, the workspace retains its editing geometry inside a minimum-width canvas with horizontal scrolling instead of stacking all panels into a long page. Phone-sized authoring is viewable but is not a primary editing target for this milestone.

The script and audio stages reuse the same frame and substitute paragraph navigation, script editing, waveform/audio review, and voice settings into the three structural columns.

## Data flow

1. The management page fetches summaries from the Python API.
2. Creating a project persists default data and navigates to `/text-video/{id}`.
3. The editor fetches the complete project and hydrates a local editable store.
4. Local edits update UI immediately, mark the project dirty, and schedule autosave.
5. The API validates and persists the complete document, increments `revision`, and returns normalized project data.
6. Remotion Player receives only the validated `render_input`.
7. Returning to the management page shows the latest persisted stage and update time.

## Scope

Included:

- real database persistence and migrations;
- project list, create, rename, delete, and continue-editing flows;
- two-level routes;
- autosave, explicit save state, keyboard save, retry, and revision conflict handling;
- structural fidelity to the approved editor concept;
- existing Remotion preview and template contract;
- backend, frontend, browser, and production-build verification.

Excluded:

- live MiMo TTS and voice cloning;
- actual audio waveform extraction;
- MP4 rendering jobs;
- asset garbage collection when a project is deleted;
- project duplication, folders, collaboration, and revision history.

Unavailable production actions remain visibly disabled and accurately labelled.

## Verification

- Database migration creates the table idempotently.
- API tests cover list, create, detail, patch, revision conflict, validation, and delete.
- Client API tests cover request methods and revision payloads.
- Management-page tests cover empty/list states, create navigation, rename Dialog, and delete confirmation.
- Editor tests cover initial hydration, dirty/saving/saved/error states, debounced autosave, keyboard save, stage gate, and 409 conflict Dialog.
- Layout tests assert the persistent top bar, three-column workspace, player controls, and bottom timeline.
- Remotion contract, registry, and composition checks remain green.
- Full frontend and backend suites and production build run.
- Browser QA covers management → create/open → edit → autosave → return-to-list, video preview, desktop layout, compact-width horizontal workspace, and console health.
