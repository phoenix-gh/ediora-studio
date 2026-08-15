# 文字视频模板品牌与视觉设置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除第一款 Remotion 模板的旧品牌硬编码，提供平台默认值和作品级覆盖，并让旧作品保留旧成片、只标记视频需要重新渲染。

**Architecture:** 后端模板清单拥有唯一的参数规范化逻辑，供作品创建、作品更新、设置 API 和幂等迁移复用；前端 Remotion 清单同时声明渲染 schema 与可序列化表单描述。设置页和作品对话框复用同一模板参数表单，作品保存继续走现有修订号与自动保存机制。

**Tech Stack:** FastAPI、Pydantic、SQLAlchemy Async、SQLite/PostgreSQL、Next.js 16、React 19、TypeScript、Zod、Remotion 4、shadcn/Base UI、Pytest、Vitest、Testing Library、Playwright。

## Global Constraints

- 默认品牌必须是 `EDIORA / 述策`，代码中不得再渲染可见的 `WEMEDIA`。
- 第一模板身份保持 `tech-text-v1@1`，新增字段必须兼容旧 `templateProps`。
- 可配置字段为 `brandTitle`、`brandSubtitle`、`showBrand`、`accentColor`、`background`、`showProgress`、`showSceneNumber` 和现有 `textDensity`。
- `background` 仅允许 `dark-grid`、`deep-space`、`clean-gradient`；`accentColor` 仅允许六位十六进制颜色。
- 平台默认值只影响新作品；已有作品保存完整参数快照。
- 模板视觉参数变化只能使视频成片过期，不得使配音、主音频、逐字时间轴或分镜失效。
- 旧 MP4 地址必须保留，使用持久化 `output_stale` 标记提示重新渲染。
- 模板设置使用对话框，不使用侧边抽屉。
- 第一阶段不支持 Logo 上传、自由拖拽、自由 CSS、自定义字体或 AI 自动主题。
- 当前工作区包含无关未提交改动；不得清理、覆盖或提交它们。每次提交必须使用精确 pathspec。

---

## File Structure

### Backend

- `backend/text_video_templates.py`：模板参数描述、代码默认值、参数规范化和平台默认配置解析的唯一边界。
- `backend/text_video_scene_plan.py`：继续负责画幅与分镜投影校验，模板参数部分委托给 `text_video_templates.py`。
- `backend/models.py`：为 `TextVideoProject` 增加 `output_stale`。
- `backend/database.py`：增加字段并幂等补齐旧第一模板参数。
- `backend/routers/settings.py`：公开和更新 `text_video_template_defaults`。
- `backend/routers/text_videos.py`：新作品读取平台默认值，项目响应公开 `output_stale`。
- `backend/text_video_domain.py`：视觉配置变化时只标记成片过期。
- `backend/tests/test_text_video_templates.py`：模板参数类型、默认补齐和拒绝规则。
- `backend/tests/test_database_text_video_migration.py`：字段与旧项目迁移。
- `backend/tests/test_text_video_template_settings.py`：设置 API 和新作品继承默认值。
- `backend/tests/test_text_video_domain.py`：作品视觉更新的成片失效语义。
- `backend/tests/test_text_videos_router.py`：序列化、修订号和非法设置的路由行为。
- `backend/tests/text_video_factories.py`：测试项目默认参数和 `output_stale`。

### Frontend and Remotion

- `web/remotion/types.ts`：增加模板设置字段和分组描述类型。
- `web/remotion/templates/tech-text-v1/config.ts`：第一模板 Zod schema、默认值、设置描述与背景枚举。
- `web/remotion/templates/tech-text-v1/manifest.ts`：组装组件与独立配置。
- `web/remotion/templates/tech-text-v1/Composition.tsx`：只根据已校验参数渲染品牌、背景和辅助元素。
- `web/remotion/templates/tech-text-v1/Composition.test.tsx`：品牌、开关、背景和强调色渲染测试。
- `web/remotion/contract.test.ts`：旧参数补齐、严格字段和描述一致性测试。
- `web/components/features/text-video/TemplateSettingsForm.tsx`：设置页和作品对话框共享的清单驱动表单。
- `web/components/features/text-video/TemplateSettingsForm.test.tsx`：通用控件和字段错误测试。
- `web/app/settings/sections/TextVideoSection.tsx`：平台模板默认值编辑。
- `web/app/settings/sections/TextVideoSection.test.tsx`：读取、修改和保存默认值。
- `web/app/settings/SettingsClient.tsx`：增加“文字视频”设置入口。
- `web/app/settings/SettingsClient.test.tsx`：设置导航回归。
- `web/lib/api/settings.ts`：设置 API 类型。
- `web/lib/api/settings-test-fixtures.ts`：前端设置测试默认数据。
- `web/lib/api/text-videos.ts`：公开 `output_stale`。
- `web/lib/text-video/test-fixtures.ts`：前端文字视频测试数据。
- `web/app/text-video/TemplateSettingsDialog.tsx`：作品级设置草稿、预览、恢复默认和确认保存。
- `web/app/text-video/TemplateSettingsDialog.test.tsx`：取消、预览、恢复和错误行为。
- `web/app/text-video/VideoStage.tsx`：模板设置入口与上一版成片提示。
- `web/app/text-video/VideoStage.test.tsx`：入口和过期状态测试。
- `web/app/text-video/TextVideoWorkbench.tsx`：把作品设置保存动作传递给视频阶段。
- `web/app/text-video/TextVideoEditorClient.tsx`：原子更新本地项目并立即 flush。
- `web/app/text-video/useTextVideoAutosave.ts`：允许 `markDirty(nextProject)` 同步更新保存快照。
- `web/app/text-video/useTextVideoAutosave.test.tsx`：同一交互周期内立即保存新项目快照。
- `web/e2e/text-video-production.spec.ts`：真实页面对话框与持久化回归。

