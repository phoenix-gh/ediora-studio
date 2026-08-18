# Configurable LLM Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 将单组 LLM/图片配置改造成多个 OpenAI-compatible Adapter，并让 X 素材信息筛选和图片 URL/base64 生成都使用明确的 Adapter 解析链。

**Architecture:** 后端新增纯配置解析模块，负责 Adapter 校验、脱敏和按能力/用途解析；AppSetting 继续以 JSON 字符串保存 Adapter 列表，旧字段保留为兼容回退。X 订阅保存可选的 llm_adapter_id，topic-source worker 通过受保护的运行时接口请求信息筛选模型。图片调用统一经过 image-generation.ts 的字节 helper，base64 使用现有 AI SDK，URL 直接调用 OpenAI Images API、下载远程文件后复用现有资产上传接口。

**Tech Stack:** FastAPI/Pydantic, SQLAlchemy async/PostgreSQL, Next.js/React, TypeScript, Vercel AI SDK, Vitest, pytest。

**Spec:** docs/superpowers/specs/2026-08-18-llm-adapters-design.md

## Global Constraints

- 第一阶段协议只接受 openai，不新增其他供应商协议。
- 一个 Adapter 只配置一个 model 字段；能力由 supports_text 和 supports_image 声明。
- 图片 image_response_format 只能为 url 或 base64；URL 结果必须下载后落入现有本地资产流程。
- 信息筛选 Adapter 的优先级为：订阅覆盖值 → 全局信息筛选 Adapter → 全局默认 Adapter → 旧配置兼容路径。
- API Key 只写不读；普通设置响应只返回 api_key_set 和末四位预览。
- 不能因能力不匹配静默改用另一个 Adapter；任务必须返回可定位错误。
- 只运行相关聚焦测试，不运行无关全量测试。
- 每一项生产代码修改前先写失败测试并现场确认红灯。

---

### Task 1: Adapter domain model and resolver

**Files:**
- Create: backend/llm_adapters.py
- Create: backend/tests/test_llm_adapters.py
- Modify: backend/config.py:12-20

**Interfaces:**
- Consumes legacy llm_* and image_* keys plus JSON values under llm_adapters, llm_default_adapter_id, llm_information_filtering_adapter_id.
- Produces LLMAdapterInput, LLMAdapterPublic, ResolvedLLMAdapter, parse_stored_adapters, public_adapters, save_adapter_payloads, resolve_adapter.

- [ ] **Step 1: Write failing resolver tests**

Test information-filtering precedence, capability rejection, and masking:

~~~python
def test_resolve_information_filtering_prefers_global_filter_adapter():
    cfg = {
        "llm_adapters": json.dumps([
            {"id": "default", "name": "默认", "protocol": "openai",
             "endpoint": "https://default.example/v1", "api_key": "d",
             "model": "default-model", "supports_text": True,
             "supports_image": False, "image_response_format": "base64"},
            {"id": "filter", "name": "筛选", "protocol": "openai",
             "endpoint": "https://filter.example/v1", "api_key": "f",
             "model": "filter-model", "supports_text": True,
             "supports_image": False, "image_response_format": "base64"},
        ]),
        "llm_default_adapter_id": "default",
        "llm_information_filtering_adapter_id": "filter",
    }
    resolved = resolve_adapter(cfg, purpose="information_filtering", capability="text")
    assert resolved.adapter_id == "filter"
    assert resolved.base_url == "https://filter.example/v1"


def test_resolve_rejects_adapter_without_requested_capability():
    cfg = {"llm_adapters": json.dumps([{
        "id": "text-only", "name": "文本", "protocol": "openai",
        "endpoint": "https://example.com/v1", "api_key": "secret",
        "model": "text-model", "supports_text": True,
        "supports_image": False, "image_response_format": "base64",
    }])}
    with pytest.raises(AdapterResolutionError, match="不支持 image"):
        resolve_adapter(cfg, adapter_id="text-only", capability="image")


