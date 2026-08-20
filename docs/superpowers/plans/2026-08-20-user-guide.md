# Ediora User Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a task-oriented Markdown user guide that takes a new Ediora user from minimum configuration through a GitHub release-based creation flow to an editable, publication-ready draft.

**Architecture:** Store framework-neutral Markdown under `docs/user-guide/`, with one entry index, one end-to-end quick start, focused core-flow chapters, independent advanced-topic chapters, and centralized troubleshooting. Treat the current UI and implementation as the source of truth; use relative links and add only real, sanitized screenshots that can be captured from a verified runtime.

**Tech Stack:** GitHub-Flavored Markdown, relative Markdown links, optional sanitized PNG screenshots, existing Next.js/React UI source as behavioral evidence.

**Spec:** `docs/superpowers/specs/2026-08-20-user-guide-design.md`

## Global Constraints

- The audience is a daily product user who can already open Ediora; do not teach development or deployment.
- The first-version success path ends with an inspected, publication-ready draft, not a mandatory external-platform publish.
- Use only standard Markdown headings, paragraphs, lists, tables, code fences, relative links, images, and blockquotes.
- Do not add framework-specific frontmatter, custom components, or special container syntax.
- Use exactly one level-one heading per document.
- Write visible UI paths in bold, for example **设置 → AI 大模型**, and visible button text in Chinese quotation marks.
- Every numbered operation must state both the user action and the expected result.
- Do not expose API keys, cookies, tokens, account details, or real user content.
- Do not claim behavior based only on `docs/superpowers/`; verify current UI source, tests, API contracts, or a live runtime.
- Do not create image references unless the corresponding sanitized image files actually exist.
- Keep the quick start on one recommended route; place alternatives in detailed or advanced chapters.
- Modify only Markdown and optional screenshot assets; do not change application behavior.

## Planned File Structure

| File | Responsibility |
| --- | --- |
| `docs/user-guide/README.md` | User-guide entry point and reading map |
| `docs/user-guide/quick-start.md` | One continuous GitHub release-to-draft walkthrough |
| `docs/user-guide/setup.md` | Minimum model, publishing account, writing template, and GitHub source preparation |
| `docs/user-guide/collect-content.md` | Add or refresh a GitHub source and confirm release content is available |
| `docs/user-guide/select-content.md` | Evaluate a release and choose direct creation versus saving it as a clue |
| `docs/user-guide/create-draft.md` | Create a writing job and locate its generated draft |
| `docs/user-guide/edit-and-prepare.md` | Edit, save, manage assets, and perform a publication-readiness check |
| `docs/user-guide/task-management.md` | Understand task states, inspect details, cancel, and retry safely |
| `docs/user-guide/text-video.md` | Advanced text-video workflow |
| `docs/user-guide/digital-human.md` | Advanced digital-human workflow |
| `docs/user-guide/troubleshooting.md` | Cross-feature symptom-to-action troubleshooting |
| `docs/user-guide/images/*.png` | Optional real, sanitized key-screen screenshots |
| `README.md` | Add only a concise user-guide link |

---

### Task 1: Minimum Setup Guide

**Files:**
- Create: `docs/user-guide/setup.md`

**Evidence:**
- `web/components/features/Sidebar.tsx`
- `web/app/settings/SettingsClient.tsx`
- `web/app/settings/sections/AISection.tsx`
- `web/app/settings/sections/AISection.test.tsx`
- `web/app/settings/sections/PublishAccountsSection.tsx`
- `web/app/settings/sections/PublishAccountsSection.test.tsx`
- `web/app/writing-plans/WritingPlansClient.tsx`
- `web/app/writing-plans/WritingPlansClient.test.tsx`
- `web/app/settings/sections/GitHubSection.tsx`
- `web/app/github/GithubClient.tsx`

**Interfaces:**
- Produces: `setup.md`, the prerequisite target linked by all later core-flow chapters.
- Consumes: Visible labels and requirements from the evidence files above.

- [ ] **Step 1: Confirm the current visible setup terminology**

Run:

