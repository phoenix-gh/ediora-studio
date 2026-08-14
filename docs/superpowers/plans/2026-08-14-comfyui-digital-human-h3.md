# ComfyUI H3 数字人口播 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有数字人口播上增加 ComfyUI / MiniMax H3 后端：按镜生成短片并硬切拼接，HeyGen 路径保持不变。

**Architecture:** 领域对象仍是角色 / 作品 / 不可变成片。ComfyUI 角色用本地定妆图就绪；作品编辑镜头列表；每镜一个 durable job，拼接另建成片版本。HeyGen 继续走整段脚本和 `digital_human_render`。

**Tech Stack:** FastAPI + SQLAlchemy + PostgreSQL, Next.js / TypeScript worker, ComfyUI HTTP API, Pillow 定妆合成, ffmpeg 拼接。

## Global Constraints

- HeyGen 角色、作品、成片和 `digital_human_render` 不得破坏。
- 角色 `provider` 为 `heygen | comfyui`，创建后不可改；存量回填 `heygen`。
- ComfyUI 角色录音可空；就绪条件是 `look_asset_id`。
- 单镜时长有效区间：`max(settings.min, workflow.min)` … `min(settings.max, workflow.max)`；默认 4–5 秒。
- 默认硬切；镜间音频 120ms 交叉淡化。
- 成片必须先写入本地创作资产再 `succeeded`。
- ComfyUI 地址和 token 只在服务端；runtime 接口要 worker token。
- 工作流模板用 meta 映射，禁止在业务代码里硬编码节点数字 ID。
- OOM 标失败，不自动改时长或分辨率重跑。
- 浏览器不拿 ComfyUI token 或 HeyGen key。

## File Structure

- `backend/config.py` — ComfyUI 默认项与 effective helpers
- `backend/routers/settings.py` — 读写、runtime、连通性测试
- `backend/models.py` / `backend/database.py` — provider、look、shots、nullable voice
- `backend/digital_human_look.py` — Pillow 定妆合成
- `backend/digital_human_shots.py` — 镜头校验、脚本派生、时长区间
- `backend/digital_human_service.py` — 按 provider 创建角色、按镜任务、拼接
- `backend/routers/digital_humans.py` / `talking_videos.py` — 公开与 worker API
- `wemedia-studio/lib/comfyui/client.ts` — ComfyUI HTTP 客户端
- `wemedia-studio/lib/comfyui/workflows/h3-i2v-v1.json` + `.meta.json`
- `wemedia-studio/lib/ai/digital-human-job.ts` — setup 分支、shot、stitch
- `wemedia-studio/app/settings/sections/ComfyUISection.tsx`
- `wemedia-studio/app/digital-humans/*` — 角色后端选择与镜头编辑器

---

### Task 1: ComfyUI 设置与客户端

**Files:**
- Create: `backend/tests/test_comfyui_settings.py`
- Create: `wemedia-studio/lib/comfyui/client.ts`
- Create: `wemedia-studio/lib/comfyui/client.test.ts`
- Create: `wemedia-studio/app/settings/sections/ComfyUISection.tsx`
- Modify: `backend/config.py`
- Modify: `backend/routers/settings.py`
- Modify: `wemedia-studio/lib/api/settings.ts`
- Modify: `wemedia-studio/lib/api/settings-test-fixtures.ts`
- Modify: `wemedia-studio/app/settings/SettingsClient.tsx`

**Interfaces:**
- Produces: `effective_comfyui_base_url(cfg) -> str`, `effective_comfyui_auth_token(cfg) -> str`
- Produces: `GET /api/settings/comfyui-runtime` → `{ base_url, auth_token, min_shot_seconds, max_shot_seconds }`
- Produces: `POST /api/settings/comfyui/test` → `{ ok, error }`
- Produces: `createComfyUIClient({ baseUrl, authToken })` with `systemStats`, `uploadImage`, `queuePrompt`, `getHistory`, `getQueue`, `viewFile`