def test_public_adapters_mask_api_keys():
    [item] = public_adapters(json.dumps([{
        "id": "one", "name": "一个", "protocol": "openai",
        "endpoint": "https://example.com/v1", "api_key": "secret-1234",
        "model": "model", "supports_text": True, "supports_image": True,
        "image_response_format": "url",
    }]))
    assert item.api_key_set is True
    assert item.api_key_preview == "…1234"
    assert not hasattr(item, "api_key")
~~~

- [ ] **Step 2: Run and verify red**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_llm_adapters.py -q
~~~

Expected: FAIL because the module and resolver interfaces do not exist.

- [ ] **Step 3: Implement the minimal Adapter module**

Use Pydantic models with these input/public fields:

~~~python
class LLMAdapterInput(BaseModel):
    id: str | None = None
    name: str
    protocol: Literal["openai"] = "openai"
    endpoint: str
    model: str
    supports_text: bool = False
    supports_image: bool = False
    image_response_format: Literal["url", "base64"] = "base64"
    api_key: str | None = None
    clear_api_key: bool = False

class LLMAdapterPublic(BaseModel):
    id: str
    name: str
    protocol: Literal["openai"]
    endpoint: str
    model: str
    supports_text: bool
    supports_image: bool
    image_response_format: Literal["url", "base64"]
    api_key_set: bool
    api_key_preview: str
~~~

Add ResolvedLLMAdapter with adapter_id, name, protocol, api_key, model, base_url, capability flags, and image response format. Normalize endpoint trailing slashes and HTTP(S), reject empty name/model or no capabilities, generate IDs for new entries, and preserve an existing key when incoming api_key is blank unless clear_api_key is true. resolve_adapter uses explicit ID, then information-filter setting for purpose=information_filtering, then default setting, then legacy text/image keys. Raise AdapterResolutionError for missing ID/key/capability. Add empty JSON defaults for the three new config keys.

- [ ] **Step 4: Run resolver and legacy tests**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_llm_adapters.py backend/tests/test_runtime_config.py -q
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add backend/config.py backend/llm_adapters.py backend/tests/test_llm_adapters.py
git commit -m "feat: add configurable llm adapter resolver"
~~~

### Task 2: Settings API and runtime selection

**Files:**
- Modify: backend/routers/settings.py:1-330,380-430,575-735
- Modify: backend/database.py:1250-1280
- Create: backend/tests/test_llm_adapter_settings.py
- Modify: backend/tests/test_blog_publish.py:100-130

**Interfaces:**
- Consumes Task 1 helpers and the existing AsyncSession in PUT /api/settings.
- Produces public settings fields llm_adapters, llm_default_adapter_id, llm_information_filtering_adapter_id and GET /api/settings/ai-runtime query selection.

- [ ] **Step 1: Write failing API tests**

Save two adapters and verify masking, selector persistence, blank-key preservation, explicit clear, information-filtering selection, invalid protocol/endpoint/capability, invalid selector IDs, and worker-token protection. Include:

~~~python
def test_settings_persist_multiple_adapters_and_mask_keys(client):
    response = client.put("/api/settings", json={
        "llm_adapters": [{
            "id": "filter", "name": "信息筛选", "protocol": "openai",
            "endpoint": "https://filter.example/v1", "api_key": "filter-secret",
            "model": "filter-model", "supports_text": True,
            "supports_image": False, "image_response_format": "base64",
        }],
        "llm_default_adapter_id": "filter",
        "llm_information_filtering_adapter_id": "filter",
    })
    assert response.status_code == 200, response.text
    assert response.json()["llm_adapters"][0]["api_key_set"] is True
    assert "filter-secret" not in response.text