```bash
rg -n "AI 大模型|LLM Adapter|文字默认|图片默认|信息筛选|发布账号|新增发布账号|写作模板|新建写作模板|GitHub API" \
  web/app/settings web/app/writing-plans web/app/github --glob '*.{ts,tsx}'
```

Expected: each term used in the guide is present in current UI source or tests. If a proposed label is absent, use the current visible label instead.

- [ ] **Step 2: Write `setup.md` with a fixed user-facing structure**

Use these top-level sections in this order:

```markdown
# 完成首次创作前的准备

## 完成后你将得到什么
## 配置 AI 模型
## 添加发布账号
## 创建一个写作模板
## 准备 GitHub 信息源
## 检查准备是否完成
## 常见问题
## 下一步
```

The completion checklist must require: a usable text adapter, an active publishing account, at least one writing template, and a GitHub repository or release source visible in the product. Explain image configuration as optional for the first text-only draft unless current runtime behavior proves it mandatory.

- [ ] **Step 3: Validate formatting and internal terminology**

Run:

```bash
git diff --check
test "$(rg -c '^# ' docs/user-guide/setup.md)" -eq 1
rg -n "worker|SQLAlchemy|Redis|数据库表|/api/" docs/user-guide/setup.md && exit 1 || true
```

Expected: no whitespace errors, one H1, and no internal implementation terms.

- [ ] **Step 4: Commit the setup guide**

```bash
git add docs/user-guide/setup.md
git commit -m "docs: add user guide setup"
```

---

### Task 2: Collection and Content Selection Guides

**Files:**
- Create: `docs/user-guide/collect-content.md`
- Create: `docs/user-guide/select-content.md`

**Evidence:**
- `web/app/github/GithubClient.tsx`
- `web/app/github/page.tsx`
- `web/lib/api/github.ts`
- `web/components/features/AddToTopicPopover.tsx`
- `web/components/features/PushToStudioPopover.tsx`
- `web/components/features/ArticleReader.tsx`

**Interfaces:**
- Consumes: `setup.md` for prerequisite links.
- Produces: a verified GitHub release selection path used by `quick-start.md` and `create-draft.md`.

- [ ] **Step 1: Verify the GitHub collection and creation controls**

Run:

```bash
rg -n "刷新|暂无发布记录|创建稿件|创建创作任务|加为写作方案线索|已加为线索" \
  web/app/github/GithubClient.tsx web/components/features/AddToTopicPopover.tsx
```

Expected: the collection empty state, refresh action, direct creation action, and clue-saving action are all traceable to current source.

- [ ] **Step 2: Write `collect-content.md`**

Use these sections:

```markdown
# 采集可用于创作的内容

## 完成后你将得到什么
## 开始前的准备
## 打开 GitHub 信息源
## 添加或选择仓库
## 刷新发布记录
## 确认采集成功
## 常见问题
## 下一步
```

State the successful result in visible terms: the selected repository shows one or more release records. Do not describe scheduler intervals, backend collectors, or database persistence.

- [ ] **Step 3: Write `select-content.md`**

Use these sections:

```markdown
# 选择值得创作的内容

## 完成后你将得到什么
## 开始前的准备
## 阅读发布记录
## 判断是否值得创作
## 直接创建稿件
## 保存为写作线索
## 常见问题
## 下一步
```

Make “创建稿件” the recommended quick-start action. Explain “加为写作方案线索” as an alternative for material that should be saved but not immediately turned into a draft. Do not invent a scoring model unless current UI exposes one.

- [ ] **Step 4: Validate both documents**

Run:

```bash
git diff --check
for file in docs/user-guide/collect-content.md docs/user-guide/select-content.md; do
  test "$(rg -c '^# ' "$file")" -eq 1 || exit 1
done
rg -n "worker|SQLAlchemy|Redis|数据库表|/api/" docs/user-guide/collect-content.md docs/user-guide/select-content.md && exit 1 || true
```

Expected: both documents have one H1, no whitespace errors, and no internal implementation terms.

- [ ] **Step 5: Commit the collection and selection guides**

```bash
git add docs/user-guide/collect-content.md docs/user-guide/select-content.md
git commit -m "docs: explain content collection and selection"
```

