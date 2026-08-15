# Skill 管理设计

## 背景

当前 `web/skills/` 下的预制 Skill 由 Next.js 运行时扫描，聊天选择器和封面/配图自动流程直接读取 `SKILL.md`。系统没有持久化的启用状态，也没有用户上传或删除自定义 Skill 的入口。

## 目标

- 在“设置 → 技能管理”中展示所有可用 Skill。
- 允许启用或禁用任意 Skill。
- 禁用状态同时影响 AI 助手手动选择和封面/配图自动流程。
- 支持上传包含一个或多个 Skill 的 ZIP 包。
- 允许删除上传的自定义 Skill。
- 预制 Skill 可以禁用，但永远不能删除。
- ZIP 中的 Skill 名称与现有 Skill 重名时拒绝整个上传，不覆盖现有内容。

## 非目标

- 不把 Skill 指令内容迁移到 PostgreSQL。
- 不执行上传包中的脚本、二进制或安装钩子。
- 不新增用户、权限或多租户模型。
- 不改变现有 Skill 的提示词协议和 `SKILL.md` frontmatter 格式。

## 推荐架构

新增一个 Next.js 服务端 Skill 注册模块，作为唯一的读取和变更入口：

```text
设置页
  └─ Next API /api/skills
       └─ SkillRegistry
            ├─ 预制目录: web/skills/
            ├─ 自定义目录: web/.runtime/skills/
            └─ 状态文件: web/.runtime/skills-state.json
```

预制 Skill 通过代码随应用发布；上传 Skill 写入 `.runtime/skills/`。`.runtime/` 纳入现有忽略规则，避免用户 Skill、启用状态和临时文件进入 Git。状态文件只保存 Skill 名称、来源和 `enabled`，不存在记录的预制 Skill 默认启用，新上传 Skill 默认启用。

`discoverSkills()` 改为调用注册模块，只返回启用的 Skill；设置页使用注册模块的管理列表返回全部 Skill。这样手动选择、`selectedContext()` 和封面/配图加载会共享同一禁用边界。

## 注册表接口

服务端注册模块提供以下行为：

- `listSkills()`：返回全部 Skill 的管理信息：`name`、`description`、`version`、`source`（`builtin` 或 `uploaded`）、`enabled`。
- `listEnabledSkills()`：读取并解析启用 Skill 的完整指令，供现有 `discoverSkills()` 使用。
- `setSkillEnabled(name, enabled)`：更新状态文件；不存在 Skill 返回 404。
- `deleteUploadedSkill(name)`：仅允许删除 `source=uploaded` 的 Skill；预制 Skill 返回 409。
- `installSkillArchive(buffer)`：校验并安装 ZIP 中的全部 Skill，成功时一次性提交；任何一个 Skill 失败都回滚整个上传。

所有状态文件写入使用临时文件加 rename，避免进程中断产生半写文件。对并发操作使用进程内串行锁，确保上传、启用和删除不会互相覆盖状态。

## ZIP 格式与安全边界

上传接口接受 `multipart/form-data` 的 `file` 字段。ZIP 可采用以下结构：

- 根目录直接包含 `SKILL.md`，表示一个 Skill；
- 根目录包含一个或多个目录，每个目录直接包含 `SKILL.md`；
- 允许 ZIP 外包一层目录，但最终每个 Skill 必须能归属到一个独立目录。

每个 Skill 的名称从 `SKILL.md` frontmatter 的 `name` 读取，并必须满足现有 Skill 名称约束：非空、长度不超过 80，只允许字母、数字、`.`、`_` 和 `-`。`description` 与 `version` 缺失时使用空字符串，不改变现有解析规则。

上传校验必须：

- 拒绝绝对路径、`..` 路径、符号链接和目录逃逸；
- 拒绝没有 `SKILL.md` 或 frontmatter 没有 `name` 的目录；
- 拒绝包内重复名称；
- 拒绝与预制或已上传 Skill 重名；
- 限制压缩包大小、解压后总大小和文件数量；
- 只复制校验后的普通文件，不执行文件内容。

安装前在临时目录解压和校验，全部校验通过后再逐个 rename 到自定义 Skill 目录，并更新状态文件。失败时删除临时目录，不影响已有 Skill。

## HTTP API

新增 Next.js Route Handler：

- `GET /api/skills`：返回全部管理信息。
- `PATCH /api/skills/:name`：JSON `{ "enabled": boolean }`，返回更新后的管理信息。
- `POST /api/skills/upload`：接收 ZIP，成功返回新增 Skill 列表；校验失败返回 400，重名返回 409，超过限制返回 413。
- `DELETE /api/skills/:name`：删除自定义 Skill；预制 Skill 返回 409。

API 不返回完整指令文本，只返回元数据。现有聊天 Skill 接口继续返回启用 Skill，避免前端绕过管理状态。

## 设置页交互

在现有设置侧栏新增“技能管理”项：

- 列表卡片显示名称、描述、版本、来源标签和启用开关；
- 预制 Skill 显示“预制”标签，不显示删除按钮；
- 上传 Skill 显示“已上传”标签和删除按钮；
- 上传按钮接受 `.zip`，上传中禁用重复提交，完成后刷新列表；
- 删除前需要确认，成功后刷新列表；
- API 错误以内联错误提示呈现，不清空已有列表；
- 列表为空时显示明确的空状态，但预制 Skill 正常安装时不应为空。

禁用当前聊天已选 Skill 后，后续发送请求必须收到“Skill 不可用”提示并清除选择，而不是继续使用旧指令缓存。

## 测试策略

- 注册表单元测试：预制默认启用、状态持久化、上传 Skill 默认启用、启用/禁用边界、预制不可删除、自定义可删除。
- ZIP 安全测试：合法根目录/一层目录、多 Skill 上传、重名回滚、路径穿越、符号链接、无 frontmatter、大小限制。
- API Route 测试：列表、PATCH、上传成功/409/413、删除 204/预制 409。
- `discoverSkills` 回归测试：禁用 Skill 不再返回，启用后恢复；现有封面和配图 Skill 的规则加载仍通过。
- Settings UI 测试：展示来源、开关调用、上传成功刷新、预制不出现删除按钮、自定义删除确认。
- 最终运行现有 Python 测试、前端 Vitest、ESLint 和生产构建，并手动验证设置页上传/禁用/删除流程。

## 验收标准

1. 打开“设置 → 技能管理”能看到当前两个预制 Skill，均默认开启且没有删除按钮。
2. 关闭任一 Skill 后，它从 AI 助手选择器消失，自动流程加载同名 Skill 时被拒绝。
3. 上传一个合法 ZIP 后，Skill 出现在列表并默认开启；再次上传同名 ZIP 返回冲突且原 Skill 内容不变。
4. 自定义 Skill 可以关闭、重新开启和删除；预制 Skill 删除操作始终被拒绝。
5. 重启 Next.js 后，启用状态和上传 Skill 仍然存在。
6. 恶意路径、无效 Skill 和超限 ZIP 不会写入运行时 Skill 目录。
