# Daily Creation Agent-Only Design

## Goal

Make the shared Agent runtime the only execution path for `daily_creation` jobs. Remove runtime version dispatch and the legacy fixed pipeline, then clear existing daily-creation job history without affecting other flows or generated content.

## Runtime contract

- New `daily_creation` jobs contain only the durable `run_id` in `input_data`.
- The content worker dispatches every `daily_creation` job directly to `runDailyCreationAgentJob`.
- The reconciler treats every queued or running `daily_creation` job as an Agent job that may be resumed.
- No `runtime_version`, legacy fallback, or unsupported daily-runtime branch remains.
- The Agent owns Skill selection, reference loading, validation, tool use, and atomic output persistence.

## Removed code

- Delete `wemedia-studio/lib/ai/daily-creation-job.ts` and its dedicated tests.
- Remove the legacy Runner import, dependency option, error class, dispatch branch, and version propagation from `content-worker.ts`.
- Update tests and fixtures so a daily job has `{ run_id }` and always resolves to the Agent Runner.

## One-time data cleanup

The live development database is cleaned once after the code cutover. The cleanup targets only jobs where `content_jobs.flow = 'daily_creation'` and their execution records:

1. `agent_tool_calls` belonging to matching Agent executions;
2. `agent_executions` for matching jobs;
3. `content_job_events` and `content_job_steps` for matching jobs;
4. `daily_creation_output_batches` for matching runs;
5. `daily_creation_runs` and matching `content_jobs`.

Existing generated drafts, plan items, creative assets, and `content_usage_ledger` records are retained. Retaining usage evidence prevents the Agent from recreating semantically duplicate content. Other content-job flows and their records are untouched.

The cleanup is an explicit transaction, not an application-startup migration. Before deletion, record per-table counts and the count of non-daily jobs. After commit, verify that no daily jobs/runs/executions remain and the non-daily job count is unchanged.

## Error handling and recovery

A daily job can no longer silently fall back. If the Agent cannot initialize, select an available Skill, call required tools, validate its output, or provide atomic-save evidence, the job fails through the Agent execution audit path. Queued and running jobs are reconciled without consulting a version marker.

## Verification

- Worker tests prove `daily_creation` always resolves to `runDailyCreationAgentJob` and does not pass a runtime version.
- Backend tests prove new job input is exactly `{ "run_id": id }` and all active daily jobs are reconciled as Agent resumptions.
- Agent job and integration tests use version-free job fixtures.
- Repository search confirms the version marker and legacy Runner are absent.
- Targeted backend and frontend/worker suites pass.
- Live database before/after counts prove scoped cleanup.
