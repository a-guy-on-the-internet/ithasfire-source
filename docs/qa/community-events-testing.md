# Community Events — QA Testing Baseline

Shared context for AI/agent-driven testing of the **community-managed event
listings** feature and adjacent event flows. Individual test prompts reference
this file for environment, access, seed data, code map, and the known
fixed/open baseline — so each prompt only carries its own mission.

> Read this whole file before starting a run. Report findings against the
> conventions at the bottom; do NOT re-file items listed under "Known-fixed".

---

## Environment & access

- **Local dev** — web `http://localhost:3000`, API `http://localhost:3001`.
  Start with `pnpm stack:dev` (infra docker containers — postgres:5432, redis,
  minio, tileserver:8081 — are already up). If a route 404s locally but works on
  the dev deployment, suspect a Turbopack dev route-resolution quirk; restart the
  web dev server (clear `apps/web/.next`) before filing it.
- **Dev deployment** (production build — source of truth for "does it really
  work") — `https://web-dev.ithasfire.com`.
- **Login** (password fallback): on `/sign-in` click **"USE PASSWORD INSTEAD"**,
  then `admin@ithasfire.com` / `Dev-Login-2026!`. This account is a platform
  **ADMIN** (counts as a community moderator) and OWNER of orgs `demo` (local) /
  `dev-qa-collective` (dev).
- **You almost always need three identities**: the admin above (moderator/owner),
  a **normal signed-in non-owner** user, and an **anonymous** (signed-out)
  session — submitters/RSVPers are usually not the approver.
- **Drive the browser** with the chrome-devtools tools. Read source to confirm
  whether a defect is client / server / schema, and cite `file:line`.

## Seed data

- `pnpm seed:community-qa` → creates one **COMMUNITY (ownerless) listing** plus
  3 PENDING edit suggestions across mixed submitters (authed non-owner ×2,
  anonymous-by-IP), including a **competing-title pair** for conflict testing.
  Re-runnable (fresh set each run). Lands a populated `/moderate/suggestions`.
- Script: `apps/api/src/scripts/qa/seed-community-suggestions.ts` (drives the REAL
  use cases — createCommunityListing + submitEventEditSuggestion — no raw SQL).

## Key surfaces

| Surface | Where |
| --- | --- |
| Community listing editor (ownerless, moderator-gated) | `/admin/<org>/events/new/community` |
| Full event builder (ticketed; hero/place-picker/recurrence) | `/admin/<org>/events/<id>/edit` |
| Moderator suggestion queue (community-wide) | `/moderate/suggestions` |
| Moderator applications (RfA) | `/moderate/applications` |
| Public event page | `/events/<slug>` |
| Saved / watchlist | `/saved` |

Community listings are **ownerless** (no org, no tickets/payout), **RSVP-based**
(not ticketed), **published immediately**, and edited via **suggestions**
reviewed by COMMUNITY_MODERATOR/ADMIN — there is no org-owner review tab for them.

## Code map

- Transport (tRPC): `packages/transport/trpc/src/routers/` — `community.ts`,
  `event-suggestions.ts`, `event-saves.ts`, `moderator-applications.ts`.
- Core use cases: `packages/core/src/use-cases/community/` —
  `create-community-listing`, `submit-event-edit-suggestion`,
  `review-event-edit-suggestion`, `list-pending-edit-suggestions`,
  `rsvp-to-event`, `cancel-rsvp`, `list-my-rsvps`, `apply-to-be-moderator`,
  `review-moderator-application`.
- Web: `apps/web/src/app/admin/[slug]/events/new/community/`,
  `apps/web/src/app/moderate/`, `apps/web/src/components/community/`.
- Suggestable-field whitelist: `packages/core/src/use-cases/events/_shared/suggestion-fields.ts`.
- Search backend runs on Postgres (`SEARCH_BACKEND=postgres`); Meilisearch is
  retired.

---

## Known-fixed baseline — VERIFY, don't re-file as new

- **Infinite-scroll list queues load.** tRPC `useInfiniteQuery` injects a
  top-level `direction` key; `.strict()` input schemas used to 400
  (`unrecognized_keys`), breaking the Suggestions tab, the moderator suggestion
  + application queues, and `/saved`. Fixed. Confirm each loads.
- **Review queues show submitter display names**, not a UUID prefix
  (`/moderate/suggestions` + owner inbox). Confirm names render; anonymous
  submitters show "Anonymous". Only the display name is exposed — never email/IP.

## Corrected facts (avoid re-mis-diagnosing)

- Edit suggestions for `title` / `ageLimit` / `addressText` / `startsAt`+`endsAt`
  / `timezone` all SUBMIT successfully. A suggestion carrying **non-editable**
  keys (`region`/`locality`/`postalCode`, `ownerId`, `status`, …) is correctly
  rejected with `EDIT_SUGGESTION_INVALID_FIELDS` (meta lists the bad keys). DO
  still test whether the public submit UI surfaces WHICH key was invalid.
- Submit adds gates beyond the field schema: a **content filter** on all free
  text (incl. `addressText`/title/note) and a **schedule-validity** check on date
  bounds. Exercise both.

## Notification / feedback-loop status (audited 2026-07-04, live-verified)

The suggestion feedback loops the earlier baseline listed as "no notifications"
are now **partly wired in uncommitted WIP** — `packages/core/src/use-cases/
community/_shared/suggestion-notifications.ts` (untracked). Do NOT re-file
touchpoints #1/#2 as "nothing happens"; file the *defects* on the wired path
instead. Everything else in the lifecycle is still silent. Matrix below was
verified live against a seeded community listing (submitter Alex Rivera, RSVPer
Diego Alvarez) — approving title / **content-body** / date changes each created a
SUCCESS notification for the submitter; the RSVPer got **0** despite a material
date move.

| Trigger | Should notify | Status | Notes / where it wires in |
| --- | --- | --- | --- |
| Suggestion approved/rejected | Submitter | ⚠️ WIP, in-app only | `suggestion-notifications.ts:81`. **Verified live** for title/content/date — SUCCESS notification, review note in body. Deep link `/events/${event.id}` **works** (route accepts a bare event id and 307-redirects to the canonical slug — `events.ts:1648` UUID fallback). Anon submitters still get nothing. |
| New pending suggestion | Approver side (mods / org members / owner) | ⚠️ WIP, in-app only (ADMIN-only gap **FIXED**) | `suggestion-notifications.ts:39`. COMMUNITY listings notify `COMMUNITY_MODERATOR` holders, **falling back to platform ADMINs when no dedicated moderator exists** (`resolveApproverRecipients`). Verified live: 3 seeded suggestions under ADMIN-only staff now produce 3 ADMIN notifications (was 0). No PII leak. |
| Suggestion *received* (submit-time) | Submitter (receipt) | ❌ missing | Submitter gets no "pending review" ack until the outcome. |
| RSVP confirmation | Attendee | ❌ missing | `rsvp-to-event.ts` upserts, returns, no notify. |
| Pre-event reminder | RSVPers | ❌ missing | `n-reminder` renderer variant exists but **zero emitters**; no reminder job in `apps/jobs/src/jobs/index.ts`. Model on `volunteers.reminders-24h/1h`. |
| New RfA (moderator application) | ADMINs | ❌ missing | `apply-to-be-moderator.ts` — audit only. |
| RfA approved/rejected | Applicant | ❌ missing | `review-moderator-application.ts` — grants role, applicant never told. |
| Event cancelled | RSVPers + ticket buyers | ✅ shipped (WIP tree) | `cancel-event.ts` writes a CANCELLED `EventChangeNotice` in-tx → `events.dispatch-change-notifications` job → `event.cancelled` (buyers get money-aware refunded/**refund-pending**/RSVPer-plain copy, in-app + email). Verified live. |
| Event rescheduled / venue moved | Prior RSVPers ∪ savers | ✅ shipped (WIP tree) | `review-event-edit-suggestion.ts` writes RESCHEDULED/VENUE_CHANGED notice on material approve → `event.changed`. Verified live (in-app + Mailpit email). **Still uncovered:** the OWNER direct-edit path (`save-event-shared.ts:717` = tax restamp only, no material detection) — an org owner moving their own event's date does not yet notify. |
| Event archived / unpublished | RSVPers ∪ savers | ✅ shipped (WIP tree) | `archive-event.ts` (gated on PUBLISHED) + `unpublish-event.ts` (now tx-wrapped) write ARCHIVED/UNPUBLISHED notice → `event.unlisted`. Verified live. |
| New community listing | Moderators | ❌ missing (low value) | `create-community-listing.ts` — audit only. |

**Cross-cutting flags:**

- **WIP path bypasses the canonical `notify()` fan-out** (`use-cases/comms/
  notify.ts`) — it calls `repos.notifications.create()` directly, so it skips
  preference/consent gating, idempotency, and email/push. Users cannot mute it;
  no email is ever sent even though `notify()` would give it for free.
- **Locale ignored** — copy is hardcoded English. Platform-wide (even the
  dispute gold-standard formats dates with `"en"`), so track, don't re-file per
  touchpoint.
- **No PII leak** on the two wired loops — only `eventId`/`suggestionId` + title
  travel.
- **Approver-notification audience for ADMIN-only staff — FIXED** (this session):
  `resolveApproverRecipients` now falls back to platform ADMINs when no
  `COMMUNITY_MODERATOR` exists, so the queue is never unwatched; dedicated
  moderators still shield admins from per-suggestion noise once they exist.

Reusable primitives for the missing loops: `notify(variant, humanId, payload)`
(`use-cases/comms/notify.ts`), `notifyBuyer` (`orders/notify-buyer.ts`, wired at
`refund-order-items.ts:361`), and the watcher union `listHumanIdsForEvent`.

---

## Reporting conventions

For every defect: `[Severity S1–S4]` short title; exact repro (URL + role +
steps); expected vs actual; the verbatim tRPC/console/network error; root-cause
hypothesis with `file:line`; a screenshot reference. Capture the failing network
request/response and console errors, not just the UI symptom. End each run with a
coverage summary (what you tested, what you couldn't reach and why) and the top 3
fixes. Call out MISSING feedback loops and silent gaps as first-class findings.