def test_ai_runtime_uses_information_filtering_adapter(client):
    client.put("/api/settings", json={
        "llm_adapters": [
            {"id": "default", "name": "默认", "endpoint": "https://d.example/v1",
             "api_key": "d", "model": "default-model", "supports_text": True},
            {"id": "filter", "name": "筛选", "endpoint": "https://f.example/v1",
             "api_key": "f", "model": "filter-model", "supports_text": True},
        ],
        "llm_default_adapter_id": "default",
        "llm_information_filtering_adapter_id": "filter",
    })
    response = client.get(
        "/api/settings/ai-runtime?capability=text&purpose=information_filtering",
        headers={"X-Worker-Token": "test-worker-token"},
    )
    assert response.json()["adapter_id"] == "filter"
    assert response.json()["model"] == "filter-model"
~~~

Update the existing image-runtime test to assert image_response_format=base64 while old nested image fields remain available.

- [ ] **Step 2: Run and verify red**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_llm_adapter_settings.py backend/tests/test_blog_publish.py -q
~~~

Expected: FAIL because settings schemas and runtime query parameters are absent.

- [ ] **Step 3: Extend settings schemas and persistence**

Add llm_adapters, llm_default_adapter_id, llm_information_filtering_adapter_id to SettingsOut and corresponding optional fields to SettingsUpdate. In _build_out call public_adapters and never serialize internal keys. In update_settings merge write-only keys with the stored list using save_adapter_payloads, JSON-encode it, validate selector IDs, and query XSubscription.llm_adapter_id before allowing deletion of a referenced Adapter. Preserve legacy update branches.

- [ ] **Step 4: Extend /ai-runtime without breaking old workers**

Use:

~~~python
class ImageRuntimeConfig(BaseModel):
    adapter_id: str
    protocol: str
    api_key: str
    model: str
    base_url: str
    image_response_format: Literal["url", "base64"]

class AiRuntimeConfig(BaseModel):
    adapter_id: str
    protocol: str
    api_key: str
    model: str
    base_url: str
    image_response_format: Literal["url", "base64"]
    image: ImageRuntimeConfig
~~~

Accept optional adapter_id, capability=text|image, and purpose=information_filtering. Use resolve_adapter for top-level fields. Without query and without a new list retain legacy fields. With capability=image populate top-level and nested fields from the selected image Adapter. Return 422 with resolver message for missing key/capability/ID.

- [ ] **Step 5: Run regressions and commit**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_llm_adapter_settings.py backend/tests/test_blog_publish.py backend/tests/test_speech_settings.py -q
git add backend/routers/settings.py backend/database.py backend/tests/test_llm_adapter_settings.py backend/tests/test_blog_publish.py
git commit -m "feat: expose configurable llm adapters in settings"
~~~

### Task 3: X subscription Adapter persistence and dispatch

**Files:**
- Modify: backend/models.py:172-201
- Modify: backend/database.py:1268-1280
- Modify: backend/routers/x.py:20-285
- Modify: backend/topic_source_service.py:20-105
- Modify: backend/tests/test_x_router.py
- Modify: backend/tests/test_topic_source_service.py

**Interfaces:**
- Consumes Task 1 resolver and Task 2 settings.
- Produces nullable XSubscription.llm_adapter_id, API field, and topic-source job input containing the optional override.

- [ ] **Step 1: Write failing tests**

Configure a text Adapter, create/patch a subscription, verify round-trip and image-only/unknown rejection, then assert dispatch_topic_source_posts stores this in ContentJob.input_data:

~~~python
{"llm_adapter_id": "filter"}
~~~

Use the existing async database/session fixture in test_topic_source_service.py.

- [ ] **Step 2: Run and verify red**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_router.py backend/tests/test_topic_source_service.py -q
~~~

Expected: FAIL because the model, request fields, and job payload do not contain llm_adapter_id.

- [ ] **Step 3: Add column and migration**

Add to XSubscription:

~~~python
llm_adapter_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
~~~

Add an idempotent VARCHAR column migration in init_db. Do not add a relational foreign key because adapters live in JSON settings.

- [ ] **Step 4: Add validation and persistence**

Add llm_adapter_id: str | None = None to create, patch, and output schemas. Distinguish omitted from explicit null using body.model_fields_set. For a non-empty value call resolve_adapter(cfg, adapter_id=value, capability="text") and translate errors to HTTP 422. Return the persisted value.

