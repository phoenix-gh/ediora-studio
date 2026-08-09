# Task schedule page

## Purpose

The `/creation-rules` page is a task-arrangement surface: it configures and
starts scheduled creation rules. It must not expose prior run logs, Agent audit
data, output details, or failure diagnostics; those remain on the separate
`/jobs` task panel.

## User experience

- Rename the sidebar entry from `今日创作任务` to `任务安排`.
- Keep the separate `创作任务` sidebar entry and its route unchanged.
- Remove the run-log panel from `/creation-rules`; only the rule list and rule
  editing controls remain.
- Each rule row displays its most recent execution time and its calculated next
  execution time.
- A rule with no run history shows `尚未执行` for its last execution.
- Disabled rules show `已停用` instead of a next execution time.
- A one-time rule whose scheduled instant has passed shows `无后续执行`.

## Data and time semantics

The creation-rule API returns two server-calculated, ISO 8601 UTC timestamps:
`last_run_at` and `next_run_at`. The server derives the latest run from the
durable `DailyCreationRun` records. It computes the next occurrence from the
rule's `execution_mode`, `scheduled_date`, `scheduled_time`, `timezone`, and
`enabled` state. Recurring rules use the next local calendar occurrence; a
once rule uses its configured local instant only while it remains in the
future. This avoids client clock and scheduler-process-state differences.

## Boundaries and verification

No task-log API or `/jobs` behavior is removed. Backend route tests cover each
time-state contract. Component tests cover the renamed page and rendered time
states. The existing localized time formatter is used for display.
