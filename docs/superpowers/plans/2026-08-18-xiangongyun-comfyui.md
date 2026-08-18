# 仙宫云 ComfyUI 运行环境 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ComfyUI 数字人 shot 渲染增加可选的仙宫云运行环境；用户在设置中配置 API、选择默认实例和运行环境后，worker 只在选择仙宫云时自动开机并轮询至 `running`，同时提供实例列表、详情、开机和关机操作。

**Architecture:** 保留现有本地/固定 ComfyUI 直连路径作为默认的 `direct` provider；新增 server-side 仙宫云适配层和设置代理路由。仙宫云只负责 GPU 实例电源状态，实际 ComfyUI 请求仍使用现有 `comfyui_base_url`。数字人 shot job 在首次业务操作前通过 worker runtime 配置创建仙宫云客户端，并以可取消的状态机确保目标实例正在运行；不自动关机。

**Tech Stack:** FastAPI、Pydantic、SQLAlchemy `AppSetting` key/value 配置、httpx；Next.js/React、TypeScript、现有 shadcn/ui、Vitest；现有数字人 content worker 和 ComfyUI client。

**Spec:** `docs/superpowers/specs/2026-08-18-xiangongyun-comfyui-design.md`

## Global Constraints

- 保持 `direct` 为默认值；未选择仙宫云时不读取仙宫云 token、不调用任何仙宫云 API，也不改变现有 ComfyUI 行为。
- 仙宫云 API token 只保存在后端配置中；设置读取接口只返回是否已配置和脱敏预览，worker runtime 接口必须受 `X-Worker-Token` 保护。
- 所有仙宫云请求使用 `Authorization: Bearer <token>`，token 不得出现在 URL、日志、异常文本或前端响应中；错误信息使用现有 secret redaction 规则。
- 只使用实例生命周期 API：列表、详情、boot、shutdown；本次不接入 release/destroy，也不增加业务完成后的自动关机。
- `shutdown` 语义采用“关机保留 GPU”，前端文案和后端方法名保持一致；业务流程暂不触发关机。
- `running` 才允许 shot 业务继续；`shutdown` 触发一次 boot，`booting`/`deploying`/`shutting_down` 等过渡态继续轮询；`destroyed`/`destroying`/`freeze` 等不可用状态立即失败。
- 轮询默认超时 5 分钟；每次等待前后保留取消检查，不吞掉 job cancellation；超时和不可用状态返回可读、脱敏的错误。
- 只修改本任务涉及的文件；工作区已有的以下用户改动不得覆盖、整理或提交：`backend/daily_creation_service.py`、`backend/mcp_server.py`、对应 backend tests，以及 `web/lib/ai/global-chat-tools*`。
- 后端测试使用 `/home/violet/miniconda3/envs/wems/bin/python -m pytest`；前端使用 `pnpm exec vitest run <exact files>`、`pnpm exec tsc --noEmit --incremental false` 和 `pnpm build`。
- 在编辑 Next.js 前，遵守 `web/AGENTS.md`，阅读 `web/node_modules/next/dist/docs/` 中与本次 settings client component、数据请求和构建相关的指南；在编辑 shadcn Select 前阅读并遵守 `build-web-apps:shadcn-best-practices`。

## Task 1: Establish the backend API contract with failing tests

**Files:**

- Create: `backend/tests/test_xiangongyun_client.py`
- Create: `backend/tests/test_xiangongyun_settings.py`
- Modify: `backend/tests/test_comfyui_settings.py`

- [ ] Add adapter tests with `httpx.MockTransport` covering request method/path/body, Bearer header, `trust_env=False`, response unwrapping, non-2xx errors, API-level `success=false`/error code, and secret redaction.
- [ ] Add settings response/update tests covering default `direct`, normalized base URL, token set/preview behavior, default instance id persistence, runtime provider validation, worker-token protection, and no token leakage.
- [ ] Add route tests for list/detail/boot/shutdown proxy success and upstream failure mapping.
- [ ] Extend the existing ComfyUI settings tests to assert the new runtime provider field is present and that the old direct runtime contract remains valid.
- [ ] Run the new and affected backend tests before implementation and confirm they fail for missing symbols/behavior rather than because of an unrelated environment problem.

## Task 2: Implement the backend Xiangongyun adapter and configuration

**Files:**

- Create: `backend/xiangongyun_client.py`
- Modify: `backend/config.py`
- Modify: `backend/routers/settings.py`
- Modify: `backend/tests/test_xiangongyun_client.py`
- Modify: `backend/tests/test_xiangongyun_settings.py`