---

### Task 1: Backend Template Parameter Contract

**Files:**
- Modify: `backend/text_video_templates.py`
- Modify: `backend/text_video_scene_plan.py`
- Create: `backend/tests/test_text_video_templates.py`
- Modify: `backend/tests/test_text_video_scene_plan.py`
- Modify: `backend/tests/text_video_factories.py`

**Interfaces:**
- Produces: `normalize_text_video_template_props(manifest: dict, value: object, *, fill_missing: bool) -> dict`
- Produces: `text_video_template_defaults(manifest: dict) -> dict`
- Produces: `normalize_text_video_template_default_map(value: object) -> dict[str, dict]`
- Consumes: existing `get_text_video_template(template_id: str, version: int) -> dict`

- [ ] **Step 1: Write failing backend contract tests**

Create tests proving that legacy props receive only the new defaults, valid custom values survive normalization, and unknown/invalid fields fail:

```python
def test_tech_template_fills_new_brand_defaults_for_legacy_props():
    manifest = get_text_video_template("tech-text-v1", 1)
    normalized = normalize_text_video_template_props(
        manifest,
        {
            "theme": "tech-blue",
            "font": "source-han-sans",
            "background": "dark-grid",
            "transition": "soft-push",
            "textDensity": "standard",
        },
        fill_missing=True,
    )
    assert normalized["brandTitle"] == "EDIORA"
    assert normalized["brandSubtitle"] == "述策"
    assert normalized["accentColor"] == "#69F6FF"
    assert normalized["showBrand"] is True


@pytest.mark.parametrize("field,value", [
    ("accentColor", "cyan"),
    ("brandTitle", "x" * 33),
    ("background", "remote-css"),
    ("showProgress", "true"),
])
def test_tech_template_rejects_invalid_values(field, value):
    manifest = get_text_video_template("tech-text-v1", 1)
    props = text_video_template_defaults(manifest) | {field: value}
    with pytest.raises(ValueError, match=field):
        normalize_text_video_template_props(
            manifest, props, fill_missing=False,
        )
```

- [ ] **Step 2: Run tests and confirm the new contract is absent**

Run:

```bash
python -m pytest backend/tests/test_text_video_templates.py -q
```

Expected: collection or import failure because the normalization functions do not exist.

- [ ] **Step 3: Replace string-only capabilities with typed descriptors**

In `backend/text_video_templates.py`, describe every prop as `literal`, `enum`, `string`, `boolean`, or `color`. Keep existing fixed fields strict, add the approved defaults, and implement the three exported normalizers. The normalizer must:

```python
def normalize_text_video_template_props(
    manifest: dict[str, Any],
    value: object,
    *,
    fill_missing: bool,
) -> dict[str, Any]:
    # reject non-dicts and unknown keys
    # fill only missing keys when fill_missing=True
    # reject missing keys when fill_missing=False
    # strip brand strings, preserve blank brand strings
    # require bool values to be actual bools
    # accept only #[0-9A-Fa-f]{6}, returning uppercase hex
    # return keys in manifest order
```

`normalize_text_video_template_default_map` must accept a decoded persisted map keyed by `templateId@version`, reject unknown template keys, normalize partial per-template values with `fill_missing=True`, and return code defaults for a missing map.

- [ ] **Step 4: Delegate scene-plan validation to the shared normalizer**

Replace the string-only loop in `validate_template_configuration` with:

```python
template_props = normalize_text_video_template_props(
    manifest,
    template_props,
    fill_missing=True,
)
return deepcopy(composition), template_props
```

Retain strict rejection of unknown fields and all existing composition checks.