---

### Task 3: Task Lifecycle and Troubleshooting Guides

**Files:**
- Create: `docs/user-guide/task-management.md`
- Create: `docs/user-guide/troubleshooting.md`

**Evidence:**
- `web/app/creation-rules/CreationRulesClient.tsx`
- `web/app/creation-rules/CreationRulesClient.test.tsx`
- `web/app/creation-rules/TaskLogList.tsx`
- `web/app/creation-rules/TaskLogList.test.tsx`
- `web/app/creation-rules/JobLogDialog.tsx`
- `web/app/creation-rules/JobLogDialog.test.tsx`
- `web/lib/api/creation-rules.ts`
- `web/lib/api/jobs.ts`
- `web/lib/ai/runtime-config.ts`

**Interfaces:**
- Consumes: `setup.md` for missing-configuration recovery.
- Produces: canonical state, retry, logging, and cross-feature recovery explanations linked by later chapters.

- [ ] **Step 1: Inventory current task labels and available actions**

Run:

```bash
rg -n "任务看板|全部任务|任务日志|等待|运行|成功|失败|取消|重试|查看" \
  web/app/creation-rules web/lib/api/creation-rules.ts web/lib/api/jobs.ts --glob '*.{ts,tsx}'
```

Expected: every state and action included in the guide maps to a visible label or current API state. Omit states that cannot be mapped to a user-visible outcome.

- [ ] **Step 2: Write `task-management.md`**

Use these sections:

```markdown
# 查看和管理创作任务

## 完成后你将得到什么
## 打开任务看板
## 理解任务状态
## 查看任务详情与日志
## 取消任务
## 安全地重试失败任务
## 常见问题
## 下一步
```

Include a compact state table with “你会看到什么” and “你可以做什么” columns. Warn that retrying may repeat model calls or external paid operations when delivery status is uncertain. Do not expose developer-only trace features as normal user requirements.

- [ ] **Step 3: Write `troubleshooting.md` as symptom-to-action guidance**

Use these sections:

```markdown
# 常见问题排查

## AI 模型未配置或不可用
## 信息源没有采集到内容
## 创作任务长时间没有完成
## 创作任务失败
## 没有找到生成的草稿
## 图片或素材不可用
## 发布账号不可选
## 仍然无法解决问题
```

For every symptom, provide: visible symptom, likely user-correctable cause, exact page to inspect, safe next action, and cases where the user should avoid repeated retries.

- [ ] **Step 4: Validate lifecycle and recovery language**

Run:

```bash
git diff --check
for file in docs/user-guide/task-management.md docs/user-guide/troubleshooting.md; do
  test "$(rg -c '^# ' "$file")" -eq 1 || exit 1
done
rg -n "TODO|TBD|待补充|稍后添加|占位" docs/user-guide/task-management.md docs/user-guide/troubleshooting.md && exit 1 || true
```

Expected: no formatting errors, one H1 per file, and no placeholder language.

- [ ] **Step 5: Commit task management and troubleshooting**

```bash
git add docs/user-guide/task-management.md docs/user-guide/troubleshooting.md
git commit -m "docs: add task and troubleshooting guidance"
```

---

### Task 4: Draft Creation and Publication-Readiness Guides

**Files:**
- Create: `docs/user-guide/create-draft.md`
- Create: `docs/user-guide/edit-and-prepare.md`

**Evidence:**
- `web/app/github/GithubClient.tsx`
- `web/components/features/CreateTaskDialog.tsx`
- `web/app/creation-rules/TaskLogList.tsx`
- `web/app/drafts/DraftsClient.tsx`
- `web/app/drafts/DraftsClient.test.tsx`
- `web/components/features/DraftAssetsDialog.tsx`
- `web/app/drafts/PublishDialog.tsx`
- `web/app/drafts/WechatPublishPanel.tsx`
- `web/app/drafts/XArticlePanel.tsx`
- `web/app/assets/AssetsClient.tsx`

**Interfaces:**
- Consumes: `setup.md`, `select-content.md`, `task-management.md`, and `troubleshooting.md`.
- Produces: the creation and editing targets used by the end-to-end quick start.

