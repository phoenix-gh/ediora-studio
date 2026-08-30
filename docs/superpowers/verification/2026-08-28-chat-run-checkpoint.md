# Durable Chat Run Checkpoint Verification

Date: 2026-08-28

## Automated verification

- Backend focused suite:
  `conda run --no-capture-output -n wems python -m pytest -q tests/test_database_chat_run_migration.py tests/test_database_init_postgres.py tests/test_chat_run_service.py tests/test_chat_router.py`
  - Result: 34 passed in 36.04s.
- Web focused suite:
  `pnpm exec vitest run` over the Chat Run history, API, runtime, orchestrator, projector, route, approval UI, Drafts refresh, and draft-artifact event tests.
  - Result: 16 files and 187 tests passed.
- Focused ESLint over touched runtime and UI files:
  - Result: no errors; one pre-existing `DraftsClient.tsx` `react-hooks/exhaustive-deps` warning for `handleSave`.
- `pnpm exec tsc --noEmit`:
  - No new Chat Run checkpoint type errors.
  - Existing unrelated baseline errors remain in `e2e/extension-auto-schedule.spec.ts`, `lib/ai/skill-run-ai-sdk.test.ts`, `lib/text-video/scene-plan.test.ts`, and `remotion/contract.test.ts`.

## Live restart and approval verification

The feature checkout ran against the normal local PostgreSQL and Redis services. The API and Web processes were restarted between each approval to prove that continuation did not depend on process memory.

- Session: `112` (`Durable checkpoint post-fix verification`)
- Run: `be67ddff-0c73-4734-952f-f14ddc79fa8b`
- Frozen Skill: manually selected `writing-plan`, writing-plan parameter ID `53`
- First approved call: `call_00_2PoGmsc0sycMPtb82Tk00209`
  - Persisted terminal result: `succeeded`, with `saved=false` and a one-time novelty override token.
- Second approved call after another full restart: `call_00_IvcxovuzoKjhxaT7PkYh5056`
  - Persisted terminal result: `succeeded`, with `saved=true` and draft ID `864`.
- Final run state: `completed`, checkpoint version `9`, no run error.
- Final assistant projection:
  - contains `/drafts?draft=864` artifact;
  - contains no pending approval;
  - contains no false `本次 Skill 执行未满足以下要求` message.
- Raw provider HTTP audit:
  - 5 request records and 5 response records with matching call IDs;
  - every response status was `200`;
  - every recorded body had `bodyTruncated=false`;
  - no `llm/http-error` or `session/error` event.

The first live attempt used isolated ports `18000/13000`, but the MCP service allow-list currently pins the API origin to port `8000`. The final restart test therefore used the normal local ports while retaining durable database state across process restarts.

## Rendered UI verification

The Browser plugin was unavailable, so the documented fallback used the repository's Playwright 1.62.0 installation against the rendered application.

Flow: `/chat` -> open session `112` -> inspect final assistant message -> click the draft artifact.

- Approval buttons: 0.
- False Skill-blocked message: 0.
- Exact draft artifact links: 1.
- Resulting URL: `http://127.0.0.1:3000/drafts?draft=864`.
- The draft editor loaded the exact saved title.
- Browser console errors: 0.
- Screenshot captured outside the repository at `/tmp/chat-run-checkpoint-session112.png`.

## Additional recovery bugs found during verification

- Session deletion previously violated the Chat Run/message foreign-key cycle; deletion now clears message run links and removes runs before deleting messages.
- Strict `turn/end` logging previously rejected a non-canonical reason payload containing `runId`; the route now emits only canonical reason kinds.
- AI SDK 7 tool-result history now uses the required discriminated output envelope.
- Completed tool calls that precede an approval are persisted even when runtime assistant content only exposes the pending call.
- Recovery now rehydrates terminal checkpoint tool calls into Skill evidence, preventing false workflow-incomplete output after restart.
- Draft artifact projection now understands both direct JSON and MCP text-envelope tool outputs.
