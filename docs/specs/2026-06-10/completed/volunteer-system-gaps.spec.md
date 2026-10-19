# Volunteer System — Functional Gap Closure

**Date:** 2026-06-10
**Status:** draft
**Priority:** Mixed — P1 (capacity) through P4 (hours dashboard); see per-gap headers
**Companion to:** `../2026-03-23/completed/volunteering.spec.md` (base system),
`../2026-04-24/volunteer-scanner-check-in.spec.yaml` (scan tokens),
`../2026-03-25/completed/waiver-system.spec.md` (waivers),
`../2026-05-18/sms-opt-out.spec.md` (SMS consent)

---

## Context

Phase 1 of the volunteer system is shipped and audited as BUILT (AUDIT-2026-06-09):
templates → event roles → shifts → public signup (shadow-profile friendly) → review →
scanner check-in → hours CSV → 24h/1h reminders. A 2026-06-10 code investigation found
seven functional gaps. This spec closes them. It does **not** cover the three unbuilt
follow-up specs from 2026-04-24 (schedule timeline, badge designer, wallet passes) —
those stand on their own.

Verified code anchors (2026-06-10):

- `packages/core/src/use-cases/volunteering/volunteer-signups.ts` — `submitVolunteerSignup`
  performs **no capacity check** (no reference to `capacity` or `countBy*` anywhere in the
  file); `reviewVolunteerSignup` (L207) is single-signup only.
- `packages/ports/src/repos/volunteering.ts` — counts already exist: `countByRole`,
  `countByShift`, `countByShiftForEvent`, `countByEventsAndStatus`, plus
  `clearSmsOptInByPhone` (carrier STOP path, wired per 2026-05-18 spec).
- `send-volunteer-shift-reminders.ts` — `inApp: Pick<InAppPort, "publish"> | null` (L75);
  the jobs container passes `null`, so the in-app channel is dead code.
- `packages/db/prisma/waiver.prisma` — `WaiverAcceptance` requires `orderId`
  (`@@unique([orderId, waiverTemplateId])`); it cannot record a volunteer's acceptance.
- `packages/core/src/use-cases/comp/issue-comp-tickets.ts` + `OrderSource.COMP` exist and
  are unconnected to volunteering.

---

## Gap 1 — Capacity enforcement at approval (P1, correctness bug)

**Problem.** `EventVolunteerShift.capacity` and `EventVolunteerRole.capacity` are stored
and displayed, but nothing prevents oversubscription.

**Principle (decided 2026-06-10).** Capacity only applies to **accepted** signups.
Occupancy = `APPROVED | CHECKED_IN`. Pending signups never count against capacity and
submission is never blocked — the pending pool acts as a natural waitlist.

**Behavior.**

1. `submitVolunteerSignup`: **no capacity check.** Anyone can apply, even to a full
   shift; their signup sits in `PENDING`.
2. `reviewVolunteerSignup` (approve path): count `APPROVED | CHECKED_IN` for the target
   shift (or role, when `shiftId` is null and the role has a capacity). If count ≥
   capacity → throw `shift_full` / `role_full` (tRPC `CONFLICT`). Admin can raise the
   capacity and retry — no force flag in v1. Auto-approve events: when full, the signup
   still lands but as `PENDING` instead of auto-`APPROVED` (capacity governs acceptance,
   not application).
3. `list-public-event-volunteer-roles`: include `acceptedCount` / `capacity` per
   shift/role so the public form can show "Full — you'll be waitlisted" rather than
   disabling selection.
4. Race tolerance: approve-path check + status update run in one transaction
   (tx-wrapped count + update in the Prisma adapter).

**Touches.** core: `volunteer-signups.ts`, `list-public-event-volunteer-roles.ts`;
ports/adapters: one transactional repo method; web: public form "full / waitlist" copy,
admin Signups tab approve error toast. Migration: none.

**Acceptance.** Approving past capacity returns `CONFLICT`; auto-approve degrades to
pending when full; public form labels full shifts but still accepts applications; new
tests cover boundary (capacity − 1, capacity, concurrent approves).

---

## Gap 2 — Bulk signup review (P2)

**Problem.** Review is one row at a time. Events with auto-approve off and 100+ signups
make approval a click marathon.

**Behavior.** New use case `reviewVolunteerSignupsBatch(signupIds[], decision, note?)` —
same RBAC as single review (org-edit-role), iterates the existing single-review logic so
all side effects (capacity check per Gap 1, status email, EventHuman creation) stay
identical. Returns per-id results `{ id, ok, code? }` — partial success allowed; one full
shift must not poison the batch. tRPC: `volunteer.signups.reviewBatch`. UI: checkbox
column + "Approve selected / Reject selected" on `SignupsTab.tsx`; reject keeps the
existing reason dialog (one reason applied to all).