- [ ] **Step 5: Run targeted backend tests**

Run:

```bash
python -m pytest \
  backend/tests/test_text_video_templates.py \
  backend/tests/test_text_video_scene_plan.py \
  backend/tests/test_text_video_domain.py -q
```

Expected: all pass.

- [ ] **Step 6: Commit the contract only**

```bash
git add backend/text_video_templates.py backend/text_video_scene_plan.py \
  backend/tests/test_text_video_templates.py \
  backend/tests/test_text_video_scene_plan.py \
  backend/tests/text_video_factories.py
git commit --only -m "feat: define text video template settings contract" -- \
  backend/text_video_templates.py backend/text_video_scene_plan.py \
  backend/tests/test_text_video_templates.py \
  backend/tests/test_text_video_scene_plan.py \
  backend/tests/text_video_factories.py
```

---

### Task 2: Persisted Output Staleness and Legacy Migration

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Modify: `backend/text_video_domain.py`
- Modify: `backend/routers/text_videos.py`
- Modify: `backend/tests/test_database_text_video_migration.py`
- Modify: `backend/tests/test_text_video_domain.py`
- Modify: `backend/tests/test_text_videos_router.py`
- Modify: `backend/tests/text_video_factories.py`

**Interfaces:**
- Consumes: `normalize_text_video_template_props(..., fill_missing=True)` from Task 1
- Produces: `TextVideoProject.output_stale: bool`
- Produces: project JSON field `output_stale: boolean`

- [ ] **Step 1: Write failing migration and domain tests**

Add a migration case with three rows: an affected legacy project with an MP4, one without an MP4, and a complete project. Assert idempotence and address preservation:

```python
assert legacy_with_output["output_asset_url"] == "/api/uploads/old.mp4"
assert legacy_with_output["output_stale"] == 1
assert legacy_without_output["output_stale"] == 0
assert json.loads(legacy_with_output["render_input"])["templateProps"][
    "brandTitle"
] == "EDIORA"
assert complete_project["output_stale"] == 0
```

Add domain tests:

```python
def test_template_change_marks_only_existing_video_output_stale():
    project = _make_video_ready_project()
    project.output_asset_url = "/api/uploads/old.mp4"
    merge_editable_project(project, {
        "template": {
            "templateId": "tech-text-v1",
            "templateVersion": 1,
            "templateProps": (
                project.render_input["templateProps"]
                | {"accentColor": "#FF3366"}
            ),
        },
    }, speech_model="mimo-v2.5-tts")
    assert project.output_stale is True
    assert project.master_audio["status"] == "ready"
    assert project.scene_plan["status"] == "ready"
```

Add a router test that submits the already persisted template props and asserts that the response revision is unchanged.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
python -m pytest \
  backend/tests/test_database_text_video_migration.py \
  backend/tests/test_text_video_domain.py -q
```

Expected: failures because the model and schema have no `output_stale`.

- [ ] **Step 3: Add the model field and schema migration**

Add:

```python
output_stale: Mapped[bool] = mapped_column(
    Boolean, nullable=False, default=False,
)
```

Extend `migrate_text_video_project_schema` with a dialect-safe non-null boolean column. Read `render_input`, `output_asset_url`, and `output_stale`; only normalize `tech-text-v1@1` rows whose props are missing approved fields. Persist normalized JSON and set stale only when the row owns a non-empty output URL. A second migration run must leave the row unchanged.

- [ ] **Step 4: Add precise domain invalidation**

In `_apply_visual_edits`, after detecting a real template, composition, or scene intent change:

```python
if project.output_asset_url:
    project.output_stale = True
```

When `output_asset_url` is replaced with a different non-empty successful output, set `output_stale=False`. Do not call the audio downstream invalidator for visual-only changes.

- [ ] **Step 5: Serialize and type the new state**

Add `output_stale` to both summary and full project responses. Before `merge_editable_project`, deep-copy the editable model fields; after merging, return the unchanged project without a commit or revision increment when every field is equal:

```python
EDITABLE_PROJECT_FIELDS = (
    "title", "status", "stage", "script", "voice_settings", "paragraphs",
    "speech_split_mode", "master_audio", "scene_plan", "render_input",
    "cover_asset_url", "output_asset_url", "output_stale",
)
before = {
    field: deepcopy(getattr(project, field))
    for field in EDITABLE_PROJECT_FIELDS
}
merge_editable_project(...)
if all(getattr(project, field) == value for field, value in before.items()):
    return serialize_project(project)
```

Preserve current route conflict handling and increment the revision exactly once for a real change.

- [ ] **Step 6: Run migration, domain, and router tests**

Run:

```bash
python -m pytest \
  backend/tests/test_database_text_video_migration.py \
  backend/tests/test_text_video_domain.py \
  backend/tests/test_text_videos_router.py -q