- [ ] **Step 5: Carry override into durable jobs**

Load XSubscription in dispatch_topic_source_posts and include its value in input_data. Accept null/empty/missing values in is_valid_topic_source_payload, but reject non-string non-empty values. Use the same payload for backfill.

- [ ] **Step 6: Run regressions and commit**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_router.py backend/tests/test_topic_source_service.py backend/tests/test_database_init_postgres.py -q
git add backend/models.py backend/database.py backend/routers/x.py backend/topic_source_service.py backend/tests/test_x_router.py backend/tests/test_topic_source_service.py
git commit -m "feat: select an adapter for x asset filtering"
~~~

### Task 4: Frontend Adapter types and runtime mapping

**Files:**
- Modify: web/lib/api/settings.ts:1-180
- Modify: web/lib/api/settings-test-fixtures.ts:1-110
- Modify: web/lib/ai/runtime-config.ts:1-40
- Modify: web/lib/ai/runtime-config.test.ts

**Interfaces:**
- Consumes Task 2 public settings/runtime JSON.
- Produces LLMAdapter, LLMAdapterInput, ImageResponseFormat, settings selectors, and ImageModelConfig.responseFormat.

- [ ] **Step 1: Write failing runtime tests**

~~~ts
it('maps image response format from the selected runtime adapter', () => {
  expect(imageModelConfigFromSettings({
    adapter_id: 'images',
    api_key: 'sk-image',
    model: 'dall-e-3',
    base_url: 'https://images.example/v1',
    image_response_format: 'url',
  })).toEqual({
    apiKey: 'sk-image',
    modelName: 'dall-e-3',
    baseURL: 'https://images.example/v1',
    responseFormat: 'url',
  })
})

it('defaults missing legacy image response format to base64', () => {
  expect(imageModelConfigFromSettings({ api_key: 'sk-image', model: 'gpt-image-1' }).responseFormat)
    .toBe('base64')
})
~~~

- [ ] **Step 2: Run and verify red**

~~~bash
pnpm exec vitest run lib/ai/runtime-config.test.ts
~~~

Expected: FAIL because the fields are not represented.

- [ ] **Step 3: Add types and mapping**

Add public LLMAdapter fields, write-only api_key?/clear_api_key? input fields, AppSettings.llm_adapters, both selector IDs, and SettingsUpdate equivalents. Extend runtime settings with adapter_id, protocol, and image_response_format; map a missing image response format to base64.

- [ ] **Step 4: Run and commit**

~~~bash
pnpm exec vitest run lib/ai/runtime-config.test.ts lib/api/settings-telegram.test.ts
git add web/lib/api/settings.ts web/lib/api/settings-test-fixtures.ts web/lib/ai/runtime-config.ts web/lib/ai/runtime-config.test.ts
git commit -m "feat: add frontend llm adapter runtime types"
~~~

### Task 5: AI settings UI for multiple Adapter instances

**Files:**
- Create: web/app/settings/sections/LLMAdapterEditor.tsx
- Modify: web/app/settings/sections/AISection.tsx
- Modify: web/app/settings/sections/AISection.test.tsx

**Interfaces:**
- Consumes Task 4 types and settings API.
- Produces editable Adapter list, global default selector, and independent information-filtering selector.

- [ ] **Step 1: Add failing multi-Adapter UI tests**

Use two adapters (one text-only, one text+image URL) and assert selector and save payload:

