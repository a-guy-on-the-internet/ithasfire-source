---
description: "Interactive approval + apply for the weekly curation artifacts. Walks each pending proposal (archive stale events, add community listings), you approve/skip, then it applies the approved ones via the REAL use-cases and marks them resolved. Never headless, never raw-SQL writes."
argument-hint: "(optional) a date (YYYY-MM-DD) or artifact path to scope to — defaults to all unresolved items across docs/curation/"
---

You are the **curation apply loop** — the human-in-the-loop approval step for the weekly `/open-mic-scout` and `/stale-event-sweep` artifacts. You present each pending proposal to the user, take an approve/skip/edit decision, and apply the approved ones through the **real use-cases** (never raw SQL for writes). This command is **interactive only** — never run it headless / with skipped permissions.

Optional scope: **$ARGUMENTS** (a date `YYYY-MM-DD` or a specific artifact path; empty = all unresolved items).

## Hard rules
1. **Reads may hit prod read-only; writes are a deliberate, confirmed step.** Before ANY prod write, show the user exactly what will run and get an explicit yes. Default to a **dry-run** (print the intended call, change nothing) unless the user says to execute.
2. **Never write with raw SQL.** Apply only through the sanctioned entry points below (tRPC mutation as an authed prod user, or a `tsx` script wiring the core use-case with real adapters — same pattern as `apps/api/src/scripts/*.ts`).
3. **One item at a time**, most-overdue / highest-404-risk first.
4. Mark every handled item **resolved in its source artifact** (`[ ]` → `[x]` with `— applied <what> on <date>` or `— skipped: <reason>`), and append an apply-log at `docs/curation/<today>/apply-log.md`.

## 1. Gather pending items
Scan `docs/curation/**/*.md` (scoped by `$ARGUMENTS` if given). Collect every unresolved checklist item / flagged row. Group by action type:
- **ARCHIVE / stale past-dated PUBLISHED event** (from the sweep)
- **CANCELLED still visible** (from the sweep)
- **NEW community listing** (from the scout)
- **VENUE must be created first** (from the scout)

If nothing is pending, say so and stop.

## 2. Walk each item → approve / skip / edit
For each item present: title, id, why it's flagged, and the **exact action you'd take**. Take the user's decision (use `AskUserQuestion` for batches, or a simple per-item prompt). Record edits the user makes to a proposal before applying.

## 3. Apply approved items via the REAL entry points
Map each action to its sanctioned use-case. **Confirm, then execute (or dry-run):**

- **NEW community listing** → `community.createCommunityListing` (tRPC; `packages/transport/trpc/src/routers/community.ts`, core `packages/core/src/use-cases/community/create-community-listing.ts`). It is **moderator-gated** — you must act as a prod user holding `COMMUNITY_MODERATOR` (see the prod-auth recipe in memory: mint an `auth_session` + HMAC-signed cookie, use the `/token` JWT for tRPC). Community listing = `attendanceMode: RSVP` + `stewardship: COMMUNITY`, ownerless.
- **VENUE must be created first** → `upsert-place` (`packages/core/src/use-cases/places/upsert-place.ts`) before its listing; new venues stay `listedInDirectory: false` until admin approval (`set-place-directory-listing.ts`).
- **Stale past-dated PUBLISHED event** → use the real lifecycle transitions (do NOT flip `status` in SQL). Offer the user, by intent:
  - **Mark completed** → `events.completeEvent` (tRPC; core `packages/core/src/use-cases/events/complete-event.ts`) — PUBLISHED → COMPLETED, for events that finished normally. Preferred for clearly-finished events.
  - **Archive** → `events.archiveEvent` (core `archive-event.ts`) — PUBLISHED/COMPLETED/CANCELLED → ARCHIVED, tucks it out of public surfaces entirely. Often run after complete.
  - **Unpublish** → `events.unpublishEvent` — reversible "hide it" back to DRAFT; use when it may go live again.
  Both `completeEvent`/`archiveEvent` are **owner-OR-platform-ADMIN** gated (a platform ADMIN may act on ANY event; the admin path is audited with `via:"platform_admin"`). Since curation runs as a platform admin, these will apply cleanly. `events.cancelEvent` is for cancellation+refunds — wrong semantics for a finished event.
- **CANCELLED still visible** → this usually means a *display bug*, not a data fix. Don't mutate. Note it for a `coder` follow-up (why is a CANCELLED event surfacing publicly?).

Prod write access: use the prod **write** connection / authed session only for the confirmed applies (distinct from the read-only `$CURATION_DB_URL` the sweep uses). If you don't have prod write creds available, stay in dry-run and tell the user what to provision.

## 4. Record & report
Update each source artifact's checkboxes, write `docs/curation/<today>/apply-log.md` (item, action, use-case invoked, result / dry-run), and end with a summary: approved, applied, skipped, dry-run-only, and any follow-ups to route to `coder` (notably the missing archive/complete lifecycle).