- [ ] **Step 1: Verify the release-to-task and draft-editing controls**

Run:

```bash
rg -n "创建稿件|创建创作任务|查看看板|草稿箱|保存|素材|发布|选择一篇草稿开始编辑" \
  web/app/github/GithubClient.tsx web/app/drafts web/components/features/DraftAssetsDialog.tsx --glob '*.{ts,tsx}'
```

Expected: all actions described in the guides exist in current visible UI or tests.

- [ ] **Step 2: Write `create-draft.md`**

Use these sections:

```markdown
# 创建并找到一篇草稿

## 完成后你将得到什么
## 开始前的准备
## 从 GitHub 发布记录创建稿件
## 选择发布账号和写作模板
## 在任务看板等待结果
## 在草稿箱找到结果
## 也可以手动发布创作任务
## 常见问题
## 下一步
```

The direct GitHub path is primary. The manual “发布创作任务” dialog is a secondary option. Clearly distinguish the action of creating a task from the later appearance of a draft.

- [ ] **Step 3: Write `edit-and-prepare.md`**

Use these sections:

```markdown
# 编辑草稿并完成发布前准备

## 完成后你将得到什么
## 打开并编辑草稿
## 保存修改
## 检查标题和正文
## 管理封面和正文图片
## 检查发布账号与目标平台
## 完成发布前检查
## 常见问题
## 下一步
```

Use a final checklist for title, factual accuracy, links, image rights, cover, account choice, and target-platform formatting. Explain that external publication is not required to complete this guide.

- [ ] **Step 4: Validate both core result documents**

Run:

```bash
git diff --check
for file in docs/user-guide/create-draft.md docs/user-guide/edit-and-prepare.md; do
  test "$(rg -c '^# ' "$file")" -eq 1 || exit 1
done
rg -n "worker|SQLAlchemy|Redis|数据库表|/api/" docs/user-guide/create-draft.md docs/user-guide/edit-and-prepare.md && exit 1 || true
```

Expected: clean Markdown, one H1 per file, and no implementation terminology.

- [ ] **Step 5: Commit the creation and editing guides**

```bash
git add docs/user-guide/create-draft.md docs/user-guide/edit-and-prepare.md
git commit -m "docs: guide users from task to ready draft"
```

---

### Task 5: End-to-End Quick Start

**Files:**
- Create: `docs/user-guide/quick-start.md`

**Evidence:**
- All evidence files from Tasks 1–4
- `web/components/features/Sidebar.tsx`
- `web/app/page.tsx`

**Interfaces:**
- Consumes: every core guide produced by Tasks 1–4.
- Produces: the single recommended onboarding path linked from both user-guide and repository entry points.

- [ ] **Step 1: Reconcile the full route against current navigation**

Run:

```bash
rg -n "今日工作台|任务看板|草稿箱|写作模板|GitHub|设置" \
  web/components/features/Sidebar.tsx web/app/settings/SettingsClient.tsx
```

Expected: every page name in the quick start matches current navigation.

- [ ] **Step 2: Write `quick-start.md` as one continuous scenario**

Use these sections:

```markdown
# 快速上手：从 GitHub 发布记录到可发布草稿

## 完成后你将得到什么
## 开始前的准备
## 1. 完成最低配置
## 2. 找到一条 GitHub 发布记录
## 3. 创建稿件
## 4. 在任务看板确认进度
## 5. 在草稿箱检查结果
## 6. 编辑并完成发布前检查
## 如果流程没有按预期进行
## 接下来可以做什么
```

Each numbered section must contain: exact navigation path, exact visible action, expected visible result, and a relative link to the detailed chapter. Do not introduce alternative sources, text video, or digital humans in the numbered flow.