~~~tsx
it('saves multiple adapters and independent information filtering selection', async () => {
  vi.mocked(updateSettings).mockResolvedValue(makeSettings())
  render(<AISection settings={makeSettings({
    llm_adapters: [
      { id: 'chat-main', name: '主文本', protocol: 'openai',
        endpoint: 'https://chat.example/v1', model: 'chat-model',
        supports_text: true, supports_image: false,
        image_response_format: 'base64', api_key_set: true,
        api_key_preview: '…1234' },
      { id: 'filter-image', name: '筛选图片', protocol: 'openai',
        endpoint: 'https://image.example/v1', model: 'dall-e-3',
        supports_text: true, supports_image: true,
        image_response_format: 'url', api_key_set: true,
        api_key_preview: '…5678' },
    ],
    llm_default_adapter_id: 'chat-main',
    llm_information_filtering_adapter_id: 'filter-image',
  })} onSaved={vi.fn()} />)

  expect(screen.getByLabelText('信息筛选 Adapter')).toHaveValue('filter-image')
  fireEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }))

  await waitFor(() => expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
    llm_default_adapter_id: 'chat-main',
    llm_information_filtering_adapter_id: 'filter-image',
    llm_adapters: expect.arrayContaining([
      expect.objectContaining({ id: 'chat-main', supports_text: true }),
      expect.objectContaining({ id: 'filter-image', supports_image: true, image_response_format: 'url' }),
    ]),
  })))
})
~~~

Also assert keys are not rendered and clear-key is explicit.

- [ ] **Step 2: Run and verify red**

~~~bash
pnpm exec vitest run app/settings/sections/AISection.test.tsx
~~~

Expected: FAIL because the component still renders the single legacy form.

- [ ] **Step 3: Implement the editor**

LLMAdapterEditor owns one editable LLMAdapterInput and emits change/delete/model-fetch callbacks. It shows name, disabled OpenAI protocol, endpoint, model, write-only key, capability checkboxes, and URL/base64 only when image capability is enabled. Blank key preserves the saved key; clear action sets clear_api_key. Show a warning for URL plus a model matching /^gpt-image-/i.

AISection initializes the list, creates a client-side ID for new rows, tracks both selectors, limits information-filter options to supports_text adapters, and sends the complete list plus selectors. Keep prompt-generation history and existing model suggestions.

- [ ] **Step 4: Run settings regressions and commit**

~~~bash
pnpm exec vitest run app/settings/sections/AISection.test.tsx app/settings/SettingsClient.test.tsx
git add web/app/settings/sections/LLMAdapterEditor.tsx web/app/settings/sections/AISection.tsx web/app/settings/sections/AISection.test.tsx
git commit -m "feat: manage multiple llm adapters in settings"
~~~

### Task 6: Image URL download path and shared helper

**Files:**
- Modify: web/lib/ai/image-generation.ts:1-190
- Modify: web/lib/ai/content-job.ts:1-20,230-375
- Modify: web/lib/ai/image-generation.test.ts
- Modify: web/lib/ai/content-job.test.ts

**Interfaces:**
- Consumes ImageModelConfig.responseFormat.
- Produces generateImageBytes(config, prompt, options): Promise<{ bytes: Uint8Array; mediaType: string }>.

- [ ] **Step 1: Make URL tests genuinely red**

Update the existing URL runtime response to include image_response_format=url and use dall-e-3; add base64, missing-URL, non-image, and no-Authorization CDN tests.

~~~bash
pnpm exec vitest run lib/ai/image-generation.test.ts -t 'provider image URL|base64|missing URL'
~~~

Expected: FAIL because current code always calls AI SDK and never downloads a provider URL.

- [ ] **Step 2: Implement the shared helper**

For base64, call the existing AI SDK and return first image bytes/media type. For URL, reject /^gpt-image-/i, call {baseURL}/images/generations for text prompts or {baseURL}/images/edits multipart for reference prompts, always send response_format=url, validate data[0].url as HTTP(S), download without provider Authorization, reject non-2xx/empty/non-image responses, infer common image media types, and return copied bytes.

Update generateAndSaveImage, runImageFlow, and runPromptImageGenerationFlow to use the helper and derive upload filename extension from media type. Keep existing upload retry behavior.

- [ ] **Step 3: Run image/content tests and commit**

~~~bash
pnpm exec vitest run lib/ai/image-generation.test.ts lib/ai/content-job.test.ts
git add web/lib/ai/image-generation.ts web/lib/ai/content-job.ts web/lib/ai/image-generation.test.ts web/lib/ai/content-job.test.ts
git commit -m "feat: download url image results before asset upload"
~~~

