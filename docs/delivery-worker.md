---
summary: Run and recover the self-hosted MongoDB delivery worker used by the Ortskurier fork.
read_when:
  - Deploying the Mailcheap web process or delivery worker
  - Investigating queued, scheduled or failed campaign jobs
  - Rotating worker credentials or changing send rate
---

# Delivery worker

This fork replaces QStash with a persistent Node process and the existing MongoDB database. Run one
web instance and one worker. The web process owns rendering, subscription checks and SES delivery;
the worker owns job leases and calls three fixed internal HTTP routes. Confirmation intents share this worker. See [signup delivery](signup-delivery.md). No SES keys, administrator
password or session secret are needed in the worker environment.

## Configuration

Both processes need the same `MONGODB_URI`, `JOB_WORKER_SECRET` (at least 32 random characters) and
`SENDING_ENABLED`. Generate a worker secret once with `openssl rand -hex 32`; keep it separate from
`SESSION_SECRET`. The worker additionally needs `JOB_APP_URL`, the private origin of the web process,
such as `http://mailcheap:3000`. It follows no redirects. Keep MongoDB and the worker off public ports.

After building the web app, run `npm start` and `npm run worker` as separately supervised processes.
For development the same worker can call `next dev` on localhost. Job authentication is required in
development too. Set `SENDING_ENABLED=false` on both processes to stop delivery while preserving
queued work; recreate both processes when changing the environment. Confirm their health before
enabling any campaign. A worker health check succeeds while sending is intentionally off.

## Persistence and recovery

- One campaign job advances at most 50 message rows per request, then yields to other due jobs.
  Existing consent, active-contact, campaign-pause, suppression and SES rate checks still apply.
- Scheduled jobs retain the exact campaign id and UTC schedule. No delay-chain or external scheduler
  is needed. The handler checks the current campaign and timestamp, so obsolete schedules do nothing.
- Job writes request journal acknowledgement. A unique key deduplicates concurrent producers, and
  an atomic claim grants a five-minute lease with a fresh token. Requests require an HMAC covering
  the method, path, body, timestamp, job id and token, and a matching current lease in MongoDB.
- The worker renews every 30 seconds; a request times out after four minutes. A crashed worker's
  lease can be reclaimed after five minutes. A stale owner cannot renew or acknowledge the new lease.
- Startup and minute-by-minute reconciliation queue missing jobs for `sending` and `scheduled`
  campaigns. This repairs a crash between a campaign state write and enqueue on standalone MongoDB.
  The same pass restores missing confirmation jobs from Contact intents. Draft/paused campaigns remain idle. Retrying the same job never reselects the campaign's audience.
- HTTP 202 continues the next batch without using the retry budget. HTTP 409 defers for one minute
  while sending is off. Network errors, throttling and server errors retry with exponential backoff
  and jitter; eight consecutive failures stop the job. Other client errors stop it immediately.
  Reconciliation preserves stopped jobs and their failure history.
- Completed jobs expire after seven days. Pending and stopped jobs have no TTL. A later explicit
  campaign resume/extension reactivates its completed job. Payloads contain ids/times only.

The job transport is retryable; email delivery uses a journalled **at-most-once claim**. Mailcheap
marks a message `sent` before calling SES with one SDK attempt. A web-process crash in that gap can leave an uncertain
message, while retrying a lost HTTP response skips already claimed messages. Never automatically
requeue these uncertain rows: SES may already have accepted the email. The worker marks itself
unhealthy when `sent` rows have neither `sentAt` nor `sesMessageId` after 15 minutes. Reconcile them
against signed SES events and provider evidence before any manual correction. Exactly-once delivery
across MongoDB and SES is not promised.

## Operator commands

Use the worker's own environment; commands print counts and job identifiers without email addresses:

```sh
node scripts/mail-worker.mjs status
node scripts/mail-worker.mjs retry JOB_ID
node scripts/mail-worker.mjs health
```

`status` includes up to 50 stopped jobs with their ids and safe HTTP error codes. Fix the underlying
fault before `retry`, then monitor the campaign. `health` checks a recent database/worker heartbeat,
stopped jobs and uncertain messages. Container health reports need an external monitor or an operator;
the worker itself sends no incident emails. Give shutdown at least 270 seconds to finish its request.

The initial deployment supports one worker and one web process. Multiple web instances would require
a shared SES rate limiter; do not scale replicas by copying the current per-process rate setting.

## Verification and migration

`npm test` covers signing and retry classification. To run recovery tests against a real MongoDB:

```sh
MAILCHEAP_TEST_MONGODB_URI=mongodb://127.0.0.1:27017/mailcheap_test npm test
```

The integration suite uses randomly prefixed collections and removes only those collections. It
tests concurrent ownership, persisted lease recovery, stale acknowledgements, future schedules,
bounded retries, explicit recovery, lost responses and campaign-outbox reconciliation. It sends no
email and never creates real subscriptions. End-to-end confirmation/campaign delivery needs its own
explicitly approved launch test.

For an existing QStash installation, pause campaigns and disable sending first. Stop the old QStash
schedules, deploy this web version and its matching worker together, and inspect reconciled jobs.
Old QStash requests are rejected. The Ortskurier deployment had no QStash account or pending provider
jobs, so no provider-side migration was necessary. Preserve the original permanent `SESSION_SECRET`.
