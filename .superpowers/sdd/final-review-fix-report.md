# Final branch review fix wave

Baseline: `dda7776fbd4efafe56937d8885b1a0e2d517a3dc`

## Scope completed

1. Telegram transport and persistence boundaries redact the configured Bot
   Token and central X credentials. `httpx.RequestError` becomes a
   `TelegramSendError` with no sensitive exception chain; `fail_step` redacts
   before storing or returning errors.
2. Immediate and digest Telegram sends use committed SQL conditional claims
   before network side effects. Concurrent requests cannot share a claimed
   decision. Timeout/transport uncertainty and partial delivery persist
   `unknown` plus known message IDs; a process crash leaves `sending` for
   manual inspection rather than automatic resend.
3. Credential deletion now renames the owned file to a hidden quarantine,
   commits the DB deletion, then unlinks. Startup reconciliation restores a
   pre-commit quarantine and removes a post-commit quarantine.
4. Credential create/patch/delete mutations use a sessions-directory
   `fcntl.flock`, acquired through `asyncio.to_thread`, across slot allocation,
   DB flush, file mutation, commit/rollback, and restoration.
5. Nonblank `x_response_account_id` settings accept only an existing, active
   `x`/`twitter` publish account. Worker context repeats the validation and
   falls back to the neutral Chinese profile.
6. Link verification resolves once per hop, pins the request URL to the
   validated IP, preserves the logical Host header and HTTPS SNI, repeats the
   process for redirects, handles bracketed IPv6, and keeps logical canonical
   URLs in API results.
7. Removed the plan document's extra EOF blank line.

The reviewer-deferred Minor UI evidence, FK, and client-test gaps were not
changed.

## TDD evidence

- Secret boundary and publish-account RED: `7 failed, 1 passed`; GREEN:
  `8 passed`.
- Transactional Telegram claim RED: `3 failed`; focused GREEN: `5 passed`;
  notifier/router matrix: `19 passed`.
- Credential quarantine and slot-race RED: `4 failed`; focused GREEN:
  `5 passed`; credential matrix: `34 passed`.
- DNS pinning RED: `2 failed, 1 passed`; GREEN: `8 passed`.
- Telegram API-description redaction RED: `1 failed`; notifier GREEN:
  `8 passed`.
- Queue-to-Telegram persisted-secret regression: `1 passed`.

## Commits

- `4faab2f` `fix(security): redact delivery failures and validate X account`
- `97043e6` `fix(telegram): claim notification delivery transactionally`
- `beec549` `fix(x): serialize credential mutations and quarantine deletes`
- `6128a5c` `fix(x): pin verified link requests to resolved IPs`
- `160a35f` `test(security): cover Telegram secret persistence boundary`
- `f014925` `fix(security): sanitize Telegram API errors`

## Fresh full verification

- Backend: `337 passed in 168.35s`.
- Frontend: `29 passed` test files, `102 passed` tests.
- TypeScript: `pnpm exec tsc --noEmit` exited 0.
- Production build: Next.js 16.2.4 compiled and generated all routes.
- Python: `python -m compileall -q backend` exited 0.
- Compose: `docker compose config -q` exited 0.
- Whitespace: `git diff --check eb8e73c..HEAD` exited 0.

No real X or Telegram endpoint was called. Live Telegram acceptance therefore
remains an operator step with saved credentials. `sending` and `unknown`
delivery states intentionally require manual inspection before any resend.
The cross-process credential lock targets the documented Linux/Compose
runtime.

## Scoped re-review continuation

The scoped re-review found and closed two regressions introduced by this fix
wave:

1. `migrate_x_response_claim_schema()` now branches on the live SQLAlchemy
   connection dialect. SQLite inspects `PRAGMA table_info`, uses plain
   `ADD COLUMN` only when missing, and creates the claim-token index
   idempotently. PostgreSQL retains `ADD COLUMN IF NOT EXISTS`. Tests cover
   both an existing SQLite table and a newly created schema.
2. Telegram notification failures now expose a safe `X-WMS-Retryable`
   response header. The TypeScript API error preserves that flag through
   `failStep`; both immediate and digest workers persist the real retryability
   instead of hardcoding `true`. Permanent 4xx and unknown/partial delivery
   are non-retryable, while definitive 429/5xx responses remain retryable.

The directly related operator UI now renders `推送中` and
`投递状态待确认`, including known Telegram message IDs and the safe stored
error for manual inspection.

Continuation TDD evidence:

- SQLite migration / backend retryability RED: `4 failed, 1 passed`; GREEN:
  `5 passed`.
- Worker retryability / manual-inspection UI RED: `4 failed, 8 passed`;
  GREEN: `3` files and `12` tests passed.

Continuation commits:

- `decded6` `fix(db): migrate Telegram claim schema on SQLite`
- `f7dc55a` `fix(telegram): propagate delivery retryability to jobs`

Fresh full verification after the continuation:

- Backend: `341 passed in 155.44s`.
- Frontend: `31 passed` test files, `108 passed` tests.
- TypeScript: `pnpm exec tsc --noEmit` exited 0.
- Production build: Next.js 16.2.4 compiled and generated all routes.
- Python compilation, Compose validation, and
  `git diff --check eb8e73c..HEAD` all exited 0.
- No real X or Telegram service was called.
