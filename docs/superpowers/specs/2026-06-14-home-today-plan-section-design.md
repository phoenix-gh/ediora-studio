# 设计：首页「今日计划」区（P1）

日期：2026-06-14
状态：设计已确认，待写实现计划
关联：闭环审计 `docs/superpowers/specs/2026-06-14-cleanup-and-creation-loop-audit.md`（P1：首页失去「今天写什么」入口）

## 背景与目标

旧链路下线后删掉了首页坏掉的「系统推荐选题」段，首页现在只剩 提醒 / 今日 Release / 采集网格，没有「今天写什么」的入口。每日计划（wms_scout 8 点总编产出）是现役的「今天写什么」，数据已有但只在 `/daily-plan` 页可见。

**目标**：在首页只读展示今日计划的选题条目，点击跳到 `/daily-plan` 操作。让首页重新回答「今天写什么」。

**成功标准**：当天有计划时，首页能看到各条选题（标题/账号/体裁/状态）；无计划时给出去生成的入口。

## 非目标

- 首页内联操作（入队/跳过/重生成）——都留在 `/daily-plan` 页。
- 分页、深链到单条、行内编辑。
- 任何后端改动 / 新接口（复用现成 `getTodayPlan`）。

## 架构

- 新增组件 `wemedia-studio/components/features/dashboard/TodayPlan.tsx`，镜像现有 `ReleasesToday.tsx` 的结构与样式（section + header + 列表/空卡）。
- `wemedia-studio/app/page.tsx`：把 `getTodayPlan()` 并进现有 `Promise.all`，渲染 `<TodayPlan plan={...} />`，**位置在 `<AlertsBar>` 之后、`<ReleasesToday>` 之前**。

## 组件 `TodayPlan`

Props：`{ plan: DailyPlan | null }`（类型来自 `lib/api/daily-plan.ts`，含 `items: DailyPlanItem[]`）。

Header：`📋 今日计划` + 右侧链接「去今日计划 →」指向 `/daily-plan`。

Body：
- `plan === null` 或 `plan.items.length === 0` → 虚线空卡：「今日计划尚未生成 · 去生成」，整卡链到 `/daily-plan`。
- 否则列出 `plan.items`，**按状态排序：suggested 在前，enqueued 次之，skipped 最后**。每行：
  - 标题 `item.title`（截断单行）
  - `item.account_name`
  - 体裁徽标：`content_type` 映射 long→长文 / short→短文 / story→故事 / share→分享
  - 状态徽标：`suggested`→「待入队」(zinc) / `enqueued`→「已入队」(emerald) / `skipped`→「已跳过」(灰 + 标题加删除线)

## 数据流

`page.tsx`（服务端组件）：
```
const [overview, today] = await Promise.all([
  getDashboardOverview().catch(() => EMPTY_OVERVIEW),
  getTodayPlan().catch(() => ({ plan: null })),
])
```
`<TodayPlan plan={today.plan} />`。`getTodayPlan` 已存在（`/daily-plan/today` → `{ plan }`）。

## 错误处理

- `getTodayPlan` 失败 → `.catch(() => ({ plan: null }))` → 渲染空卡，不拖垮首页（与 `getDashboardOverview` 同样的容错）。

## 测试

前端无单测框架（沿用 publish-feedback 前端任务的惯例）：
- `pnpm exec tsc --noEmit` 零错误。
- 手动冒烟：有计划（多条不同状态，排序/徽标正确）、无计划（plan=null 显示空卡 + 链接）两态。

## 影响的文件

- 新增：`wemedia-studio/components/features/dashboard/TodayPlan.tsx`
- 修改：`wemedia-studio/app/page.tsx`（import + Promise.all + 渲染）
