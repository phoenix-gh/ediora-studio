# Internal Environment Contract Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace application-owned environment names with concise unprefixed names across the entire repository and make persisted Settings the only runtime source for provider credentials.

**Architecture:** Keep operational configuration in the process environment, but remove the application brand from internal names (`DATABASE_URL`, `REDIS_URL`, `WORKER_TOKEN`, queues, ports, development state, and similar settings). Keep external image/framework contracts unchanged. Provider-backed jobs fetch credentials through the protected Settings runtime endpoints and fail clearly when Settings is empty; no provider API-key environment fallback remains.

**Tech Stack:** Python/FastAPI, SQLAlchemy/PostgreSQL, Next.js/TypeScript, Vitest, pytest, Docker Compose, GitHub Actions.

## Global Constraints

- Application-owned environment names are unprefixed; do not introduce a replacement application prefix.
- `NEXT_PUBLIC_*`, `POSTGRES_*`, `HEYGEN_*`, `COMFYUI_*`, `WHISPER__*`, and other external/framework contracts keep their public names.
- LLM, image, speech, and HeyGen runtime credentials come only from persisted Settings; provider API-key environment variables are not injected by Compose or read as fallback.
- Existing PostgreSQL setting keys, tables, volumes, and `wemedia` business identifiers stay unchanged.
- Do not modify a user-owned `.env` file; update `.env.example` and document the manual migration.
- Every task ends with its focused test or contract check before the next task starts.

---

### Task 1: Add failing contract tests for the new boundary

**Files:**
- Create: `backend/tests/test_environment_contract.py`
- Modify: `backend/tests/test_speech_settings.py`
- Modify: `backend/tests/test_heygen_settings.py`
- Modify: `backend/tests/test_compose_x_sessions.py`
- Create: `web/lib/ai/runtime-config.ts`
- Create: `web/lib/ai/runtime-config.test.ts`

**Interfaces:**
- `backend/tests/test_environment_contract.py` scans tracked text files using a dynamically constructed legacy prefix so the test itself does not preserve the forbidden literal.
- `web/lib/ai/runtime-config.ts` will expose pure `textModelConfigFromSettings()` and `imageModelConfigFromSettings()` functions; callers pass the protected Settings response and receive `{ apiKey, modelName, baseURL }` or a clear Settings error.