```

Expected: all pass.

- [ ] **Step 7: Commit the state change**

```bash
git add backend/models.py backend/database.py backend/text_video_domain.py \
  backend/routers/text_videos.py \
  backend/tests/test_database_text_video_migration.py \
  backend/tests/test_text_video_domain.py \
  backend/tests/test_text_videos_router.py \
  backend/tests/text_video_factories.py
git commit --only -m "feat: track stale text video outputs" -- \
  backend/models.py backend/database.py backend/text_video_domain.py \
  backend/routers/text_videos.py \
  backend/tests/test_database_text_video_migration.py \
  backend/tests/test_text_video_domain.py \
  backend/tests/test_text_videos_router.py \
  backend/tests/text_video_factories.py
```

---

### Task 3: Platform Defaults API and New-Project Inheritance

**Files:**
- Modify: `backend/routers/settings.py`
- Modify: `backend/routers/text_videos.py`
- Create: `backend/tests/test_text_video_template_settings.py`
- Modify: `backend/tests/test_text_videos_router.py`

**Interfaces:**
- Consumes: `normalize_text_video_template_default_map(value)` from Task 1
- Produces: `SettingsOut.text_video_template_defaults: dict[str, dict]`
- Consumes and produces: `SettingsUpdate.text_video_template_defaults: dict[str, dict] | None`

- [ ] **Step 1: Write failing settings and creation tests**

Cover public defaults, persisted overrides, atomic `422` rejection, corrupted stored JSON fallback, and inheritance:

```python
def test_text_video_defaults_are_public_and_normalized(client):
    body = client.get("/api/settings").json()
    props = body["text_video_template_defaults"]["tech-text-v1@1"]
    assert props["brandTitle"] == "EDIORA"
    assert props["brandSubtitle"] == "述策"


def test_new_project_copies_current_platform_defaults(client):
    saved = client.put("/api/settings", json={
        "text_video_template_defaults": {
            "tech-text-v1@1": {
                "brandTitle": "CHANNEL ONE",
                "accentColor": "#FF3366",
            },
        },
    })
    assert saved.status_code == 200
    created = client.post("/api/text-videos", json={"title": "继承测试"}).json()
    assert created["render_input"]["templateProps"]["brandTitle"] == "CHANNEL ONE"
    assert created["render_input"]["templateProps"]["accentColor"] == "#FF3366"
```

- [ ] **Step 2: Run the new tests and verify failure**

Run:

```bash
python -m pytest backend/tests/test_text_video_template_settings.py -q
```

Expected: response fields are absent.

- [ ] **Step 3: Extend settings schemas and persistence**

Add the normalized map to `SettingsOut` and `SettingsUpdate`. `_build_out` must parse the JSON string, log malformed data, and fall back to code defaults. PUT must normalize the complete submitted map before `json.dumps(..., ensure_ascii=False)` and `set_config`; any bad template, field, or value must return one `422` without persisting any part.

- [ ] **Step 4: Apply defaults during project creation**

In `create_project`, call `get_config()`, normalize `text_video_template_defaults`, deep-copy the `tech-text-v1@1` entry into `DEFAULT_RENDER_INPUT["templateProps"]`, and validate it before database insertion. Existing projects must never read this map during serialization.

- [ ] **Step 5: Run settings and text-video router tests**

Run:

```bash
python -m pytest \
  backend/tests/test_text_video_template_settings.py \
  backend/tests/test_text_videos_router.py \
  backend/tests/test_speech_settings.py -q
```

Expected: all pass, including unrelated settings fields.

- [ ] **Step 6: Commit the API**

```bash
git add backend/routers/settings.py backend/routers/text_videos.py \
  backend/tests/test_text_video_template_settings.py \
  backend/tests/test_text_videos_router.py
git commit --only -m "feat: persist text video template defaults" -- \
  backend/routers/settings.py backend/routers/text_videos.py \
  backend/tests/test_text_video_template_settings.py \
  backend/tests/test_text_videos_router.py