- [ ] **Step 3: Validate all quick-start links**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -c 'from pathlib import Path; import re,sys; p=Path("docs/user-guide/quick-start.md"); bad=[]; text=p.read_text(); targets=re.findall(r"!?\[[^]]*\]\(([^)]+)\)", text); [bad.append(t) for t in targets if not t.startswith(("http://","https://","#","mailto:")) and not (p.parent/t.split("#",1)[0]).exists()]; print("\n".join(bad)); sys.exit(bool(bad))'
test "$(rg -c '^# ' docs/user-guide/quick-start.md)" -eq 1
git diff --check
```

Expected: no missing relative targets, one H1, and no whitespace errors.

- [ ] **Step 4: Commit the quick start**

```bash
git add docs/user-guide/quick-start.md
git commit -m "docs: add end-to-end quick start"
```

---

### Task 6: Advanced Text-Video and Digital-Human Guides

**Files:**
- Create: `docs/user-guide/text-video.md`
- Create: `docs/user-guide/digital-human.md`

**Evidence:**
- `README.md` sections “文字视频（当前里程碑）” and “数字人口播（HeyGen）”
- `web/app/text-video/TextVideoProjectsClient.tsx`
- `web/app/text-video/TextVideoWorkbench.tsx`
- `web/app/text-video/ScriptStage.tsx`
- `web/app/text-video/AudioStage.tsx`
- `web/app/text-video/VideoStage.tsx`
- `web/app/digital-humans/DigitalHumansClient.tsx`
- `web/app/digital-humans/RoleLibrary.tsx`
- `web/app/digital-humans/TalkingProjectList.tsx`
- `web/app/digital-humans/TalkingVideoEditor.tsx`
- `web/app/settings/sections/SpeechSection.tsx`
- `web/app/settings/sections/TranscriptionSection.tsx`
- `web/app/settings/sections/HeyGenSection.tsx`
- `web/app/settings/sections/ComfyUISection.tsx`

**Interfaces:**
- Consumes: `setup.md`, `task-management.md`, and `troubleshooting.md`.
- Produces: two independent advanced-topic documents linked from the user-guide index.

- [ ] **Step 1: Verify current milestone boundaries and visible stages**

Run:

```bash
rg -n "当前里程碑|不包含|文字视频|脚本|配音|画面|数字人口播|新建口播作品|生成新的口播版本" \
  README.md web/app/text-video web/app/digital-humans --glob '*.{md,ts,tsx}'
```

Expected: each documented stage and limitation is supported by current source. If README and UI disagree, report the mismatch before writing a claim.

- [ ] **Step 2: Write `text-video.md`**

Use these sections:

```markdown
# 制作文字视频

## 完成后你将得到什么
## 开始前的准备
## 创建文字视频项目
## 准备脚本
## 生成并确认配音
## 调整画面与时间轴
## 预览和导出
## 当前能力边界
## 常见问题
## 下一步
```

Document only the export behavior verified in the active UI. Preserve explicit warnings about paid provider retries and human confirmation stages where current behavior requires them.

- [ ] **Step 3: Write `digital-human.md`**

Use these sections:

```markdown
# 制作数字人口播

## 完成后你将得到什么
## 开始前的准备
## 创建数字人角色
## 创建口播作品
## 编写或转换口播脚本
## 选择环境并生成版本
## 查看和管理生成结果
## 当前能力边界
## 常见问题
## 下一步
```

Describe HeyGen or ComfyUI only where the active UI exposes the provider choice. State account-plan or paid-operation constraints without promising provider availability.

- [ ] **Step 4: Validate advanced guides**

Run:

```bash
git diff --check
for file in docs/user-guide/text-video.md docs/user-guide/digital-human.md; do
  test "$(rg -c '^# ' "$file")" -eq 1 || exit 1