- [ ] Add defaults and effective config helpers:
  - `comfyui_runtime_provider = "direct"`
  - `xiangongyun_base_url = "https://api.xiangongyun.com"`
  - empty `xiangongyun_api_token`
  - empty `xiangongyun_default_instance_id`
  - no environment fallback for the Xiangongyun token or instance id.
- [ ] Implement `XiangongyunClient` as an async httpx adapter with methods `list_instances`, `get_instance`, `boot_instance`, and `shutdown_instance`.
- [ ] Centralize URL joining, Bearer header creation, response parsing, API error conversion, timeout handling, and redaction in the adapter; never expose the token in exception strings.
- [ ] Parse the documented instance payload into a stable internal response while retaining fields needed by the UI (`id`, `name`, `gpu_model`, `gpu_used`, CPU fields, `status`, `progress`, `web_url`, and other upstream metadata as appropriate).
- [ ] Extend `SettingsOut`, `SettingsUpdate`, and `_build_out` with provider, base URL, token-set/preview, and default instance fields. Preserve masked-token update semantics: an omitted/blank token leaves the stored token unchanged, while a newly entered token replaces it.
- [ ] Validate provider as `direct | xiangongyun`, accept only HTTP(S) base URLs, strip trailing slashes, trim ids, and reject invalid boot/shutdown ids before making upstream calls.
- [ ] Add protected worker runtime output containing provider, ComfyUI connection data, and (only for the Xiangongyun provider) the server-side Xiangongyun credentials/default instance needed by the content worker.
- [ ] Add settings proxy routes:
  - `GET /api/settings/xiangongyun/instances`
  - `GET /api/settings/xiangongyun/instances/{instance_id}`
  - `POST /api/settings/xiangongyun/instances/{instance_id}/boot`
  - `POST /api/settings/xiangongyun/instances/{instance_id}/shutdown`
- [ ] Map adapter failures to the existing FastAPI error style without returning upstream secrets or raw authorization headers; preserve useful status/error information for the settings UI.
- [ ] Run Task 1 and Task 2 backend tests until green, then run the existing ComfyUI, HeyGen, and settings regression tests.

## Task 3: Read frontend implementation guidance and define typed client behavior

**Files:**

- Read: `web/AGENTS.md`
- Read: relevant files under `web/node_modules/next/dist/docs/`
- Read: `build-web-apps:shadcn-best-practices/SKILL.md`
- Read: `web/lib/api/settings.ts`
- Read: `web/components/ui/select.tsx`
- Create: `web/lib/xiangongyun/client.ts`
- Create: `web/lib/xiangongyun/client.test.ts`

- [ ] Before writing frontend code, read the required Next.js guidance and shadcn guidance and record any constraints that affect client components, async effects, and Select usage.
- [ ] Define `XiangongyunInstance` with the documented lifecycle/status fields and an extensible metadata shape for fields the API may add.
- [ ] Define `XiangongyunError` with safe user-facing message, HTTP/API code, and retryability; exclude authorization data from all serializable error fields.
- [ ] Implement `createXiangongyunClient({ baseUrl, apiToken })` with typed `getInstances`, `getInstance`, `bootInstance`, `shutdownInstance`, and `ensureInstanceRunning` methods.
- [ ] Keep the client independent from React and from the browser settings API: it is used by the worker with credentials received from the protected runtime endpoint, while browser settings operations call backend proxy routes.
- [ ] Implement the lifecycle state machine: fetch current status; return on `running`; boot exactly once from `shutdown`; poll transitional states; reject terminal/unavailable states; enforce the 5-minute default timeout.
- [ ] Let `ensureInstanceRunning` receive injected `sleep` and cancellation/status hooks so tests and worker cancellation are deterministic without real five-minute waits.
- [ ] Add client tests first for running/no boot, shutdown/boot/poll, transitional polling, timeout, terminal state, API error, and Bearer header.

## Task 4: Add ComfyUI provider selection and Xiangongyun settings UI

**Files:**

- Modify: `web/lib/api/settings.ts`
- Modify: `web/lib/api/settings-test-fixtures.ts`
- Modify: `web/app/settings/SettingsClient.tsx`
- Modify: `web/app/settings/sections/ComfyUISection.tsx`
- Create: `web/app/settings/sections/XiangongyunSection.tsx`
- Create: `web/app/settings/sections/XiangongyunSection.test.tsx`
- Create: `web/app/settings/sections/ComfyUISection.test.tsx`
- Modify: `web/app/settings/SettingsClient.test.tsx`