```

---

### Task 4: Frontend Manifest Contract and Remotion Rendering

**Files:**
- Modify: `web/remotion/types.ts`
- Create: `web/remotion/templates/tech-text-v1/config.ts`
- Modify: `web/remotion/templates/tech-text-v1/manifest.ts`
- Modify: `web/remotion/templates/tech-text-v1/Composition.tsx`
- Create: `web/remotion/templates/tech-text-v1/Composition.test.tsx`
- Modify: `web/remotion/contract.test.ts`
- Modify: `web/remotion/registry.test.ts`
- Modify: `web/remotion/Root.test.ts`

**Interfaces:**
- Produces: `TextVideoTemplateSettingField<P>` and `TextVideoTemplateSettingGroup<P>`
- Produces: `techTextV1PropsSchema`, `TECH_TEXT_V1_DEFAULTS`, `TECH_TEXT_V1_SETTINGS`
- Produces: manifest property `settings`

- [ ] **Step 1: Write failing manifest and component tests**

Add contract coverage for legacy parsing:

```ts
const parsed = parse({
  ...validInput,
  templateProps: {
    theme: 'tech-blue',
    font: 'source-han-sans',
    background: 'dark-grid',
    transition: 'soft-push',
    textDensity: 'standard',
  },
})
expect(parsed.templateProps).toMatchObject({
  brandTitle: 'EDIORA',
  brandSubtitle: '述策',
  showBrand: true,
  accentColor: '#69F6FF',
})
```

Mock Remotion frame/config hooks and render the composition. Assert default text, hidden brand behavior, scene-number toggle, progress toggle, custom accent style, and all three background branches.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd web
npm test -- \
  remotion/contract.test.ts \
  remotion/templates/tech-text-v1/Composition.test.tsx
```

Expected: missing config module and old hardcoded `WEMEDIA`.

- [ ] **Step 3: Add serializable settings descriptor types**

Define a discriminated union whose `key` is `Extract<keyof P, string>`:

```ts
export type TextVideoTemplateSettingField<P> =
  | { key: Extract<keyof P, string>; kind: 'text'; label: string; maxLength: number }
  | { key: Extract<keyof P, string>; kind: 'boolean'; label: string }
  | { key: Extract<keyof P, string>; kind: 'select'; label: string; options: readonly { value: string; label: string }[] }
  | { key: Extract<keyof P, string>; kind: 'color'; label: string }
```

Add `settings: readonly TextVideoTemplateSettingGroup<P>[]` to the manifest. Registry tests must reject duplicate setting keys and descriptors whose keys do not exist in `defaults`.

- [ ] **Step 4: Extract the first-template configuration**

Create `config.ts` to avoid a manifest/component import cycle. Use Zod defaults only for the newly introduced fields:

```ts
export const techTextV1PropsSchema = z.object({
  theme: z.literal('tech-blue'),
  font: z.literal('source-han-sans'),
  background: z.enum(['dark-grid', 'deep-space', 'clean-gradient']),
  transition: z.literal('soft-push'),
  textDensity: z.enum(['compact', 'standard', 'spacious']),
  brandTitle: z.string().trim().max(32).default('EDIORA'),
  brandSubtitle: z.string().trim().max(32).default('述策'),
  showBrand: z.boolean().default(true),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/u).default('#69F6FF'),
  showProgress: z.boolean().default(true),
  showSceneNumber: z.boolean().default(true),
}).strict()
```

Export complete defaults and grouped field descriptors from the same file.

- [ ] **Step 5: Render only from validated props**

Type the component as `TextVideoRenderInput<TechTextV1Props>`. Replace the hardcoded brand with a joined title/subtitle, use `accentColor` for the line/progress/glow, map `background` to three internal gradient definitions, gate progress and scene number, and apply a fixed multiplier map for text density:

```ts
const densityScale = {
  compact: 0.88,
  standard: 1,
  spacious: 1.12,
}[props.templateProps.textDensity]
```

No user string may be interpolated into a raw CSS declaration other than the validated hex color.

- [ ] **Step 6: Run Remotion contract and registry tests**

Run:

```bash
cd web
npm test -- \
  remotion/contract.test.ts \
  remotion/registry.test.ts \
  remotion/Root.test.ts \
  remotion/templates/tech-text-v1/Composition.test.tsx
```

Expected: all pass.

- [ ] **Step 7: Commit the rendering contract**

```bash
git add web/remotion/types.ts \
  web/remotion/templates/tech-text-v1/config.ts \
  web/remotion/templates/tech-text-v1/manifest.ts \
  web/remotion/templates/tech-text-v1/Composition.tsx \
  web/remotion/templates/tech-text-v1/Composition.test.tsx \
  web/remotion/contract.test.ts \
  web/remotion/registry.test.ts \
  web/remotion/Root.test.ts
git commit --only -m "feat: make first text video template configurable" -- \
  web/remotion/types.ts \
  web/remotion/templates/tech-text-v1/config.ts \
  web/remotion/templates/tech-text-v1/manifest.ts \
  web/remotion/templates/tech-text-v1/Composition.tsx \
  web/remotion/templates/tech-text-v1/Composition.test.tsx \
  web/remotion/contract.test.ts \
  web/remotion/registry.test.ts \
  web/remotion/Root.test.ts
```

---

### Task 5: Shared Form and Platform Settings Page

