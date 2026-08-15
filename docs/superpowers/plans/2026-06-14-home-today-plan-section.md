# 首页「今日计划」区（P1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在首页只读展示今日计划（DailyPlan）的选题条目，点击跳到 `/daily-plan` 操作，让首页重新回答「今天写什么」。

**Architecture:** 新增 `TodayPlan` dashboard 区块组件（镜像现有 `ReleasesToday`），把现成的 `getTodayPlan()` 并进 `app/page.tsx` 的服务端数据获取，渲染在 AlertsBar 之后、ReleasesToday 之前。零后端改动、零新接口。

**Tech Stack:** Next.js App Router（前端目录 `web/`，pnpm）、Tailwind、lucide-react。无前端单测框架——自动化验证用 `pnpm exec tsc --noEmit`，再手动冒烟。

**约定：** Bash 先 `source ~/.zshrc`；前端命令在 `web/` 下用 `pnpm`。设计见 `docs/superpowers/specs/2026-06-14-home-today-plan-section-design.md`。⚠️ 本项目 Next.js 为非标准 pin 版——镜像现有页面/组件写法，别自创模式。

---

## File Structure

- `web/components/features/dashboard/TodayPlan.tsx` — 新建。今日计划只读区块（header + 列表/空卡）。Props `{ plan: DailyPlan | null }`。
- `web/app/page.tsx` — 修改。并入 `getTodayPlan()`、渲染 `<TodayPlan>`。

依赖（均已存在，勿改）：`lib/api/daily-plan.ts`（`getTodayPlan`、`DailyPlan`、`DailyPlanItem` 类型）、`components/features/dashboard/ReleasesToday.tsx`（镜像样式参照）。

---

## Task 1: TodayPlan 区块组件

**Files:**
- Create: `web/components/features/dashboard/TodayPlan.tsx`

- [ ] **Step 1: 创建组件**

新建 `web/components/features/dashboard/TodayPlan.tsx`：

```tsx
import Link from 'next/link'
import { CalendarCheck, ArrowRight } from 'lucide-react'
import type { DailyPlan, DailyPlanItem } from '@/lib/api/daily-plan'

const CONTENT_TYPE_LABEL: Record<DailyPlanItem['content_type'], string> = {
  long: '长文',
  short: '短文',
  story: '故事',
  share: '分享',
}

const STATUS_META: Record<DailyPlanItem['status'], { label: string; className: string }> = {
  suggested: { label: '待入队', className: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' },
  enqueued: { label: '已入队', className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400' },
  skipped: { label: '已跳过', className: 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500' },
}

const STATUS_ORDER: Record<DailyPlanItem['status'], number> = { suggested: 0, enqueued: 1, skipped: 2 }

export function TodayPlan({ plan }: { plan: DailyPlan | null }) {
  const items = plan
    ? [...plan.items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    : []

  return (
    <section className="mb-8">
      <div className="flex items-center gap-2 mb-3">
        <CalendarCheck className="w-4 h-4 text-indigo-500" />
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">今日计划</h2>
        <Link href="/daily-plan" className="ml-auto flex items-center gap-1 text-xs text-indigo-500 hover:text-indigo-600">
          去今日计划 <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
      {items.length === 0 ? (
        <Link
          href="/daily-plan"
          className="block bg-zinc-50 dark:bg-zinc-900/50 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl p-4 text-center text-zinc-400 text-xs hover:border-indigo-300"
        >
          今日计划尚未生成 · 去生成
        </Link>
      ) : (
        <div className="space-y-2">
          {items.map(item => {
            const status = STATUS_META[item.status]
            return (
              <div
                key={item.id}
                className="flex items-center gap-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm font-medium truncate ${
                      item.status === 'skipped'
                        ? 'line-through text-zinc-400'
                        : 'text-zinc-900 dark:text-zinc-100'
                    }`}
                  >
                    {item.title}
                  </p>
                  <p className="text-xs text-zinc-400 truncate mt-0.5">{item.account_name}</p>
                </div>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400 shrink-0">
                  {CONTENT_TYPE_LABEL[item.content_type]}
                </span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${status.className}`}>
                  {status.label}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `source ~/.zshrc; cd /workspace/projects/WeMediaStudio/web && pnpm exec tsc --noEmit`
Expected: 无 TypeScript 错误输出（忽略 zsh glob 噪音）。组件自洽（只依赖已存在的 `daily-plan.ts` 类型），即使尚未被引用也应通过。

- [ ] **Step 3: Commit**

```bash
cd /workspace/projects/WeMediaStudio && git add web/components/features/dashboard/TodayPlan.tsx && git commit -m "feat(home-today-plan): TodayPlan 今日计划区块组件"
```

---

## Task 2: 接入首页 page.tsx

**Files:**
- Modify: `web/app/page.tsx`

- [ ] **Step 1: 替换 page.tsx**

把 `web/app/page.tsx` 整文件替换为（并入 `getTodayPlan`，渲染 `<TodayPlan>` 在 AlertsBar 后、ReleasesToday 前；注意计划结果命名 `todayPlanResp`，避免与已有日期变量 `today` 冲突）：

```tsx
import { getDashboardOverview, EMPTY_OVERVIEW } from '@/lib/api/dashboard'
import { getTodayPlan } from '@/lib/api/daily-plan'
import { CreateTaskButton } from '@/components/features/CreateTaskDialog'
import { AlertsBar } from '@/components/features/dashboard/AlertsBar'
import { TodayPlan } from '@/components/features/dashboard/TodayPlan'
import { ReleasesToday } from '@/components/features/dashboard/ReleasesToday'
import { SourceStatusGrid } from '@/components/features/dashboard/SourceStatusGrid'

