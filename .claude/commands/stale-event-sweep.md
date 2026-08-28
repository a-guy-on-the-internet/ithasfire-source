---
description: "Weekly freshness sweep: finds past-dated PUBLISHED events, cancelled-but-still-visible events, stale community listings, and dead links, then writes a reviewable cleanup doc. Read-only — it flags, it does not fix."
argument-hint: "(optional) a single region id or city to limit the run — defaults to all enabled regions in config.json"
---

You are the **freshness sweep**. Ithas Fire has **no scheduled job that transitions PUBLISHED → COMPLETED/ARCHIVED**, so past events can rot on the public site and cause 404s / dead pages. Your job is to surface everything that needs attention and produce a **reviewable cleanup doc**. You are strictly **read-only** — you flag, you never mutate state.

Optional scope argument: **$ARGUMENTS** (a region id or city; if empty, sweep all enabled regions — or platform-wide if the DB query is global).

## 1. Load config

Read [.claude/curation/config.json](.claude/curation/config.json). Use `staleEventSweep`:
- `gracePeriodDays` — how long after an event's `endsAt` (or `startsAt` if no end) a PUBLISHED event may linger before it's flagged.
- `flagPastPublished`, `flagCancelledStillVisible`, `flagCommunityListingsPastDated`, `checkDeadLinks` — toggles.
- `maxItemsPerRun`.

## 2. Query the database (read-only)

Domain: `packages/db/prisma/*.prisma`. Relevant model is `Event` with `status` (`DRAFT | PUBLISHED | CANCELLED | COMPLETED | ARCHIVED`), `startsAt`, `endsAt`, `stewardship`, `attendance_mode`, `locality`/`region` (city/state), and `body` jsonb (links live here — no dedicated URL column).

**Connection (read-only, SELECT only):** prefer **`$CURATION_DB_URL`** if set — that's the prod read-only connection injected by `.claude/curation/run.sh` (already forced read-only via `PGOPTIONS`). If it's unset, fall back to the localhost `DATABASE_URL` in `.env.local`. Strip any `?query` params before passing the URL to `psql`. Record which DB you used in the artifact's Notes. If you cannot connect at all, STOP and tell the user — a freshness sweep with no data is worthless.

Pull (respecting `maxItemsPerRun`), filtered to in-scope regions where applicable:
- **Past-dated & still PUBLISHED** — `status = PUBLISHED AND coalesce(endsAt, startsAt) < now() - gracePeriodDays`. These need `COMPLETED` or `ARCHIVED`.
- **Cancelled but still visible** — `status = CANCELLED` yet still surfacing on public listings.
- **Community listings past-dated** — `stewardship = COMMUNITY AND attendanceMode = RSVP` with a passed date.

## 3. Optional link check

If `checkDeadLinks`, fetch the primary external URL on each in-scope event/community listing (source link, ticket link, venue site) and record HTTP status. Flag 4xx/5xx and redirects to unrelated domains.

## 4. Write the review artifact

Write to `docs/curation/<YYYY-MM-DD>/stale-event-sweep.md` (date via `date +%F`). Structure:

```
# Freshness Sweep — <date>

## Summary
- Scope: <regions or platform-wide>
- Past-dated PUBLISHED: <n>  | Cancelled still visible: <n>
- Stale community listings: <n> | Dead links: <n>

## Needs archiving (past-dated PUBLISHED)
| Event | Venue | Ended | Days overdue | Suggested action |
|-------|-------|-------|--------------|------------------|
| <title> (id) | ... | <date> | <n> | ARCHIVE / COMPLETE |

## Cancelled but still visible
<title (id) — where it still shows>

## Stale community listings
<title (id) — passed date / recurrence ended?>

## Dead / broken links
<event (id) — url — status>

## Notes
<DB access status, query scope, anything skipped>
```

Each row is an actionable flag; keep event ids so the user can act fast.

## 5. Report back

End with a one-paragraph summary and the artifact path. Make clear these are **flags only** — the user (or a `coder` follow-up) applies `cancel-event` / archive transitions via the real use-cases. Suggest which items look highest-priority (public 404 risk first).
