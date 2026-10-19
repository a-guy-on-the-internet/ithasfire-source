# Production error log

Last updated: 2026-10-14T19:40-05:00 by error-tracker (manual run, Sentry only; Cloud Logging not swept this run).

Grep-able backlog of production error signatures. Each `ERR-NNNN` is a stable ID — reference it in PR titles (`fix: ERR-0005 …`).

Schema and update rules: [`.claude/skills/error-tracker/SKILL.md`](../../.claude/skills/error-tracker/SKILL.md).

**Triage states** the automation respects:
- `open` / `investigating` / `waiting_on_*` → shown in **Open**
- `ignored` → moved to **Ignored** (noise; counts still tracked, escalations flagged)
- `fixed` → moved to **Recently fixed** on next run (regression flagged if it keeps firing)

## Open — 3 signatures, 57 occurrences in last 24 hours

### [ERR-0005] Event editor render loop ("Maximum update depth exceeded")
- **Source:** Sentry `HEARTH-FIRE-WEB-2D` https://hearth-fire.sentry.io/issues/HEARTH-FIRE-WEB-2D
- **First seen:** 2026-10-15 (UTC) · **Last seen:** 2026-10-15 (UTC)
- **Count (7d):** 48 (all within 15 minutes, one session) · **Trend:** —
- **Signature:** `Error: Maximum update depth exceeded` at `/admin/:slug/events/:id/edit`
- **Triage:** waiting_on_recurrence (owner parked 2026-10-14)
- **Notes:** Owner: it fired while the editor sat idle on prod. Not reproduced on dev, which runs uncommitted editor changes; plan in memory `session_event_editor_render_loop.plan.md`. Unhandled; crashes the editor. Chain: prosemirror DOM observer flush → tiptap `onUpdate` → `ProseEditor.tsx` `onChange` → `EventBuilder.tsx` `handleBodyChange` → `setBodyContent`, repeated. Cause not yet known; the prime suspects are a React node view (image/audio block) whose render mutates editor DOM, or the `imageUrlMap` effect that dispatches `setNodeMarkup`.

### [ERR-0006] Jobs: Postgres connection timeout
- **Source:** Sentry `HEARTH-FIRE-WEB-2C` https://hearth-fire.sentry.io/issues/HEARTH-FIRE-WEB-2C
- **First seen:** 2026-10-14 · **Last seen:** 2026-10-14
- **Count (7d):** 8 · **Trend:** —
- **Signature:** `Error: Connection terminated due to connection timeout` on `POST /jobs/:name`
- **Triage:** fixed (dca1ccd66, NOT pushed or deployed as of 2026-10-15)
- **Notes:** 13 events by 2026-10-15, prod and dev, plus `HEARTH-FIRE-WEB-2F` "timeout exceeded when trying to connect" (1). Not one job: every job of a :00 tick fails together on a cold jobs instance (21 jobs released at once into an empty pool; jobs pg.connect p95 6.7s vs API 683ms). Cloud Scheduler has no retry, so the tick is lost. Fix: pre-warm the pool before listen + `startup_cpu_boost` on the jobs module. Judge it by :00-tick failures after deploy, not connect p95 (warm-up connects still count). Plan: memory `session_jobs_db_pool_connect_timeouts.plan.md`.

### [ERR-0007] Jobs: Prisma interactive transaction could not start
- **Source:** Sentry `HEARTH-FIRE-WEB-17` https://hearth-fire.sentry.io/issues/HEARTH-FIRE-WEB-17
- **First seen:** 2026-10-14 · **Last seen:** 2026-10-14
- **Count (7d):** 1 · **Trend:** —
- **Signature:** `Transaction API error: Unable to start a transaction in the given time.` on `POST /jobs/:name`
- **Triage:** fixed with ERR-0006 (dca1ccd66), unverified
- **Notes:** Same cold-instance burst as ERR-0006: Prisma's tx `maxWait` (10s) expires waiting for a pool connect. Watch for P2028 on :00 ticks after deploy.

## Ignored

Skipped as noise this run (client-side network failures and browser view-transition aborts, no server fault):
`HEARTH-FIRE-WEB-2B` (View Transition aborted, document hidden, 10), `HEARTH-FIRE-WEB-14` / `-1V` / `-1T` (TRPCClientError Load failed / Failed to fetch, 9), `HEARTH-FIRE-WEB-2A` (Failed to fetch, 1).

## Recently fixed — dropped after 30 days

ERR-0001 to ERR-0004 (April 2026 seed run) were silent for more than 30 days and have been dropped.
