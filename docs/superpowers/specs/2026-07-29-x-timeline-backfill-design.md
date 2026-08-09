# X timeline subscription backfill

## Goal

Let an operator manually collect recent posts from one **timeline** (individual-account) X subscription, without changing its normal incremental collection behavior.

## User flow

1. Open **X → Subscription management**.
2. For a timeline subscription, choose **Backfill collection**.
3. In a dialog, enter a number of days. The default is 7; valid values are 1 through 90.
4. Submit the collection task. The UI reports the number of newly stored posts when it completes.
5. Any newly stored post follows the existing response dispatch and enabled topic-source / AI material-screening rules.

Search subscriptions do not show this action because their existing query configuration already owns the time window.

## Backend behavior

- Add a subscription-specific collection endpoint accepting `days`.
- It is valid only for `timeline` subscriptions; reject search subscriptions with a clear 422 response.
- Compute `now - days` as the fetch cutoff and pass it to the feedgrab paginator.
- Reuse the existing post upsert and global `tweet_id` deduplication path. Existing records are skipped and are not re-dispatched to AI material screening.
- The endpoint does not change `last_collected_at` semantics or the normal incremental cutoff algorithm.
- Bound `days` to 1–90 at the API boundary. Feedgrab/network errors retain the existing subscription error reporting behavior.

## Frontend behavior

- Add a **Backfill collection** action next to the existing per-subscription collection action.
- The action is visible only for timeline subscriptions.
- Use the project Dialog component, never browser `prompt`.
- Disable duplicate submission while the request is in progress; surface API errors through the existing toast pattern.

## Tests

- Router test: the backfill endpoint passes a requested 7-day cutoff to `grab_timeline`.
- Router test: out-of-range values and search subscriptions are rejected.
- Router test: existing tweet IDs are deduplicated and only fresh IDs are dispatched.
- Client test: the action is displayed for a timeline subscription, submits the selected day count, and is absent for search subscriptions.

## Scope boundaries

- No automatic historical backfill when a subscription is created.
- No persistent per-subscription backfill-day setting.
- No change to the existing manual AI screening action for posts already in the database.