done
rg -n "TODO|TBD|待补充|稍后添加|占位" docs/user-guide/text-video.md docs/user-guide/digital-human.md && exit 1 || true
```

Expected: one H1 per file, no formatting errors, and no placeholder language.

- [ ] **Step 5: Commit the advanced guides**

```bash
git add docs/user-guide/text-video.md docs/user-guide/digital-human.md
git commit -m "docs: add multimedia user guides"
```

---

### Task 7: Indexes, Optional Screenshots, and Final Verification

**Files:**
- Create: `docs/user-guide/README.md`
- Create if safely captured: `docs/user-guide/images/quick-start-settings.png`
- Create if safely captured: `docs/user-guide/images/quick-start-content-selection.png`
- Create if safely captured: `docs/user-guide/images/quick-start-creation-task.png`
- Create if safely captured: `docs/user-guide/images/quick-start-draft-editor.png`
- Modify: `docs/user-guide/quick-start.md`
- Modify: `README.md`
- Modify as needed for cross-links: `docs/user-guide/*.md`

**Evidence:**
- `docs/superpowers/specs/2026-08-20-user-guide-design.md`
- All completed files under `docs/user-guide/`
- A reachable local Ediora runtime, if screenshots are captured

**Interfaces:**
- Consumes: every document produced by Tasks 1–6.
- Produces: the final website-consumable Markdown tree and repository entry link.

- [ ] **Step 1: Write the user-guide index**

Use these sections:

```markdown
# Ediora 使用文档

## 第一次使用
## 核心创作流程
## 管理任务与排查问题
## 进阶创作
## 文档范围
```

Link every guide exactly once from the most appropriate section. Lead with `quick-start.md`; do not copy detailed procedures into the index.

- [ ] **Step 2: Normalize previous and next-step links**

Ensure each core-flow document ends with a “下一步” link following this route:

```text
setup.md
→ collect-content.md
→ select-content.md
→ create-draft.md
→ edit-and-prepare.md
```

Link task failures to `task-management.md` or `troubleshooting.md`. Link advanced topics from the index and from the final “下一步” section only; do not branch the numbered quick-start flow.

- [ ] **Step 3: Add the concise repository entry link**

Add a short “使用文档” subsection near the product introduction or before technical setup in root `README.md`. It must link to `docs/user-guide/README.md` and must not duplicate the guide contents.

- [ ] **Step 4: Check whether safe screenshots can be captured**

Run:

```bash
./dev.sh status
```

Expected decision:

- If Web and API are reachable with non-sensitive demonstration data, capture only the four named key screens, crop to the relevant UI area, verify no secrets or private content are visible, save the PNG files under `docs/user-guide/images/`, and add descriptive image references to `quick-start.md`.
- If the runtime is unavailable or only contains sensitive data, do not create the image directory and do not add image references. Record this limitation in the final handoff; the text guide remains complete.

- [ ] **Step 5: Validate every relative link and image reference**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -c 'from pathlib import Path; import re,sys; root=Path("docs/user-guide"); bad=[]; files=list(root.glob("*.md")); [(bad.append(f"{p}:{t}")) for p in files for t in re.findall(r"!?\[[^]]*\]\(([^)]+)\)", p.read_text()) if not t.startswith(("http://","https://","#","mailto:")) and not (p.parent/t.split("#",1)[0]).exists()]; print("\n".join(bad)); sys.exit(bool(bad))'
```

Expected: exit code 0 with no missing targets.

- [ ] **Step 6: Validate headings, placeholders, terminology, and formatting**

Run:

```bash
for file in docs/user-guide/*.md; do
  test "$(rg -c '^# ' "$file")" -eq 1 || exit 1
done
rg -n "TODO|TBD|待补充|稍后添加|占位" docs/user-guide && exit 1 || true
rg -n "worker|SQLAlchemy|Redis|数据库表|/api/" docs/user-guide && exit 1 || true
git diff --check
```

Expected: one H1 per guide, no placeholders, no internal implementation terms, and no whitespace errors.

- [ ] **Step 7: Review the end-to-end flow against the UI**

Manually verify this exact chain against current source and, when available, the live UI:

```text
设置 → AI 大模型
设置 → 发布账号
写作模板
GitHub → 发布记录 → 创建稿件
任务看板
草稿箱
```

Expected: navigation names, button names, required choices, task result, and draft location all match. Correct documentation discrepancies before committing.

- [ ] **Step 8: Commit the complete user-guide integration**

```bash
git add README.md docs/user-guide
git commit -m "docs: complete user guide navigation"
```

- [ ] **Step 9: Confirm the branch is clean and summarize verification**

Run:

```bash
git status --short
git log --oneline --max-count=8
```

Expected: clean status and a sequence of focused documentation commits after the design and plan commits.