- [ ] Write `backend/tests/test_comfyui_settings.py` covering redacted token, runtime worker auth, env fallback `COMFYUI_BASE_URL`, connection classification (unreachable / 401 / 200).
- [ ] Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_comfyui_settings.py -q` — expect FAIL (routes missing).
- [ ] Implement config defaults `comfyui_base_url=""`, `comfyui_auth_token=""`, `comfyui_min_shot_seconds="4"`, `comfyui_max_shot_seconds="5"` and settings GET/PUT/runtime/test. Test calls `GET {base}/system_stats` with optional `Authorization: Bearer`.
- [ ] Implement TypeScript client + vitest. Token only in Authorization header, never in URL.
- [ ] Add settings UI section next to HeyGen.
- [ ] Commit: `feat: add ComfyUI settings and HTTP client`

### Task 2: 角色 provider、定妆图、可空录音

**Files:**
- Create: `backend/digital_human_look.py`
- Create: `backend/tests/test_digital_human_look.py`
- Modify: `backend/models.py` (`DigitalHuman.provider`, `look_asset_id`, nullable `voice_sample_asset_id`)
- Modify: `backend/database.py` (add columns + nullable voice)
- Modify: `backend/digital_human_service.py`
- Modify: `backend/routers/digital_humans.py`
- Modify: `backend/tests/test_digital_human_service.py`
- Modify: `backend/tests/test_digital_humans_router.py`
- Modify: `wemedia-studio/lib/ai/digital-human-job.ts`
- Modify: `wemedia-studio/lib/ai/digital-human-job.test.ts`
- Modify: `wemedia-studio/lib/api/digital-humans.ts`

**Interfaces:**
- Consumes: Task 1 runtime (setup 合成本身不调 ComfyUI)
- Produces: `create_digital_human(..., provider, voice_sample_asset_id=None)`
- Produces: `compose_look_image(portrait_path, environment_path) -> bytes` at 1344×768
- Produces: worker `POST /api/digital-humans/{id}/compose-look`
- Ready: HeyGen still needs avatar+voice IDs; ComfyUI needs `look_asset_id`

- [ ] Tests: default provider heygen; comfyui allows missing voice; heygen still requires voice and API key; comfyui create does not require HeyGen key; changing provider rejected; look compose size 1344×768.
- [ ] Run service/router tests — expect FAIL.
- [ ] Implement model + migration via `_add_columns` and `ALTER ... ALTER COLUMN voice_sample_asset_id DROP NOT NULL`.
- [ ] Implement Pillow cover+bottom-center composite. Worker setup branches on `role.provider`.
- [ ] Existing HeyGen tests must still pass with implicit `provider=heygen`.
- [ ] Commit: `feat: add ComfyUI digital-human roles and look compose`

### Task 3: 镜头模型与按镜生成

**Files:**
- Create: `backend/digital_human_shots.py`
- Create: `backend/tests/test_digital_human_shots.py`
- Create: `wemedia-studio/lib/comfyui/workflows/h3-i2v-v1.json`
- Create: `wemedia-studio/lib/comfyui/workflows/h3-i2v-v1.meta.json`
- Create: `wemedia-studio/lib/comfyui/workflow.ts`
- Create: `wemedia-studio/lib/ai/digital-human-shot-job.ts`
- Create: `wemedia-studio/lib/ai/digital-human-shot-job.test.ts`
- Modify: `backend/models.py` (`TalkingVideoProject.shots`, `look_asset_id`)
- Modify: `backend/routers/talking_videos.py`
- Modify: `backend/digital_human_service.py`
- Modify: `wemedia-studio/scripts/content-worker.ts`
- Modify: `wemedia-studio/lib/api/digital-humans.ts`

**Interfaces:**
- Produces: `normalize_shots(raw, min_seconds, max_seconds) -> list[dict]`
- Produces: `script_from_shots(shots) -> str`
- Produces: `effective_shot_duration_bounds(settings, workflow_meta)`
- Produces: `PUT /api/talking-videos/{id}/shots`
- Produces: `POST /api/talking-videos/{id}/shots/{shot_id}/render`
- Produces: `POST /api/talking-videos/{id}/shots/render-pending`
- Produces: `digital_human_shot_render` job input `{ project_id, shot_id }`
- Prompt template from spec; duration written to workflow node only.

- [ ] Tests for duration bounds, script rewrite, reject over-max, first-frame fallback, enqueue shot job, 409 if ComfyUI unconfigured.
- [ ] Implement shot JSON validation and APIs.
- [ ] Implement workflow apply + ComfyUI poll with prompt_id reuse.
- [ ] Route worker flow `digital_human_shot_render`.
- [ ] Commit: `feat: generate talking-video shots through ComfyUI`

### Task 4: 拼接成片

**Files:**
- Create: `backend/tests/test_talking_video_stitch.py`
- Create: `wemedia-studio/lib/ai/digital-human-stitch-job.ts`
- Create: `wemedia-studio/lib/ai/digital-human-stitch-job.test.ts`
- Modify: `backend/models.py` (`TalkingVideoRender.shots_snapshot`)
- Modify: `backend/digital_human_service.py`
- Modify: `backend/routers/talking_videos.py`
- Modify: `wemedia-studio/scripts/content-worker.ts`

**Interfaces:**
- Produces: `POST /api/talking-videos/{id}/stitch`
- Produces: `digital_human_stitch` job input `{ render_id }`
- `POST /renders` on ComfyUI project → 409
- Concat: video hard cut, audio 120ms crossfade, H.264+AAC MP4

- [ ] Tests: reject incomplete shots, freeze snapshot, increment version, HeyGen `/renders` still works, ComfyUI `/renders` 409.
- [ ] Implement stitch service + worker ffmpeg concat.
- [ ] Commit: `feat: stitch ComfyUI shots into talking-video versions`

### Task 5: 镜头编辑页与脚本 AI

**Files:**
- Modify: `wemedia-studio/app/digital-humans/RoleEditorDialog.tsx`
- Modify: `wemedia-studio/app/digital-humans/TalkingVideoEditor.tsx`
- Modify: `wemedia-studio/app/digital-humans/ScriptAssistantDialog.tsx`
- Modify: `wemedia-studio/app/digital-humans/talking-video-editor.test.tsx`
- Modify: `wemedia-studio/app/digital-humans/role-management.test.tsx`
- Modify: `wemedia-studio/app/api/digital-human/script/route.ts` (or existing script route)

**Interfaces:**
- Consumes: shots APIs from Task 3–4
- HeyGen editor stays a single script textarea
- ComfyUI editor is a shot list with duration ≤ max, generate shot / pending / stitch

- [ ] Tests: provider selector; ComfyUI editor shows shots; HeyGen editor does not; stitch disabled while shots running or failed; duration cannot exceed max.
- [ ] Implement UI + script assistant returning shots when `provider=comfyui`.
- [ ] Commit: `feat: edit ComfyUI talking videos as a shot list`