**Acceptance.** 50 signups approved in one action; per-row failures surface inline;
emails sent per signup (existing template, no new template).

---

## Gap 3 — Volunteer form + waiver tied to the Human profile (P2, legal exposure)

**Problem.** Volunteers do physical work (load-in, parking, crowd) but the waiver system
only fires at ticket checkout. `VolunteerSignup.answers` is free-form JSON — not an
acceptance record. And everything a volunteer fills out today lives on the *signup*, so
nothing carries to their next event with the same org.

**Decision (2026-06-10).** The volunteer form — contact details, form answers, and the
waiver acceptance — must be **tied to the Human profile**, not just the signup. Every
signup creates or resolves a Human (shadow profile when unauthenticated — this flow
already exists); `VolunteerSignup.humanId` becomes effectively always-set going forward
(column stays nullable for legacy rows). Keep acceptance models separate (consistent
with the 2026-06-10 AcceptanceRecord decision context): dedicated table rather than
loosening `WaiverAcceptance.orderId`.

**Data.**

```prisma
model VolunteerWaiverAcceptance {
  id               String   @id @default(uuid())
  humanId          String   // the profile the acceptance belongs to
  signupId         String   @unique // the signup that prompted it
  waiverTemplateId String
  waiverVersion    Int
  waiverBodyHash   String   // SHA-256, mirrors WaiverAcceptance
  acceptedAt       DateTime @default(now())
  ipAddress        String?
  userAgent        String?
  // relations: human (Cascade), signup (Cascade), waiverTemplate (Restrict)
  // @@index([humanId, waiverTemplateId])
}
```

Event flag: `Event.volunteerWaiverRequired Boolean @default(false)`. The waiver shown is
the event's assigned waiver (`get-event-waiver` already resolves it); no separate
volunteer waiver template in v1.

**Behavior.**

- When `volunteerWaiverRequired` and the event has a waiver: the public signup form
  renders the waiver body + checkbox; `submitVolunteerSignup` rejects without acceptance
  (`waiver_required`) and writes the acceptance row in the same transaction as the
  signup, snapshotting version/hash/ip/ua and keying it to the resolved Human.
- Because acceptances are human-keyed, a returning volunteer who already accepted the
  **same template + version** can be shown "already on file" instead of re-signing
  (re-acceptance required when the version bumps).
- Form answers and contact info captured at signup also update the Human profile
  (shadow-upgrade path already merges shadow → real account on sign-in, so the data
  follows them).
- Admin Signups tab shows a "waiver ✓" chip; hours CSV export gains a
  `waiverAcceptedAt` column.
- Enabling the flag after signups exist: **neither** chase-up emails nor a check-in
  block (decided 2026-06-10). New signups are gated; existing ones are left alone.

**Acceptance.** With flag on, signup without checkbox fails; acceptance row records the
exact version/hash keyed to the Human; returning volunteer with a current acceptance
skips re-signing; flag off → form unchanged.

---

## Gap 4 — Comp ticket linkage — DEFERRED (likely not needed)

**Decision (2026-06-10).** Volunteers are not compensated — that would make them not
volunteers. They will and can receive tickets and implicit gifts that are **not marked**
or tracked as volunteer perks. The existing manual comp flow
(`issue-comp-tickets.ts`) already covers this; no volunteer-side linkage, chip, or
metadata stamp will be built. Revisit only if orgs report real friction.

---

## Gap 5 — Wire in-app reminders (P3, small)

**Problem.** `send-volunteer-shift-reminders.ts` fully supports an `inapp` channel via
`InAppPort.publish`, but `apps/jobs/src/lib/container.ts` passes `inApp: null`.

**Behavior.** Construct the existing in-app adapter in the jobs container and pass it.
Channel applies only to signups with `humanId` (shadow profiles have no inbox) — the use
case already gates per-channel availability; verify it skips humanless signups rather
than erroring. Ledger uniqueness `(signupId, kind, channel)` already prevents dupes.

**Acceptance.** A signed-in volunteer gets an in-app notification at 24h and 1h; shadow
signups still get email/SMS only; no duplicate sends across job retries.

---

## Gap 6 — Volunteer SMS/contact preference surface (P3, TCPA hygiene)

**Problem.** `smsOptIn` is captured at signup and carrier STOP works
(`clearSmsOptInByPhone`, 2026-05-18 spec), but a volunteer cannot see or change the
toggle in-product. The reminder email's "manage" URL lands on a page with no SMS control.

**Behavior.** On the volunteer's manage surface (the `listMine` page the reminder links
to): per-signup SMS toggle → new mutation `volunteer.signups.updateContactPrefs`
(ownership-guarded, sets `smsOptIn`, requires phone present to enable). Copy notes that
replying STOP also works. No global preference in v1 — consent stays per-signup, matching
how it was captured.

**Acceptance.** Volunteer can disable/enable SMS for a signup; disable suppresses the
next reminder's SMS leg (email unaffected).