- [ ] Extend `AppSettings` and `SettingsUpdate` with provider, Xiangongyun base URL, token-set/preview, and default instance id fields without putting the raw token in browser state.
- [ ] Add browser API helpers for the four settings proxy operations: list instances, get one, boot, and shutdown; keep request errors consistent with existing settings helpers.
- [ ] Add a `Select` to `ComfyUISection` with `direct` (default) and `xiangongyun` options, explanatory text, and save behavior through the existing settings update path. Do not require Xiangongyun fields while `direct` is selected.
- [ ] Add a dedicated “仙宫云” settings section with:
  - base URL input;
  - password token input showing only a masked/preview state and never pre-filling the secret;
  - refreshable instance list and default-instance Select;
  - selected instance status/details including status/progress/GPU model/usage and web URL when available;
  - manual refresh, boot, and shutdown actions;
  - status refresh while an instance is selected/configured, with cleanup on unmount.
- [ ] Save URL/default instance independently from whether the user re-enters the token; show a clear validation message if the selected default is missing from the refreshed list, without silently changing it.
- [ ] Add the section to settings navigation and render routing; preserve current section deep-link behavior and existing settings layout.
- [ ] Test direct vs Xiangongyun selection, masked-token save semantics, list/default selection, boot/shutdown button calls, status rendering, and settings navigation.

## Task 5: Integrate the worker gate into digital-human shot rendering

**Files:**

- Modify: `web/lib/ai/digital-human-shot-job.ts`
- Modify: `web/lib/ai/digital-human-shot-job.test.ts`
- Modify: `web/scripts/content-worker.ts` only if the runtime dependency wiring requires an explicit change

- [ ] Extend `ShotJobDeps` with optional Xiangongyun client and instance id so existing direct-mode unit tests and callers remain source-compatible.
- [ ] Update `defaultDeps` to fetch ComfyUI runtime and Xiangongyun runtime configuration in parallel, then construct the Xiangongyun client only when the provider is `xiangongyun`.
- [ ] Fail early with a safe actionable message when Xiangongyun mode lacks a token or default instance id; keep current ComfyUI URL validation and direct-mode error behavior.
- [ ] At the beginning of `runDigitalHumanShotRenderJob`, before shot context/ComfyUI work, call `ensureInstanceRunning` only when the configured provider supplied the optional client/id.
- [ ] Pass the existing worker `sleep` into the client and provide a cancellation callback that checks the current job; cancellation must abort boot polling and preserve the existing cancelled-job handling.
- [ ] Ensure the gate is executed once per job, does not auto-shutdown after rendering, and does not affect HeyGen jobs, local stitch, or direct-mode runs.
- [ ] Add failing-then-green tests for direct-mode no-call, running no-boot, shutdown boot, transitional polling, cancellation during polling, missing runtime configuration, and unchanged render ordering after the gate.

## Task 6: Focused verification and handoff

**Files:**

- Modify only the implementation/test files above if verification finds a defect.

- [ ] Run backend focused tests:
  `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_xiangongyun_client.py backend/tests/test_xiangongyun_settings.py backend/tests/test_comfyui_settings.py backend/tests/test_heygen_settings.py -q`
- [ ] Run backend digital-human/settings regressions that cover worker runtime and route contracts; report any sandbox-only listener or database-fixture failures separately.
- [ ] Run frontend exact tests:
  `cd web && pnpm exec vitest run lib/xiangongyun/client.test.ts app/settings/sections/XiangongyunSection.test.tsx app/settings/sections/ComfyUISection.test.tsx app/settings/SettingsClient.test.tsx lib/ai/digital-human-shot-job.test.ts`
- [ ] Run `cd web && pnpm exec tsc --noEmit --incremental false` and `cd web && pnpm build`.
- [ ] Inspect `git diff` and `git status --short` to confirm only intended new/modified files are attributed to this task and the pre-existing dirty files remain untouched.
- [ ] Do not claim live Xiangongyun connectivity; report it as pending until the user enters a real API token and the configured environment can reach the upstream service.
- [ ] If all focused checks pass, summarize configuration steps for the user: choose `仙宫云` in ComfyUI runtime, fill token, refresh/select default instance, save, and use manual boot/shutdown controls.

---

## Execution Notes

- Execute one task at a time and keep each implementation change preceded by its failing test when practical.
- Prefer existing settings/client/error conventions over introducing a second configuration or notification system.
- Keep upstream payload handling tolerant to harmless extra fields, but make lifecycle status decisions explicit and covered by tests.
