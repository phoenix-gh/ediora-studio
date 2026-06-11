# 手动发布创作任务（工作台 / 工作室）设计

日期：2026-06-11
状态：已批准（方案 A）

## 需求

用户在工作台（首页）和工作室页面可以直接发布一个创作任务，主题内容由用户自己撰写：

- 输入形态：**主题想法 + 可选素材**——必填一个主题/标题，可再写一段想法、角度或粘贴参考素材。
- 流程：固定走 editor→writer→illustrator 完整链路；表单可选体裁（评论/教程/故事/测评，默认评论），复用现有 genre 规则块。
- 入口：工作室 header「发布任务」按钮（替换现有 toast stub）+ 工作台 header 新增「发布创作任务」按钮。看板列的「+ 新建任务」stub 不动。

## 方案选型

选 **A：新增 `manual_topic` 流程蓝图 + 独立接口**。

- B（改造现有 `/studio/enqueue`，source_url 可选）被否：两种语义挤一个接口和一份 editor 任务书，需加条件分支。
- C（把想法塞 summary 硬走 full 流程）被否：editor 任务书写的是「原始素材（用户从 UI 手动挑入）」，语义错位，且素材为空时 editor 不知道要去搜料。

## 后端

### pipeline_template.py

新增 `MANUAL_TOPIC_PIPELINE`，注册 flow `"manual_topic"`：

- **editor 棒**（新写）：任务书包含主题、用户想法/素材（可选块）、体裁约束（genre label + word_range）、账号画像（`render_profile_editor`）。指令：素材不足时用 web 工具搜集补料；抽具体锚点 ≥3；出 brief，格式与 full 流程一致（core_point / secondary_points / 必须出现的事实 / 候选锚点 / 候选标题 / 禁区提醒），完成时 `kanban_complete` 带 `brief_md` / `core_point` metadata。
- **writer / illustrator 棒**：直接引用 `FULL_PIPELINE[1]`、`FULL_PIPELINE[2]`（writer 棒已通过 `writer_rules_md(c)` 支持 ctx['genre']）。

### routers/studio.py

新增 `POST /studio/enqueue-manual`：

```
ManualEnqueueIn {
  account_id: str        # 必填
  title: str             # 必填，主题
  idea: str = ""         # 想法/角度/素材，可选
  genre: str = "commentary"  # commentary|tutorial|story|review
  note: str = ""
}
```

- 校验 account 存在、genre 合法（非法回退 commentary 或 400，取 400 明确报错）。
- 建 `PipelineTask`（source_url 留空），ctx 带 `genre`、`genre_label`、`idea`，按 `manual_topic` 蓝图循环建任务链（前棒为后棒 parent），回填 task_ids。
- 与 `/studio/enqueue` 共用的「账号画像构建 + PipelineTask 创建 + 任务链创建 + task_ids 回填」逻辑抽成共享 helper，两个接口都走它。

## 前端

- `lib/api/studio.ts`：新增 `ManualEnqueueIn` 类型 + `enqueueManualTask()`。
- 新组件 `components/features/CreateTaskDialog.tsx`（shadcn Dialog）：
  - 发布账号（必选，加载 `listPublishAccounts` 过滤 is_active，样式复用 PushToStudioPopover 的列表）
  - 主题（必填 Input）
  - 想法与素材（可选 Textarea，placeholder 说明可写角度/想法/粘贴参考素材）
  - 体裁（评论/教程/故事/测评 四选一，默认评论）
  - 备注（可选 Input）
  - 提交成功 toast + 关闭。
- 工作室 `StudioClient.tsx`：header「发布任务」按钮改为打开该弹窗。
- 工作台 `app/page.tsx`：header 在 GenerateButton 旁加 client 组件 `CreateTaskButton`，打开同一个弹窗。

## 测试

- `backend/tests/test_pipeline_template_manual.py`：manual_topic 蓝图渲染（步骤数/assignee、editor body 含主题/想法/体裁、writer/illustrator 复用 FULL_PIPELINE）。
- `backend/tests/test_studio_enqueue_manual.py`：接口测试，monkeypatch `_kanban_create`，断言任务链创建顺序、parent 链接、PipelineTask 落库与 task_ids 回填、非法 genre 400、缺账号 400。
- 前端跑 `pnpm build`（或 lint + tsc）验证。

## 错误处理

- hermes CLI 失败 → 503（沿用 `_kanban_create` 现有行为）。
- 账号不存在 / title 为空 → 400。
