# Daily Creation Retry State Design

## Goal

Make a retryable `daily_creation` Job resume from a failed provider attempt and produce valid persisted outputs, while keeping MCP error responses out of successful tool evidence.

## Design

- When `retry_locked_step` queues a new attempt for a `daily_creation` Job, restore its linked `DailyCreationRun` from `failed` to `queued`, clear the previous error detail, and clear its completion timestamp in the same transaction.
- Do not relax `save_daily_creation_outputs`; it must continue accepting only `queued` or `running` runs.
- At the global Agent tool-policy boundary, treat an MCP result with top-level `isError: true` as a failed audit event. Return the original result to the model so it can inspect and repair the tool request; do not turn the MCP result into a thrown transport exception.
- A normal successful result and replayed durable result retain their existing behavior.

## Verification

- A backend regression test fails before the fix because retrying a failed daily-creation step leaves its Run failed; after the fix, the Job, new step, and Run are queued and the Run error is cleared.
- A TypeScript regression test fails before the fix because an `isError: true` MCP result is audited as succeeded; after the fix, the final audit is failed and retains the MCP error text.
- Run only the relevant content-job, Agent tool-policy, and daily-creation Agent tests.