---

## Gap 7 — Cross-event volunteer hours view (P4)

**Problem.** `hoursWorked` + per-event CSV exist, but orgs can't answer "how many hours
has this person volunteered this year?" — needed for recognition programs and (for
nonprofits) grant reporting.

**Behavior.** Org-level admin page `/admin/[slug]/volunteers` listing distinct
volunteers (by humanId, falling back to contactEmail) with total hours, events count,
last shift date; date-range filter; CSV export. New repo aggregate
`aggregateHoursByVolunteer(orgId, range)` (single grouped query — no N+1); tRPC
`volunteer.hours.orgSummary` (org-edit-role). Read-only; no schema change.

**Acceptance.** Org admin sees totals across events matching the sum of per-event
exports; CSV downloads; volunteers with only shadow profiles still aggregate by email.

---

## Gap 8 — Day-of volunteer signups (P2, added 2026-06-11) — ✅ RESOLVED 2026-06-11

**Problem (as observed).** During a live event the contextual action bar's Volunteer
CTA disappeared, blocking day-of recruiting (Teardown shifts run *after* the event).

**Root cause (investigation 2026-06-11).** There was never a time gate. The CTA's CAB
data key is published by `VolunteerSection` only when its public-roles query succeeds;
the query used `retry: false`, so a single transient API failure (dev API restarting at
observation time) latched `isError` for the whole session and the CTA never appeared.
`GET TICKETS` was unaffected because `ticketsAvailable` is published from SSR props,
not a client query. The earlier "roles query returned 200" evidence was a misread tRPC
batch response.

**Fix shipped.** `shouldRetryVolunteerRolesQuery` in `volunteer-section.helpers.ts`:
never retry `NOT_FOUND` (the intentional "volunteering off" signal), retry transient
errors up to 3×. Regression tests pin that the CAB volunteer segment is gated only by
`volunteeringEnabled` and that in-progress events stay visible until `endsAt`.

**Acceptance (verified live, Playwright).** During a live event the CTA shows and the
sheet accepts signups (incl. Teardown); after `endsAt` it hides and the query is
suppressed; volunteering-disabled settles to hidden with no retry delay.

**Residual finding (separate loop):** `AppShell.tsx` and `GlobalOverlays.tsx` both
mount `<ContextualActionBar />` — duplicate fixed navs / a11y landmarks.
`GlobalOverlays` declares itself the single mount point; the AppShell render is a
leftover.

---

## Gap 9 — Waitlist spot-opened notification (P3, added 2026-06-11)

**Problem.** The pending pool acts as a waitlist (Gap 1), but when an APPROVED volunteer
withdraws, nobody learns a seat opened — admins must remember to re-check the Signups
tab, so waitlisted volunteers rot.

**Decision.** No auto-promotion in v1 — capacity governs *acceptance*, and acceptance
stays an admin decision (consistent with Gap 1's no-force-flag stance). Instead, notify
the event's org admins.

**Behavior.** In `withdrawVolunteerSignup`, when the withdrawn signup was APPROVED (or
CHECKED_IN is impossible to withdraw — PENDING withdrawals are a no-op for this) and the
freed shift/role has at least one PENDING signup, send a notification to org admins
(existing `notify` port, new variant `volunteer.spot-opened`): event, role, shift, and
pending count, deep-linking to the Signups tab. Idempotency key = withdrawn signup id,
so retries can't double-send.

**Acceptance.** Withdrawing an approved signup on a target with pending applicants
notifies org admins once; withdrawal with no pending applicants sends nothing; pending
withdrawals send nothing.

---

## Sequencing

| Phase | Gaps | Why |
|---|---|---|
| 1 | Gap 1 (capacity) | ✅ Done 2026-06-10. Correctness bug; everything else builds on trustworthy counts |
| 2 | Gap 2 (bulk review) + Gap 5 (in-app wiring) | Cheap, independent |
| 3 | Gap 3 (form + waiver on Human profile) | One migration; legal exposure before next physical-work event |
| 4 | Gap 6 (SMS prefs) | UI-led, small |
| 5 | Gap 7 (hours dashboard) | Nice-to-have reporting |
| 6 | Gap 8 (day-of CTA) + Gap 9 (spot-opened notification) | Make the waitlist real; small web + core loops |

Gap 4 is deferred entirely. Each phase is one dev-loop iteration
(build → review → fix → approve).

## Open questions

- Should `Event.minimumAge` gate volunteer signups too? Today it is ticket-only and the
  signup form collects no DOB. Left out of scope pending a product call.

## Out of scope

- Schedule timeline (`../2026-04-24/volunteer-shift-schedule-timeline.spec.yaml`)
- Badge designer, wallet passes (2026-04-24 drafts)
- Per-role custom signup questions (generic-form-builder spec)
- Volunteer payouts or monetary compensation
