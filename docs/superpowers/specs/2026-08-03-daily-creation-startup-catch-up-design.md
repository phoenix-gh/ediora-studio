# Daily Creation Startup Catch-Up Design

## Goal

When the API is stopped during a rule's scheduled time, create the most recent missed daily-creation run after the system starts again. Preserve schedule idempotency and avoid replaying every missed calendar day after a long shutdown.

## Product Behavior

- Automatic catch-up applies to enabled, non-deleted daily creation rules whenever scheduling is enabled.
- Each dispatch pass considers at most one scheduled occurrence per rule: the latest occurrence that is not later than the current time.
- For a recurring rule:
  - if today's scheduled local time has passed, today's occurrence is considered;
  - otherwise, yesterday's occurrence is considered.
- For a one-time rule, its configured date and time is considered after it becomes due, regardless of how long the system was offline.
- An occurrence that already has a scheduled run is not created again.
- A multi-day shutdown therefore creates at most one catch-up run for each recurring rule, rather than one run for every missed day.
- Manual runs are independent and do not suppress a scheduled occurrence.
- `WMS_DISABLE_SCHEDULER=1` disables both normal automatic dispatch and startup catch-up.

Example: a recurring rule runs at 22:00 Asia/Shanghai. If the API stops at 18:00 and starts at 08:00 the next day, startup dispatch creates the previous day's 22:00 occurrence. If it instead starts at 23:00, it creates the current day's 22:00 occurrence. If it starts after three days offline, it still creates only the latest due occurrence.

## Dispatch Model

`dispatch_due_creation_rules` remains the single entry point for both startup and minute-level scheduling. It calculates a `scheduled_for` UTC timestamp from each rule's local timezone and the latest due local occurrence.

The existing `DailyCreationRun` uniqueness key `(rule_id, scheduled_for, trigger_kind)` remains the durable idempotency boundary. Scheduled catch-up uses `trigger_kind="scheduled"`, so repeated startup checks and the next minute-level scheduler pass resolve to the same occurrence.

The dispatcher creates each run and its content job transactionally using the existing daily creation service, commits the durable records, then enqueues the job. The existing job reconciler remains responsible for recovering a durable queued job if Redis enqueueing is interrupted.

## Startup Sequence

Database initialization and existing startup reconciliation remain unchanged. When scheduling is enabled:

1. register the scheduler jobs;
2. start APScheduler, whose daily-creation interval job is due immediately;
3. the immediate pass calls the shared dispatcher and performs catch-up before the first one-minute interval elapses.

No separate startup-only dispatch path or last-shutdown timestamp is introduced. This keeps startup and steady-state recovery semantics identical and allows a later minute-level pass to recover from a transient database or Redis failure during startup.

## Timezone and Calendar Rules

- A timezone-aware UTC reference instant is converted into each rule's configured `ZoneInfo` timezone.
- Recurring occurrence selection operates on the rule's local date, including daylight-saving calendar transitions.
- The selected local date and configured wall-clock time are converted back to UTC for persistence.
- A naive injected test timestamp is treated as UTC, matching current behavior.
- Invalid persisted timezone or time values are not silently rewritten. They surface through the scheduler error log under the existing failure handling.

## Failure and Concurrency Handling

- Duplicate dispatcher calls are expected and must remain harmless through the database uniqueness boundary.
- The normal application topology is a single scheduler-enabled API process. This change does not add a distributed scheduler lease.
- A failure on one dispatch pass is logged; the immediately scheduled or next minute-level pass retries.
- Once a one-time rule's run is durably created, the rule is disabled as today. If enqueueing then fails, the durable queued content job is recovered by job reconciliation rather than by creating a second run.
- Disabled and soft-deleted rules are never caught up.

## Testing

Backend tests use injected UTC timestamps and an in-memory enqueue recorder to cover:

- recurring rule caught up from the previous local day before today's scheduled time;
- recurring rule uses today's occurrence after today's scheduled time;
- a multi-day gap produces only the latest recurring occurrence;
- overdue one-time rule is caught up and disabled;
- repeated dispatch at startup creates and enqueues only one run;
- an existing scheduled run suppresses catch-up while a manual run does not;
- disabled, deleted, and future one-time rules remain untouched;
- schedule calculation remains correct across different configured timezones;
- the scheduler still registers the dispatcher for an immediate first run and a one-minute interval.

## Out of Scope

- Replaying every missed recurring occurrence.
- User-configurable catch-up counts or grace windows.
- A distributed leader election mechanism for multiple scheduler-enabled API replicas.
- Changing recovery behavior for content jobs that were already created before shutdown.
- Catch-up for unrelated collection jobs or the legacy 08:00 daily-plan cron job.
