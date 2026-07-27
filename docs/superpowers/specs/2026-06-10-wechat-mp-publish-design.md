# 草稿页「发布到公众号」设计

日期：2026-06-10
状态：已确认

## 背景与目标

草稿页（`app/drafts/`）目前只能编辑 markdown，发布到微信公众号需要手动搬运排版。本功能让用户在草稿页内完成：md 渲染（多种公众号排版主题可选）→ 手机宽度预览 → 一键存入公众号草稿箱。群发仍由用户在公众号后台确认，本系统不做直接群发。

已确认的三个关键决策：

1. **发布通道**：微信官方 API（appid + appsecret）→ 草稿箱（`draft/add`）。要求运行后端的机器出口 IP 加入公众号后台 IP 白名单。
2. **凭证存放**：扩展现有 `publish_accounts` 表，支持多公众号。
3. **渲染层**：前端嵌入 [@wenyan-md/core](https://github.com/caol64/wenyan-core)（Apache-2.0），浏览器端渲染，所见即所发；后端只负责图片上传与草稿创建。

## 功能范围

- 草稿编辑页工具栏新增「发布」按钮 → 打开发布对话框
- 对话框左侧：iframe 手机宽度（~375px）实时预览渲染结果
- 对话框右侧：账号选择、主题选择、封面选择、摘要编辑、「复制 HTML」与「存入草稿箱」按钮
- 「复制 HTML」复制带内联样式的 HTML，可手动粘贴到公众号编辑器（兜底路径）

不做：直接群发（freepublish）、发布记录表、自定义主题编辑器、非 wechat 平台发布。

## 架构

```
前端 (Next.js)                          后端 (FastAPI)                微信
┌──────────────────────┐    ┌──────────────────────┐
│ WechatPublishDialog   │    │ POST /drafts/{id}/    │
│  @wenyan-md/core 渲染 │───▶│   publish/wechat      │
│  md → 内联样式 HTML   │    │  1. 取账号凭证        │──▶ token
│  iframe 预览          │    │  2. 提取 <img> 上传   │──▶ uploadimg
│  主题/账号/封面/摘要  │    │     替换为 mmbiz URL  │
│                       │    │  3. 封面 add_material │──▶ thumb_media_id
│                       │    │  4. draft/add         │──▶ 草稿箱
└──────────────────────┘    └──────────────────────┘
```

## 数据模型

`publish_accounts` 表新增两列：

```sql
ALTER TABLE publish_accounts ADD COLUMN app_id VARCHAR DEFAULT '' NOT NULL;
ALTER TABLE publish_accounts ADD COLUMN app_secret VARCHAR DEFAULT '' NOT NULL;
```

项目无迁移框架，`create_all` 不会改已有表——**线上 Postgres 须手动执行上述 ALTER**。

`models.py` 的 `PublishAccount` 加 `app_id: Mapped[str]`、`app_secret: Mapped[str]`（default ""）；`schemas.py` 对应的 Create/Update/Out 模型同步加字段。

## 后端

### 新模块 `backend/wechat_api_client.py`

官方 api.weixin.qq.com 封装（与网页版 `wechat_mp_client.py` 分开，互不依赖）：

- `get_access_token(app_id, app_secret) -> str`：`GET /cgi-bin/token`，按 app_id 内存缓存，过期前 5 分钟视为失效自动重取
- `upload_content_image(token, data: bytes, filename) -> str`：`POST /cgi-bin/media/uploadimg`，返回 mmbiz.qpic.cn URL；仅支持 jpg/png 且 <1MB
- `add_thumb_material(token, data: bytes, filename) -> str`：`POST /cgi-bin/material/add_material?type=image`，返回 `media_id`
- `add_draft(token, article: dict) -> str`：`POST /cgi-bin/draft/add`，article 含 title / digest / content / thumb_media_id 等，返回 media_id
- 统一错误处理：微信 `errcode != 0` 抛 `WechatApiError(errcode, errmsg)`；40164（IP 不在白名单）给中文提示并透出微信返回中的出口 IP；40001/42001（token 失效）自动重取 token 重试一次

### 图片预处理（同模块内纯函数）

- `extract_image_srcs(html) -> list[str]`：提取所有 `<img src>`
- `prepare_image_bytes(data, mime) -> tuple[bytes, str]`：用 Pillow 把 webp/gif 等转 jpg；超 1MB 逐级降质/缩边直到达标
- 图片来源解析：src 含 `/api/uploads/` 或 `/uploads/` 的直接读后端 `uploads/` 目录；外链 http(s) 下载（httpx，超时 20s）

### 新端点（`routers/drafts.py`）

`POST /drafts/{draft_id}/publish/wechat`

请求体：

```json
{
  "account_id": "str",
  "title": "str (≤64，后端截断)",
  "digest": "str (≤120，后端截断)",
  "html": "渲染好的内联样式 HTML",
  "cover_image_id": 123
}
```

流程：账号存在且 app_id/app_secret 非空 → token → 逐张上传正文图片并替换 src → 封面（`DraftImage` 按 id 读 uploads 文件）→ `add_draft` → 返回 `{"media_id": "..."}`。

错误：404（草稿/账号/封面图不存在）、400（账号未配置凭证）、502（微信 API 错误，detail 带中文说明）。

## 前端

### 依赖

`pnpm add @wenyan-md/core`

### 新组件 `app/drafts/WechatPublishDialog.tsx`

- 初始化：`createWenyanCore({ isWechat: true })` + `registerAllBuiltInThemes()`；主题列表 `getAllGzhThemes()`
- 渲染管线：`renderMarkdown(content)` → 注入隐藏容器 → `applyStylesWithTheme(container, { themeId, hlThemeId })` → 内联样式 HTML
- 预览：iframe `srcDoc`，固定 375px 宽容器居中
- 账号下拉：`listPublishAccounts()` 过滤 `platform === 'wechat'` 且 `app_id` 非空
- 主题选择：radio 列表，选择记 localStorage（key `wms-wechat-theme`），切换即时重渲染
- 封面：从草稿组图片素材库选择，默认第一张；素材库为空时禁用「存入草稿箱」并提示先上传
- 摘要：textarea，默认取正文纯文本前 120 字，maxLength 120；标题默认草稿标题，maxLength 64
- 「复制 HTML」：`navigator.clipboard.write` 同时写 text/html 与 text/plain
- 「存入草稿箱」：调用 `publishDraftToWechat()`，成功 toast「已存入公众号草稿箱」，失败展示后端 detail

### 接线

- `DraftsClient.tsx` 工具栏加「发布」按钮（Send 图标），打开对话框，传当前 `editContent`、`editTitle`、草稿组图片列表
- `lib/api/drafts.ts` 加 `publishDraftToWechat(draftId, body)`
- `lib/api/publish-accounts.ts` 的 `PublishAccount` 接口加 `app_id` / `app_secret`
- Settings 页 `PublishAccountsSection.tsx` 加 AppID / AppSecret 输入框（secret 用 `type="password"`）

## 错误处理汇总

| 场景 | 行为 |
| --- | --- |
| 账号未配凭证 | 下拉中不显示；后端 400 兜底 |
| 素材库无封面图 | 发布按钮禁用 + 提示 |
| IP 不在白名单 (40164) | 透出微信返回的出口 IP，提示去公众号后台添加 |
| token 失效 (40001/42001) | 自动重取 token 重试一次 |
| 图片 >1MB 或非 jpg/png | Pillow 自动转码压缩 |
| 外链图片下载失败 | 502 + 指明哪个 URL 失败 |

## 测试

后端 pytest（mock httpx，不真调微信）：

- token 缓存：命中缓存不重复请求、过期自动重取、40001 重试
- `extract_image_srcs` / src 替换的纯函数行为
- `prepare_image_bytes`：大图压缩、webp 转 jpg
- publish 端点：happy path（mock 全链路）、404/400 错误分支

注意：main HEAD 已有 13 个既存失败测试（writing_plans/ref 相关），不计入本功能。

## 参考资源

- [caol64/wenyan-core](https://github.com/caol64/wenyan-core) — 渲染核心库（Apache-2.0）
- [caol64/wenyan-mcp](https://github.com/caol64/wenyan-mcp) — 官方 API 发布流程参考（图片上传 + draft_add + IP 白名单）
- [doocs/md](https://github.com/doocs/md) — 备选方案（完整 Vue 应用，未采用）