**Files:**
- Create: `web/components/features/text-video/TemplateSettingsForm.tsx`
- Create: `web/components/features/text-video/TemplateSettingsForm.test.tsx`
- Create: `web/app/settings/sections/TextVideoSection.tsx`
- Create: `web/app/settings/sections/TextVideoSection.test.tsx`
- Modify: `web/app/settings/SettingsClient.tsx`
- Modify: `web/app/settings/SettingsClient.test.tsx`
- Modify: `web/lib/api/settings.ts`
- Modify: `web/lib/api/settings-test-fixtures.ts`

**Interfaces:**
- Consumes: `manifest.settings`, `manifest.propsSchema`, and `manifest.defaults`
- Produces: `TemplateSettingsForm({ manifest, value, onChange, fieldErrors })`
- Produces: `templateSettingsFieldErrors(error: ZodError): Record<string, string>`
- Produces: `AppSettings.text_video_template_defaults`

- [ ] **Step 1: Write failing shared-form tests**

Test text, switch, select, and color controls using a small fake manifest. Verify controlled updates and per-field errors:

```tsx
expect(screen.getByRole('textbox', { name: '品牌主标题' }))
  .toHaveValue('EDIORA')
await user.clear(screen.getByRole('textbox', { name: '品牌主标题' }))
await user.type(
  screen.getByRole('textbox', { name: '品牌主标题' }),
  'CHANNEL ONE',
)
expect(onChange).toHaveBeenLastCalledWith(
  expect.objectContaining({ brandTitle: 'CHANNEL ONE' }),
)
```

Add settings-section tests that save a changed map through `updateSettings`.

- [ ] **Step 2: Run tests and verify missing components**

Run:

```bash
cd web
npm test -- \
  components/features/text-video/TemplateSettingsForm.test.tsx \
  app/settings/sections/TextVideoSection.test.tsx \
  app/settings/SettingsClient.test.tsx
```

Expected: imports fail because the new form and section are absent.

- [ ] **Step 3: Add API types and fixtures**

Add:

```ts
export type TextVideoTemplateDefaults = Record<
  string,
  Record<string, unknown>
>
```

Expose it on `AppSettings` and `SettingsUpdate`, and add normalized first-template defaults to `makeSettings`.

- [ ] **Step 4: Build the manifest-driven form**

Render `Field`, `Input`, `Switch`, and `Select` based only on descriptor kind. The color control must synchronize `<input type="color">` with a text input. It must not own save state or call APIs. Use `aria-invalid` and `FieldDescription` for field errors. Export `templateSettingsFieldErrors`, which takes the first Zod issue for each top-level key and returns `{ [key]: issue.message }`.

- [ ] **Step 5: Build the platform settings section**

Resolve templates from `textVideoTemplates`, let the user choose one, initialize its complete normalized values from `settings.text_video_template_defaults`, and save the complete map:

```ts
const parsed = manifest.propsSchema.safeParse(draft)
if (!parsed.success) {
  setFieldErrors(templateSettingsFieldErrors(parsed.error))
  return
}
const updated = await updateSettings({
  text_video_template_defaults: {
    ...settings.text_video_template_defaults,
    [templateKey]: parsed.data,
  },
})
```

Display a success toast only after the API returns.

- [ ] **Step 6: Add the settings navigation entry**

Add `text-video` to `SectionId`, navigation, title map, imports, and render switch. Label it “文字视频”，description “模板 · 品牌 · 默认视觉”。

- [ ] **Step 7: Run frontend settings tests**

Run:

```bash
cd web
npm test -- \
  components/features/text-video/TemplateSettingsForm.test.tsx \
  app/settings/sections/TextVideoSection.test.tsx \
  app/settings/SettingsClient.test.tsx \
  lib/api/settings-telegram.test.ts
```

Expected: all pass.

- [ ] **Step 8: Commit the shared UI and settings page**

```bash
git add web/components/features/text-video/TemplateSettingsForm.tsx \
  web/components/features/text-video/TemplateSettingsForm.test.tsx \
  web/app/settings/sections/TextVideoSection.tsx \
  web/app/settings/sections/TextVideoSection.test.tsx \
  web/app/settings/SettingsClient.tsx \
  web/app/settings/SettingsClient.test.tsx \
  web/lib/api/settings.ts \
  web/lib/api/settings-test-fixtures.ts
git commit --only -m "feat: configure default text video visuals" -- \
  web/components/features/text-video/TemplateSettingsForm.tsx \
  web/components/features/text-video/TemplateSettingsForm.test.tsx \
  web/app/settings/sections/TextVideoSection.tsx \
  web/app/settings/sections/TextVideoSection.test.tsx \
  web/app/settings/SettingsClient.tsx \
  web/app/settings/SettingsClient.test.tsx \
  web/lib/api/settings.ts \
  web/lib/api/settings-test-fixtures.ts
```

---

