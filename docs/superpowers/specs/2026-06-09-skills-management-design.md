# Skills Management — Design Spec

**Date:** 2026-06-09  
**Status:** Approved

---

## Goal

WeMedia Studio 的 Hermes agent 技能由项目统一维护，通过 Profile 管理页面按需分配给各 agent。技能文件版本化在项目 Git 中，安装为 symlink，修改立即生效。

---

## Directory Structure

### 项目侧（source of truth）

```
WeMediaStudio/skills/
  article-drafting/
    SKILL.md
    references/          # 现有子目录保留
  content-ideation/
    SKILL.md
  x-post/
    SKILL.md
  cover-image/
    SKILL.md
  codex_imagegen/
    SKILL.md
```

现有 `~/.hermes/skills/custom/` 里的 5 个技能迁移至此目录。

### Hermes 侧（安装后）

Per-profile 安装目标：
```
~/.hermes/profiles/{profile}/skills/wemedia/
  article-drafting  →  symlink → WeMediaStudio/skills/article-drafting/
  content-ideation  →  symlink → WeMediaStudio/skills/content-ideation/
```

`wemedia/` 子目录作为命名空间，将项目技能与 profile 内其他技能隔离。

安装状态判断：检查 `~/.hermes/profiles/{profile}/skills/wemedia/{skill-name}` 是否是指向正确项目路径的 symlink。

> **注**：全局分类 `~/.hermes/skills/wems/` 不在本次范围内，第一版仅做 per-profile 安装。

---

## Backend API

### 新增 `backend/routers/skills.py`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/skills/` | 列出所有可用项目技能（扫描 `WeMediaStudio/skills/`，解析 SKILL.md frontmatter） |

响应结构：
```json
[
  {
    "name": "article-drafting",
    "description": "从素材到初稿的文章写作",
    "version": "1.0.0",
    "tags": ["content-creation", "drafting"]
  }
]
```

### 扩展 `backend/routers/profiles.py`

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/profiles/{name}/project-skills` | 返回全部可用技能 + 该 Profile 的安装状态 |
| `POST` | `/profiles/{name}/project-skills/{skill}` | 安装技能（在 profile skills 目录创建 symlink） |
| `DELETE` | `/profiles/{name}/project-skills/{skill}` | 卸载技能（删除 symlink） |

**安装逻辑：**
1. 确认 `WeMediaStudio/skills/{skill}/` 存在
2. 确认 `~/.hermes/profiles/{profile}/skills/wemedia/` 目录存在（不存在则创建）
3. `ln -s <project_skills_dir>/{skill} <profile_skills_dir>/wemedia/{skill}`
4. 目标已存在但不是正确 symlink → 报错，不覆盖

**卸载逻辑：**
1. 检查路径是 symlink
2. `os.unlink(target)`
3. 不是 symlink → 报错，不删除普通文件/目录

`GET /profiles/{name}/project-skills` 响应结构（合并可用技能 + 安装状态）：
```json
[
  {
    "name": "article-drafting",
    "description": "从素材到初稿的文章写作",
    "version": "1.0.0",
    "tags": ["content-creation", "drafting"],
    "installed": true
  },
  {
    "name": "x-post",
    "description": "推文写作",
    "version": "1.0.0",
    "tags": ["social-media"],
    "installed": false
  }
]
```

技能元数据解析：读取 `SKILL.md`，提取 `---` 之间的 YAML frontmatter（name、description、version、tags）。

---

## Frontend UI

在现有 **Profiles 页面**每个 Profile 的配置区域新增「项目技能」Section（不新建独立页面，不修改 Sidebar）。

### 交互设计

```
[Profile: wms_writer]

  SOUL  |  工具集  |  项目技能          ← 新增 section

  项目技能
  来自 WeMediaStudio/skills/

  ☑  article-drafting    从素材到初稿的文章写作
  ☑  content-ideation    从热点到选题的内容策划
  ☐  x-post              推文写作
  ☐  cover-image         封面图生成
  ☐  codex_imagegen      图片生成
```

- 勾选 → `POST /profiles/{name}/project-skills/{skill}`
- 取消勾选 → `DELETE /profiles/{name}/project-skills/{skill}`
- 乐观更新，失败时回滚 + toast 错误提示
- 无需「保存」按钮，即时生效

### 新增/修改文件

| 文件 | 操作 |
|------|------|
| `app/profiles/` 现有客户端组件 | 新增「项目技能」section |
| `lib/api/skills.ts` | 新建，封装 `/skills/` 和 `/profiles/{name}/project-skills` 调用 |
| `backend/routers/skills.py` | 新建 |
| `backend/routers/profiles.py` | 扩展新端点 |
| `backend/main.py` | 注册 skills router |

---

## Migration

将现有 `~/.hermes/skills/custom/` 中的 5 个技能文件复制到 `WeMediaStudio/skills/`：
- `article-drafting/`
- `content-ideation/`
- `x-post/`
- `cover-image/`
- `codex_imagegen/`

迁移后通过系统 UI 重新安装到各 Profile，原 `~/.hermes/skills/custom/` 中的条目可手动清理。

---

## Out of Scope

- 技能内容（SKILL.md 正文）的 UI 内编辑（后续迭代）
- 技能新建向导
- 技能使用统计展示