- [ ] **Step 1: Write the failing repository and Compose contract tests.** Assert that tracked text contains no application-owned legacy prefix, Compose has unprefixed internal keys, and `api`/`worker` do not receive LLM, image, speech, HeyGen, or vendor alias API-key environment values. Assert the worker boundary uses `WORKER_TOKEN` and `X-Worker-Token`.
- [ ] **Step 2: Change the existing speech and HeyGen tests to express Settings-only behavior.** Set a process environment credential while the persisted setting is empty, call the protected runtime/config path, and assert the returned key is empty rather than the environment value.
- [ ] **Step 3: Write `runtime-config.test.ts` first.** Cover a valid Settings response and an empty response with a populated process environment; the empty response must throw and must not return the environment value.
- [ ] **Step 4: Run the new focused tests and verify they fail for the expected missing-contract reasons.**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_environment_contract.py backend/tests/test_speech_settings.py backend/tests/test_heygen_settings.py backend/tests/test_compose_x_sessions.py -q
pnpm exec vitest run web/lib/ai/runtime-config.test.ts
```

Expected: FAIL because the repository still contains the legacy internal names, Compose still injects provider credentials, the backend still reads provider environment aliases, and the runtime-config module does not exist.

---

### Task 2: Make provider runtime configuration Settings-only

**Files:**
- Modify: `backend/config.py`
- Modify: `web/lib/ai/runtime-config.ts`
- Modify: `web/lib/ai/content-job.ts`
- Modify: `web/app/api/chat/route.ts`
- Modify: `web/app/api/digital-human/script/route.ts`
- Modify: `web/lib/ai/image-generation.ts`
- Modify: `web/lib/ai/content-response-job.ts`
- Modify: `web/lib/ai/content-response-output-job.ts`
- Modify: `web/lib/ai/daily-creation-agent-job.ts`
- Modify: `web/lib/ai/topic-source-job.ts`
- Modify: `web/lib/ai/text-video-scene-job.ts`
- Modify: `web/lib/ai/text-video-split-job.ts`

**Interfaces:**
- `textModelConfigFromSettings(settings)` rejects an empty `api_key` with `请先在设置中配置文本模型 API Key` and never reads `process.env`.
- `imageModelConfigFromSettings(settings)` rejects an empty image key with `请先在设置中配置图片模型 API Key` and never reads `process.env`.
- `backend.config.DEFAULTS` keeps speech provider/model/base URL/default voice but sets `speech_api_key` empty; `effective_heygen_api_key()` returns only the persisted value.

- [ ] **Step 1: Implement the two pure runtime-config helpers minimally.** Use only the Settings response, preserve the configured model/base URL, and throw the specified messages when the key is empty.
- [ ] **Step 2: Run the runtime-config tests and the two backend Settings tests.**
- [ ] **Step 3: Replace each web job’s environment fallback with the helper or a direct Settings-only check.** Remove the old LLM/image/speech provider environment reads from runtime paths; preserve the protected `/settings/ai-runtime` and `/settings/speech-runtime` calls.
- [ ] **Step 4: Remove backend speech and HeyGen environment fallback reads.** Keep the persisted `AppSetting` keys and existing preview/status behavior unchanged.
- [ ] **Step 5: Run all affected focused tests and confirm the new tests pass.**

Run:

```bash
pnpm exec vitest run web/lib/ai/runtime-config.test.ts web/app/api/chat/route.test.ts web/app/api/digital-human/script/route.test.ts web/lib/ai/image-generation.test.ts web/lib/ai/content-job.test.ts
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_speech_settings.py backend/tests/test_heygen_settings.py -q
```

Expected: PASS, with no provider job reading a process environment API key when Settings is empty.

---

### Task 3: Rename application-owned environment variables in runtime code

**Files:**
- Modify: `backend/database.py`
- Modify: `backend/job_reconciliation.py`
- Modify: `backend/main.py`
- Modify: `backend/mcp_server.py`
- Modify: `backend/routers/drafts.py`
- Modify: `backend/runtime_config.py`
- Modify: `backend/storage_paths.py`
- Modify: `backend/worker_auth.py`
- Modify: `backend/x_credential_store.py`
- Modify: `dev.sh`
- Modify: `web/lib/ai/job-client.ts`
- Modify: `web/lib/api/client.ts`
- Modify: `web/lib/skills/registry.ts`
- Modify: `web/scripts/content-worker.ts`
- Modify: `web/playwright.config.ts`
- Modify: `web/e2e/text-video-provider-server.ts`
- Modify: all other tracked runtime/test files returned by a search for the legacy application-owned prefix under `backend`, `web`, and `dev.sh`

**Interfaces:**
- Internal names are the prefix-stripped forms: `DATABASE_URL`, `REDIS_URL`, `API_URL`, `WORKER_TOKEN`, `WORKER_QUEUE`, `VIDEO_WORKER_QUEUE`, `CORS_ORIGINS`, `API_PORT`, `WEB_PORT`, `REDIS_PORT`, `X_SESSION_KEY`, `LOCAL_ASR_*`, `UPLOADS_DIR`, `DISABLE_SCHEDULER`, `WORKER_READY_FILE`, `SKILLS_*`, `DEV_*`, and the equivalent names for test/E2E/runtime controls.
- `NEXT_PUBLIC_API_URL` stays unchanged. The worker authentication header is standardized as `X-Worker-Token` across API and worker code/tests.

- [ ] **Step 1: Apply the mechanical prefix removal to tracked text files.** Strip only the legacy application-owned token; do not change external/framework variables or business identifiers.
- [ ] **Step 2: Update the worker header and error text from the branded name to the unprefixed internal contract.** Keep API authentication behavior identical.
- [ ] **Step 3: Update every runtime read/write and test fixture to the new names, including development lifecycle state and skill-runtime controls.** Do not add aliases for old names.
- [ ] **Step 4: Run the backend runtime/config, worker-auth, X-session, storage, and web client/worker focused tests.**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_runtime_config.py backend/tests/test_database_engine_config.py backend/tests/test_storage_paths.py backend/tests/test_x_credential_store.py backend/tests/test_dev_runtime.py -q
pnpm exec vitest run web/lib/ai/agent-execution-client.test.ts web/lib/api/client.test.ts web/lib/api/assets-runtime.test.ts web/lib/api/text-videos-runtime.test.ts web/scripts/content-worker.test.ts
```

Expected: PASS with the new unprefixed environment contract.

---