### Task 6: Work-Level Settings Dialog and Atomic Save

**Files:**
- Create: `web/app/text-video/TemplateSettingsDialog.tsx`
- Create: `web/app/text-video/TemplateSettingsDialog.test.tsx`
- Modify: `web/app/text-video/VideoStage.tsx`
- Modify: `web/app/text-video/VideoStage.test.tsx`
- Modify: `web/app/text-video/TextVideoWorkbench.tsx`
- Modify: `web/app/text-video/TextVideoWorkbench.test.tsx`
- Modify: `web/app/text-video/TextVideoEditorClient.tsx`
- Modify: `web/app/text-video/TextVideoEditorClient.test.tsx`
- Modify: `web/app/text-video/useTextVideoAutosave.ts`
- Modify: `web/app/text-video/useTextVideoAutosave.test.tsx`
- Modify: `web/lib/api/text-videos.ts`
- Modify: `web/lib/text-video/test-fixtures.ts`

**Interfaces:**
- Consumes: shared `TemplateSettingsForm` and `getSettings()`
- Produces: `TemplateSettingsDialog({ open, project, onOpenChange, onApply })`
- Produces: `onApply(props: Record<string, unknown>): Promise<void>`
- Changes: `markDirty(nextProject?: TextVideoProject): void`

- [ ] **Step 1: Write failing autosave and dialog tests**

Prove `markDirty(nextProject)` immediately changes the snapshot used by a same-tick `flush()`:

```tsx
act(() => {
  result.current.markDirty(nextProject)
})
await act(async () => {
  await result.current.flush()
})
expect(save).toHaveBeenCalledWith(
  nextProject.id,
  expect.objectContaining({
    template: expect.objectContaining({
      templateProps: nextProject.render_input.templateProps,
    }),
  }),
)
```

Dialog tests must cover:

- editing updates only draft preview;
- Cancel calls no save;
- “恢复平台默认值” loads the current platform entry but does not save;
- Apply validates and awaits `onApply`;
- API load failure preserves current values and disables Restore;
- backend save error keeps the dialog open and user input intact.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd web
npm test -- \
  app/text-video/useTextVideoAutosave.test.tsx \
  app/text-video/TemplateSettingsDialog.test.tsx \
  app/text-video/VideoStage.test.tsx
```

Expected: the new dialog is absent and autosave cannot stage a next project synchronously.

- [ ] **Step 3: Make autosave staging atomic**

Change `markDirty` to accept an optional next project:

```ts
const markDirty = useCallback((nextProject?: TextVideoProject) => {
  if (nextProject) projectRef.current = nextProject
  dirtyVersionRef.current += 1
  setDirtyVersion(dirtyVersionRef.current)
  setSaveState('dirty')
}, [])
```

Update `TextVideoEditorClient.changeProject` to call `autosave.markDirty(nextProject)` before `setProject(nextProject)`. Existing calls without an argument remain valid.

- [ ] **Step 4: Build the settings dialog**

On open:

1. resolve the project manifest;
2. clone current parsed props into local draft;
3. fetch `getSettings()` and retain the current template entry as restore data;
4. construct a draft project for `RemotionPreview`;
5. render the shared form and preview inside `Dialog`.

The reset button label is exactly “恢复平台默认值”. Apply must run `manifest.propsSchema.safeParse`, display per-field errors, await `onApply(parsed.data)`, and close only on success.

- [ ] **Step 5: Wire immediate save through the editor**

Pass an async handler from `TextVideoEditorClient` through `TextVideoWorkbench` and `VideoStage`:

```ts
async function applyTemplateSettings(
  templateProps: Record<string, unknown>,
) {
  const next = {
    ...project,
    render_input: {
      ...project.render_input,
      templateProps,
    },
  }
  autosave.markDirty(next)
  setProject(next)
  await autosave.flush()
}
```

`useTextVideoAutosave` already calls `onSavedProject` with the conflict-safe merged server result, so the handler must not overwrite it after `flush()`. The VideoStage button opens the dialog. It must remain separate from the existing AI director dialog.

- [ ] **Step 6: Display previous-output state**

Add `output_stale` to API and fixture types. If both `output_asset_url` and `output_stale` are truthy, show a compact notice “模板视觉已更新，当前为上一版成片；重新渲染后更新” without removing the existing URL. Do not enable the currently unavailable MP4 button as part of this feature.

- [ ] **Step 7: Run editor and autosave tests**

Run:

```bash
cd web
npm test -- \
  app/text-video/useTextVideoAutosave.test.tsx \
  app/text-video/TemplateSettingsDialog.test.tsx \
  app/text-video/VideoStage.test.tsx \
  app/text-video/TextVideoWorkbench.test.tsx \
  app/text-video/TextVideoEditorClient.test.tsx \
  lib/api/text-videos.test.ts
