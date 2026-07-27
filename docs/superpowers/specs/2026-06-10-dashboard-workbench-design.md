# 工作台 Dashboard — Design Spec

**Date:** 2026-06-10
**Status:** Approved（用户：先尝试一版）

## Overview

首页「今日工作台」从单一推荐选题页升级为运营驾驶舱，自上而下五个区块（其中推荐选题为现有区块）：

1. **提醒区** — 有事才出现的行动项（公众号凭证过期、采集失败、调度停摆、发布凭证缺失）
2. **今日可写 — GitHub 新发布** — 当天 Release 列表，关联已生成草稿或一键生成
3. **推荐选题** — 现有区块原样保留
4. **采集状态网格** — 每个数据源一张卡：状态点 + 最近运行时间 + 今日新增数
5. **今日产出小结** — 今日新增选题 / 新草稿 一行小数字

数据来源全部是现有表（`collect_logs`、各内容表、`github_releases`、`wechat_credentials`、`publish_accounts`）+ `backend/.scheduler_state.json`。**无表结构变更、无迁移。**

---

## 后端：新增 `routers/dashboard.py`

单一聚合端点，挂载到 `main.py`：

### `GET /api/dashboard/overview`

```jsonc
{
  "alerts": [
    { "severity": "error|warn|info", "text": "...", "action_label": "去扫码", "href": "/wechat" }
  ],
  "releases_today": [
    {
      "repo_id": "owner/repo", "tag_name": "v1.2.3", "name": "Release 1.2.3",
      "published_at": "...", "is_prerelease": false, "html_url": "...",
      "draft_ids": [12, 13]           // 关联 ArticleDraft（可为空数组）
    }
  ],
  "sources": [
    {
      "key": "github", "name": "GitHub", "href": "/github",
      "schedule": "1 分钟",            // 或 "手动"
      "last_status": "ok|warn|error|null",   // null = 无运行记录
      "last_message": "趋势 +3 Issues +5 ...",
      "last_run_at": "...|null",
      "today_new": 12
    }
  ],
  "today_output": { "topics": 3, "drafts": 2 },
  "generated_at": "..."
}
```

每个子区块独立 try/except：任何一块失败置空并继续，附加 `errors: ["sources: ..."]` 字段，绝不让整个端点 500。

### 计算规则

**「今日」口径**：Asia/Shanghai（UTC+8）当天 0 点，换算成 UTC 后与各表时间戳比较。服务端统一计算。

**最近运行时间合并**：部分任务"无新增且无错误"时不写日志（v2ex/juejin/36kr/wechat 等），所以
`last_run_at = max(该 job 最新 collect_logs 时间, .scheduler_state.json 对应 key 时间)`。
若 state 时间比最新日志新（>60s），说明静默成功 → `last_status = "ok"`、`last_message = "运行正常（最近无新增）"`。

job key ↔ state key ↔ 内容表（今日新增 count 字段默认 `collected_at`）：

| key | 名称 | state key | 今日新增表 | href |
|---|---|---|---|---|
| collect | 订阅账号 | —（每次必写日志） | Post | /settings |
| analyze | 选题分析 | — | Topic（`created_at`） | /trend-topics |
| github | GitHub | — | GithubRelease + GithubIssue | /github |
| x | X | x_collect | XPost | /x |
| wechat | 公众号 | wechat | WechatArticle | /wechat |
| reddit | Reddit | reddit | RedditPost | /reddit |
| juejin | 掘金 | juejin | JuejinArticle | /juejin |
| 36kr | 36 氪 | kr | KrArticle | /kr |
| v2ex | V2EX | v2ex | V2exTopic | /v2ex |
| papers | 论文 | papers | Paper | /papers |
| materials | 参考文案 | ref_collect | RefMaterial（`created_at`） | /materials |
| producthunt | Product Hunt | 手动 | ProductHuntPost | /producthunt |
| youtube | YouTube | 手动 | YoutubeVideo | /youtube |