### Task 4: Update Compose, local environment examples, CI, and deployment docs

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `.github/workflows/docker-build.yml`
- Modify: `README.md`
- Modify: `docs/self-hosted.md`
- Modify: `web/README.md`
- Modify: `docs/plans/2026-07-28-ediora-ui-phase-2.md`
- Modify: all tracked `docs/superpowers/plans/*.md` and `docs/superpowers/specs/*.md` files containing the old application-owned names

**Interfaces:**
- Compose uses `APP_IMAGE` and `IMAGE_TAG` for the published/local shared image.
- Compose passes `WORKER_TOKEN`, `API_URL`, `REDIS_URL`, queues, operational options, and `NEXT_PUBLIC_API_URL` as appropriate.
- Compose no longer passes LLM/image/speech/HeyGen provider API keys; users configure them from the Settings page after PostgreSQL starts.

- [ ] **Step 1: Update `docker-compose.yml`.** Rename internal interpolation keys, remove provider credential environment entries, keep external image contracts and the optional local-ASR profile unchanged.
- [ ] **Step 2: Rewrite `.env.example` around operational settings only.** Remove provider API-key entries, document the Settings page as the provider configuration source, and retain the new image variables for local GHCR deployment.
- [ ] **Step 3: Update the GitHub workflow and deployment docs.** Replace image variable names, remove instructions to put provider keys in `.env`, explain the breaking manual migration, and keep the GHCR pull/publish flow intact.
- [ ] **Step 4: Normalize the old internal names in all tracked plans/specs without changing historical data identifiers.** Remove obsolete provider fallback instructions where they describe the current deployment contract.
- [ ] **Step 5: Run Compose parsing and the contract tests.**

Run:

```bash
docker compose config --quiet
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_environment_contract.py backend/tests/test_local_asr_compose.py backend/tests/test_compose_x_sessions.py -q
```

Expected: PASS; `local-asr` remains profile-gated and API/worker/Web share the same image without provider key injection.

---

### Task 5: Remove stale legacy names and align all tests and examples

**Files:**
- Modify: every tracked text file returned by a search for the legacy application-owned prefix
- Modify: every tracked text file containing obsolete provider environment names in active deployment instructions

**Interfaces:**
- A repository-wide search for the legacy application-owned prefix returns no matches.
- Provider API-key strings remain only where they are explicit external-provider smoke/test inputs, never as application runtime fallback or Compose configuration.

- [ ] **Step 1: Search the tracked repository for the legacy prefix and list remaining matches.**
- [ ] **Step 2: Update remaining test fixtures, snapshots, comments, shell variables, plan examples, and docs to the unprefixed names.**
- [ ] **Step 3: Remove obsolete environment-key assertions and update error-message expectations to Settings-only wording.**
- [ ] **Step 4: Run `git diff --check` and repeat the repository search.**

Run:

```bash
legacy_prefix="$(printf '%s%s' WM S_)"
git grep -n "$legacy_prefix"
git diff --check
```

Expected: the first command produces no output and the second exits successfully.

---

### Task 6: Run focused regression, Docker, and runtime verification

**Files:**
- Test only; no additional source files expected.

- [ ] **Step 1: Run the focused backend settings, runtime, Compose, worker, and digital-human tests.**
- [ ] **Step 2: Run the focused frontend runtime-config, chat, image, content-job, worker, and API-client tests.**
- [ ] **Step 3: Validate the Compose file and build the unified image with `NEXT_PUBLIC_API_URL=http://localhost:8000/api`.**
- [ ] **Step 4: Start the active Compose services with an explicit new `WORKER_TOKEN`, verify API health and Web reachability, and confirm the optional local-ASR service is not created.**
- [ ] **Step 5: Inspect `git status`, the final commit diff, and the legacy-prefix search before reporting completion.**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_environment_contract.py backend/tests/test_speech_settings.py backend/tests/test_heygen_settings.py backend/tests/test_runtime_config.py backend/tests/test_dev_runtime.py backend/tests/test_local_asr_compose.py -q
pnpm exec vitest run web/lib/ai/runtime-config.test.ts web/app/api/chat/route.test.ts web/app/api/digital-human/script/route.test.ts web/lib/ai/image-generation.test.ts web/lib/ai/content-job.test.ts web/lib/api/client.test.ts web/scripts/content-worker.test.ts
docker compose config --quiet
docker build --build-arg NEXT_PUBLIC_API_URL=http://localhost:8000/api -t ediora-studio:local .
```

Expected: focused tests, Compose validation, and Docker build pass; any unrelated pre-existing full-suite failures are reported separately rather than hidden.

---