```

Expected: all pass.

- [ ] **Step 8: Commit the work-level UI**

```bash
git add web/app/text-video/TemplateSettingsDialog.tsx \
  web/app/text-video/TemplateSettingsDialog.test.tsx \
  web/app/text-video/VideoStage.tsx \
  web/app/text-video/VideoStage.test.tsx \
  web/app/text-video/TextVideoWorkbench.tsx \
  web/app/text-video/TextVideoWorkbench.test.tsx \
  web/app/text-video/TextVideoEditorClient.tsx \
  web/app/text-video/TextVideoEditorClient.test.tsx \
  web/app/text-video/useTextVideoAutosave.ts \
  web/app/text-video/useTextVideoAutosave.test.tsx \
  web/lib/api/text-videos.ts \
  web/lib/text-video/test-fixtures.ts
git commit --only -m "feat: edit template visuals per text video" -- \
  web/app/text-video/TemplateSettingsDialog.tsx \
  web/app/text-video/TemplateSettingsDialog.test.tsx \
  web/app/text-video/VideoStage.tsx \
  web/app/text-video/VideoStage.test.tsx \
  web/app/text-video/TextVideoWorkbench.tsx \
  web/app/text-video/TextVideoWorkbench.test.tsx \
  web/app/text-video/TextVideoEditorClient.tsx \
  web/app/text-video/TextVideoEditorClient.test.tsx \
  web/app/text-video/useTextVideoAutosave.ts \
  web/app/text-video/useTextVideoAutosave.test.tsx \
  web/lib/api/text-videos.ts \
  web/lib/text-video/test-fixtures.ts
```

---

### Task 7: End-to-End Verification and Visual QA

**Files:**
- Modify: `web/e2e/text-video-production.spec.ts`
- Modify only if verification exposes a defect: files owned by Tasks 1–6

**Interfaces:**
- Consumes: completed backend and frontend feature
- Produces: regression proof for default inheritance, work-level override, persistence, and old-brand removal

- [ ] **Step 1: Add an end-to-end persistence scenario**

Extend the existing text-video Playwright test to:

1. open Settings → 文字视频；
2. set platform title to `CHANNEL DEFAULT` and save；
3. create a new text-video project；
4. reach or load its video stage fixture；
5. open “模板设置”；
6. verify inherited title；
7. change it to `WORK OVERRIDE` and disable scene numbers；
8. apply, reload, and verify values persist；
9. assert the rendered preview contains no `WEMEDIA` text.

- [ ] **Step 2: Run complete backend text-video and settings suites**

Run:

```bash
python -m pytest \
  backend/tests/test_text_video_templates.py \
  backend/tests/test_database_text_video_migration.py \
  backend/tests/test_text_video_template_settings.py \
  backend/tests/test_text_video_domain.py \
  backend/tests/test_text_video_scene_plan.py \
  backend/tests/test_text_videos_router.py \
  backend/tests/test_speech_settings.py -q
```

Expected: all pass with no skipped feature tests.

- [ ] **Step 3: Run complete frontend targeted suites**

Run:

```bash
cd web
npm test -- \
  remotion \
  components/features/text-video \
  app/settings \
  app/text-video \
  lib/api/text-videos.test.ts
```

Expected: all pass.

- [ ] **Step 4: Run lint and production build**

Run:

```bash
cd web
npm run lint -- \
  remotion \
  components/features/text-video \
  app/settings \
  app/text-video \
  lib/api/settings.ts \
  lib/api/text-videos.ts
npm run build
```

Expected: zero lint errors and a successful Next.js production build.

- [ ] **Step 5: Run browser regression**

With the API and web services using the current checkout:

```bash
cd web
npx playwright test e2e/text-video-production.spec.ts
```

Expected: the template dialog, platform defaults, work override, reload persistence, and preview assertions pass.

- [ ] **Step 6: Perform visual checks at all supported ratios**

Open one ready project and inspect `9:16`, `16:9`, and `1:1` using:

- default `dark-grid` with `EDIORA / 述策`;
- `deep-space` with a custom accent;
- `clean-gradient` with brand, progress, and scene number hidden.

Confirm safe-area placement, no clipped text, readable contrast, dialog scrolling, and preview parity.

- [ ] **Step 7: Commit only the end-to-end test if changed**

```bash
git add web/e2e/text-video-production.spec.ts
git commit --only -m "test: cover text video template settings flow" -- \
  web/e2e/text-video-production.spec.ts
```

- [ ] **Step 8: Record final evidence**

Capture:

- backend pass count;
- frontend pass count;
- lint result;
- build result;
- Playwright result;
- exact commits created;
- any pre-existing unrelated failures, clearly separated from feature results.