### Task 7: Topic-source worker and X subscription UI

**Files:**
- Modify: web/lib/api/x.ts:1-60
- Modify: web/app/x/XSubscriptionDialog.tsx:1-210
- Modify: web/app/x/XSubscriptionDialog.test.tsx
- Modify: web/lib/ai/topic-source-job.ts:205-235
- Modify: web/lib/ai/topic-source-job-runtime.test.ts

**Interfaces:**
- Consumes Task 3 llm_adapter_id, Task 4 settings types, and existing worker API helpers.
- Produces X request types with optional adapter ID and topic-source runtime request with purpose=information_filtering.

- [ ] **Step 1: Add failing worker/UI tests**

Assert a merged job with input.llm_adapter_id=filter requests capability=text, purpose=information_filtering, and adapter_id=filter. Mock getSettings in the dialog with text-capable adapters and assert the selector defaults to “跟随全局设置” for null and submits a selected ID for create/edit.

- [ ] **Step 2: Run and verify red**

~~~bash
pnpm exec vitest run lib/ai/topic-source-job-runtime.test.ts app/x/XSubscriptionDialog.test.tsx
~~~

Expected: FAIL because the worker ignores the ID and the dialog has no selector.

- [ ] **Step 3: Implement wiring**

Extend XSubscription, create input, and patch types with llm_adapter_id?: string | null. In the dialog, load settings alongside directories, filter adapters by supports_text, render a nullable “跟随全局设置” option, and include selection in create/edit bodies. If settings loading fails, preserve follow-global behavior.

Make configuredModel(adapterId?: string) build URLSearchParams with capability=text and purpose=information_filtering, appending the ID only when present. Keep classification parsing and asset persistence unchanged.

- [ ] **Step 4: Run and commit**

~~~bash
pnpm exec vitest run lib/ai/topic-source-job-runtime.test.ts app/x/XSubscriptionDialog.test.tsx app/x/XClient.test.tsx
git add web/lib/api/x.ts web/app/x/XSubscriptionDialog.tsx web/app/x/XSubscriptionDialog.test.tsx web/lib/ai/topic-source-job.ts web/lib/ai/topic-source-job-runtime.test.ts
git commit -m "feat: route x screening through selected adapter"
~~~

### Task 8: Integration verification and handoff

- [ ] **Step 1: Run focused backend tests**

~~~bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_llm_adapters.py \
  backend/tests/test_llm_adapter_settings.py \
  backend/tests/test_blog_publish.py \
  backend/tests/test_x_router.py \
  backend/tests/test_topic_source_service.py \
  backend/tests/test_database_init_postgres.py -q
~~~

- [ ] **Step 2: Run focused frontend tests**

~~~bash
pnpm exec vitest run \
  lib/ai/runtime-config.test.ts \
  lib/ai/image-generation.test.ts \
  lib/ai/content-job.test.ts \
  lib/ai/topic-source-job-runtime.test.ts \
  app/settings/sections/AISection.test.tsx \
  app/x/XSubscriptionDialog.test.tsx \
  app/x/XClient.test.tsx
~~~

- [ ] **Step 3: Run static checks**

~~~bash
pnpm exec eslint \
  lib/api/settings.ts lib/api/x.ts lib/ai/runtime-config.ts \
  lib/ai/image-generation.ts lib/ai/content-job.ts lib/ai/topic-source-job.ts \
  app/settings/sections/AISection.tsx \
  app/settings/sections/LLMAdapterEditor.tsx \
  app/x/XSubscriptionDialog.tsx
~~~

Expected: exit code 0.

- [ ] **Step 4: Inspect final diff**

~~~bash
git diff --check
git status --short --branch
git log --oneline --decorate -8
~~~

Confirm no unrelated dirty files were modified, no API key appears in public settings output or tests, and all handoff claims are backed by fresh command output.