export const dynamic = 'force-dynamic'

export default async function Dashboard() {
  const [overview, todayPlanResp] = await Promise.all([
    getDashboardOverview().catch(() => EMPTY_OVERVIEW),
    getTodayPlan().catch(() => ({ plan: null })),
  ])

  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })

  return (
    <div className="px-8 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <p className="text-xs text-zinc-400 mb-1">{today}</p>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">今日工作台</h1>
          <p className="text-sm text-zinc-500 mt-1">
            今日 +{overview.today_output.topics} 选题 / +{overview.today_output.drafts} 草稿
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CreateTaskButton />
        </div>
      </div>

      <AlertsBar alerts={overview.alerts} />

      <TodayPlan plan={todayPlanResp.plan} />

      <ReleasesToday releases={overview.releases_today} />

      <SourceStatusGrid sources={overview.sources} />
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `source ~/.zshrc; cd /workspace/projects/WeMediaStudio/web && pnpm exec tsc --noEmit`
Expected: 无 TypeScript 错误输出。

- [ ] **Step 3: Commit**

```bash
cd /workspace/projects/WeMediaStudio && git add web/app/page.tsx && git commit -m "feat(home-today-plan): 首页接入今日计划区"
```

---

## 收尾验证

- [ ] **类型检查**：`source ~/.zshrc; cd /workspace/projects/WeMediaStudio/web && pnpm exec tsc --noEmit` → 零错误。
- [ ] **手动冒烟**：起前后端，访问首页 `/`：
  - 当天已有计划（多条不同状态）→ 「今日计划」区在「今日可写 GitHub」上方，条目按 待入队→已入队→已跳过 排序，体裁/状态徽标正确，已跳过项标题带删除线；点 header「去今日计划」跳 `/daily-plan`。
  - 当天无计划（plan=null，可临时停掉 8 点 cron 或新库）→ 显示虚线空卡「今日计划尚未生成 · 去生成」，点击跳 `/daily-plan`。

---

## Self-Review（已核对）

- **Spec 覆盖**：只读展示(Task1+2) / 跳转 `/daily-plan`(Task1 header+空卡) / 位置 AlertsBar 后 ReleasesToday 前(Task2) / 排序 suggested→enqueued→skipped(Task1 STATUS_ORDER) / 体裁+状态徽标(Task1) / 空状态 plan null 或 0 条(Task1 `items.length===0`) / 容错 `.catch(()=>({plan:null}))`(Task2) —— spec 各点均有对应。非目标（内联操作/分页/深链/后端改动）均未触碰。
- **占位符**：无 TBD/TODO；两个代码步均为完整文件内容 + 确切命令。
- **类型一致**：`TodayPlan` props `{ plan: DailyPlan | null }`（Task1）↔ Task2 传 `todayPlanResp.plan`（`getTodayPlan` 返回 `{ plan: DailyPlan | null }`）；`DailyPlanItem` 的 `content_type`/`status`/`title`/`account_name`/`id` 均为该类型现有字段；组件名 `TodayPlan` 在两任务一致；变量名 `todayPlanResp` 避开既有 `today`。
- **风险**：`getTodayPlan` 失败回退 `{plan:null}` 与 `getDashboardOverview` 同样容错，首页不会因计划接口挂掉而白屏。