手动源（producthunt/youtube）：`schedule = "手动"`，`last_run_at` 取该表最新一条 `collected_at`，无状态点颜色逻辑（有记录即灰绿）。

最新日志按 job 分组：collect_logs 上限 500 行，一次取回按 job 取每组第一条即可。

### 提醒规则（按序评估，全部命中可叠加）

1. **公众平台凭证**（`wechat_credentials` 单行）：
   - 无凭证 / 无 token / 无 cookie → info「未登录公众平台，公众号内容不会自动采集」→ /wechat
   - `expires_at <= now` → warn「公众平台登录已过期，公众号内容今天没有刷新——去重新扫码」→ /wechat
2. **今日公众号未刷新**：凭证有效、存在未静音 `WechatAccount`、且 `max(WechatArticle.collected_at) < 今日 0 点` → info「今日公众号内容尚未刷新」→ /wechat
3. **采集失败**：任一 job 的**最新**一条日志 `status == "error"` → error「「{名称}」采集最近一次运行失败：{message}」→ /settings（日志在设置页）。扫描所有 job key（含 x_reply 等非内容源）。
4. **调度停摆**：定时源 `now - last_run_at > max(2×配置间隔, 30 分钟)` → warn「「{名称}」已 {N} 分钟未运行，调度可能停了」。从未运行过的源不报（新装机）。间隔读 config：collect/github/x/v2ex/kr/juejin/wechat/reddit/ref 的 `*_interval_minutes`、papers 的 `arxiv_collect_interval_hours`。
5. **发布凭证缺失**：存在 `is_active` 且 `platform == "wechat"` 的 `PublishAccount` 缺 `app_id` 或 `app_secret` → info「公众号发布凭证未配置，无法推送草稿箱」→ /settings

### 今日 Release

`GithubRelease.published_at >= 今日 0 点`，按时间倒序。每条查 `ArticleDraft.topic_id == "release:{repo_id}:{tag_name}"` 拿 `draft_ids`。

---

## 前端

### `lib/api/dashboard.ts`

`getDashboardOverview()`，沿用 `client.ts` 既有封装与命名。

### `app/page.tsx`（server component，保持 force-dynamic）

`Promise.all` 取 overview + 推荐选题，各自 `.catch()` 容错。区块顺序：提醒区 → 今日可写 → 推荐选题（现有代码不动）→ 采集状态网格 → 今日产出脚注行。

### 新组件（`components/features/dashboard/`）

- `AlertsBar.tsx`（server）— severity 着色（红/琥珀/蓝），每条带跳转
- `ReleasesToday.tsx`（server）+ `GenerateDraftButton.tsx`（client）— 有草稿显示「查看草稿 → /drafts」，无草稿按钮调 `POST /api/github/releases/{owner}/{repo}/{tag}/generate-draft`，成功后 `router.refresh()`，toast 用 sonner
- `SourceStatusGrid.tsx`（server）— 状态点（绿 ok/黄 warn/红 error/灰无记录）、相对时间（"12 分钟前"）、今日 +N、整卡可点跳转

样式沿用现首页 zinc 色系 + 圆角卡片风格；遵守仓库 AGENTS.md：写前端代码前先读 `node_modules/next/dist/docs/` 相关文档。

---

## 测试

`backend/tests/test_dashboard.py`（沿用现有 test 基建）：

- 今日边界：UTC+8 昨天 23:59 的记录不计入，00:01 计入
- 静默成功：state 时间新于最新日志 → status ok
- 提醒触发：凭证过期 / 最新日志 error / 调度停摆（mock 时间）/ 发布凭证缺失，各一条正反用例
- Release 草稿关联：有无 ArticleDraft 时 draft_ids 的值
- 子区块异常隔离：某表查询抛错时端点仍 200 且其余区块有数据

前端无既有测试基建，不新增。

## Out of Scope

- 今日 Trending 上榜数（`github_trending` 表无时间戳列，做不了）
- 采集历史趋势图（collect_logs 仅留 500 条）
- 前端自动轮询刷新（v1 进页面取一次）
- 推荐选题区块的任何改动
