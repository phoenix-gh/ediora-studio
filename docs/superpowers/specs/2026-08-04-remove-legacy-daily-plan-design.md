# Remove Legacy Daily Plan Design

## Goal

Remove the legacy "今日计划" editorial-planning product completely. Preserve scheduled and one-time creation rules, their execution history, and their draft-output workflow as the independent "今日创作任务" product.

## Scope

The removed legacy planner includes:

- The `/daily-plan` page's plan display, manual generation, suggested-item selection, skip and enqueue controls.
- The sidebar and dashboard presentation of the legacy plan and planner alerts.
- The 08:00 `daily_plan` scheduler job and `create_today_plan` workflow.
- `DailyPlan` and `DailyPlanItem`, their router/API endpoints, `daily_plan` content-job flow, and legacy MCP planner tools.
- Publish-account `daily_quota`, which only configures legacy planner participation.

The retained daily-creation product includes:

- `DailyCreationRule` and `DailyCreationRun` storage, schedule dispatch, rule dialog, execution history, agent job, and draft delivery mode.
- The existing creation-rule APIs and their worker dispatch.
- Independent navigation and page presentation under a creation-oriented route/name.

## User Interface

Replace the old `/daily-plan` product route with a dedicated creation-task page that presents only:

- "今日创作任务" execution history.
- "创作规则" with create, edit, enable/disable, run-now, and deletion controls.

The page contains no plan generation, plan date/status, suggested topics, account-grouped plan items, or "加入今日计划" delivery option. Creation rules deliver generated output directly to drafts; legacy `plan_items` delivery mode is removed from the form and rejected by the API.

The sidebar link and dashboard surface use the creation-task name and route. There is no remaining navigation to `/daily-plan`.

## Data and Migration

Database initialization drops `daily_plan_items` before `daily_plans` and removes their ORM models. Existing legacy plan records are intentionally deleted because the product is being retired.

Creation-rule records using legacy `delivery_mode = "plan_items"` are migrated to `"drafts"` during initialization before validation or scheduling. Their schedules, prompts, skills, directories, and histories are retained. New API input accepts only `delivery_mode = "drafts"`.

`daily_quota` is removed from publish-account persistence, schemas, APIs, and settings UI. Existing values are discarded.

## Architecture

Remove planner-specific code instead of leaving dormant routes or worker branches. The remaining creation stack continues to call `dispatch_due_creation_rules`; it must not import `DailyPlan`, `DailyPlanItem`, or planner helpers.

The frontend separates the retained creation panels from the former composite client. The new page fetches only creation rules, runs, creative-asset directories, chat skills, and publishing accounts required by the rule editor. Legacy API client exports and tests are deleted or replaced with focused creation-rule coverage.

## Error Handling

- A migrated legacy rule is safely delivered to drafts rather than failing on the removed plan table.
- A request containing `delivery_mode = "plan_items"` receives a validation failure and creates no run.
- Removed legacy endpoints and `/daily-plan` return 404.
- Retained creation-rule listing, rule execution, and scheduler dispatch continue to work when no legacy tables exist.

## Testing

Tests must cover:

- Fresh and existing SQLite initialization drops legacy plan tables and migrates legacy creation-rule delivery mode to `drafts`.
- Legacy `/api/daily-plan` endpoints, the `/daily-plan` frontend route, and planner scheduler registration are absent/404.
- Creation-rule APIs reject `plan_items`, and migrated rules create draft outputs.
- The creation-task UI renders runs and rules without any legacy-plan controls or text.
- Publish-account API/settings no longer expose `daily_quota`.
- Existing creation-rule scheduler and agent-job tests remain green.

## Non-Goals

- Preserve or export legacy plan records.
- Replace legacy plan-item delivery with another queue abstraction.
- Change the creation-agent generation contract beyond its output destination migration.
