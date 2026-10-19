# Application-Driven Events + Place Rail — Deferred Backlog

> Companion to `application-driven-events.spec.md` and `place-admin-rail-context.spec.yaml`.
> Everything here was **found during implementation and deliberately not fixed** — each
> item names who found it and why it was deferred, so nothing evaporates into scrollback.

## Blocked on a decision (needs the user)

| Item | Why it's blocked |
| --- | --- |
| **Apply the new migrations to the dev DB** | Four migrations are written and verified against a scratch Postgres (Phase-1 `decisionReason`/`questionsSnapshot`; Phase-2 enum values + form window/cap/auto-approve; Phase-3 guest-dedupe index). The dev DB is db-push-managed and applying them goes through a seed wipe — per CLAUDE.md, that's a stop-and-ask, never an agent action. **Until this lands, none of the application work can be driven in the real app.** |
| **Live drive (dev-loop step 8)** | Place-rail surfaces need no schema change and can be driven as soon as the API is restarted (it was SIGTERM'd on 2026-08-08). Application surfaces are blocked on the row above. Minimum bar per CLAUDE.md: load the page, exercise the interaction, zero new console errors, 320px viewport. |

## Phase 5 — approval holds & queue ops (specced, not built)

The last phase of the application spec, deliberately sequenced last because it is
the concurrency/money-sensitive piece:

- **Approve with hold** — reserve `quantity × ticketType` for a hold window via the
  existing cart-hold machinery so approved applicants stop racing everyone at
  checkout; release to waitlist on expiry. Needs full-strength review (TOCTOU on
  capacity) plus a Codex second opinion per CLAUDE.md's high-stakes rule.
- **Bulk approve/reject** in the queue (server-side loop, one summary notification).
- **CSV export** of submissions (pattern: `export-event-attendees.ts`).
- **Funnel strip** — submitted / approved / converted counts from existing tables.

## Found during review, deferred with reasons

### Application system

| Item | Source | Note |
| --- | --- | --- |
| Soft cap can overshoot under concurrent submits | Phase-2 review | Read-then-create; bounded by concurrency. Documented at the check site. A hard cap needs a serializable tx or advisory lock on the form row. Deliberate: the cap is an organizer workload valve, not ticket inventory. |
| Approval-notify idempotency key is bare `submissionId` | Phase-1 review | Pre-existing; the Phase-1/2 keys are prefixed. Changing it would re-send to already-notified applicants. Align during a future notify sweep. |
| Transport/core bounds drift on `upsertEventApplicationQuestion` | Phase-1 review | Transport allows `label` ≤300 / `description` ≤1000; core requires ≤200 / ≤2000. A 250-char label passes transport and dies in core as generic `invalid_input`. Pre-existing. |
| Adapter CAS conflict throws a bare object literal | Phase-2 re-review | Non-`Error` throw → unhelpful Sentry frame if it ever escapes its single mapped caller. Mirrors `bookingRequests.updateStatus`; fix both together or neither. |
| Spanish status wording | Queue-UI review → **fixed** in Phase 2 | Filter chips are plural ("Aprobadas"); the single-row badge now uses dedicated singular keys. |
| Organizer email volume on high-traffic auto-approve events | Phase-2 review → **fixed** | `muteOrganizerEmail` disables only the organizer email leg when `autoApprove` is on; in-app + push still deliver. |

### Place rail

| Item | Source | Note |
| --- | --- | --- |
| `/edit` ↔ `/verify` draft loss | A3 review | Verification moved to its own surface, so fixing an eligibility reason ("City is required") now means navigating to Details, typing, and navigating back — and the unguarded 10-`useState` form silently discards the draft. Needs an unsaved-changes guard, which is form machinery the slice explicitly walled off. **The one real UX cost of Option B.** |
| Place-scoped bookings badge | A2 | `bookingRequests.countOpen` is org-scoped only (`{actorHumanId, orgId}` strict) and its per-venue output covers org-owned venues only, so a human-owned place would silently show no badge. Needs a filter param, not a new endpoint. Badge omitted for now per spec. |
| Rail renders place sections on a FORBIDDEN deep-link | A2 review | Sections build from the URL alone; the content area correctly shows the access card. Making the rail fall back to workspace sections would make context depend on query state — a deliberate design decision, not a patch. |
| `VerificationSection` residual hard-coded EN | A3 review → **fixed** | Extracted to `admin.placeVerif*` in both catalogs during the fix round, including an ICU plural for the reuse-docs count. |
| `AccountShell` is a third copy of the shell pattern | A1 exploration | Same disease the place tab bar had (local tab type, per-tab `matches()` predicates, no mobile variant). Migrating it onto `NavigationShell` is now cheap thanks to the context registry — separate decision. |

## Security findings deferred (from the Phase-3 security review)

| Item | Severity | Note |
| --- | --- | --- |
| **Guest applications are unconfirmed identity** | MEDIUM | An unauthenticated POST with `contactEmail: victim@example.com` sends that address an Ithas Fire-branded email, *and* squats the victim's open-application slot under the new guest unique index — the real owner then gets `APPLICATION_ALREADY_SUBMITTED` and cannot withdraw it (withdraw is authed and matches on `humanId`; the row is ownerless). The organizer's queue attributes attacker-authored answers to that address. **Proper fix: double opt-in** — hold the organizer notification and queue visibility until the guest confirms via emailed link, matching the posture checkout already takes. Mitigated for now by Turnstile (fail-closed) + rate limits, and by making a missing `TURNSTILE_SECRET_KEY` loud instead of a silent noop. |
| **Forwarded approval link mints a durable unlock for any signed-in account** | LOW | `redeemApplicationApprovalToken` persists an `EventUnlock` for whoever is signed in, with no relationship check, and the token is deliberately non-consuming with a 24h TTL — so one forwarded email unlocks the event for unbounded accounts for a day. Pre-existing and documented as deliberate. The *attach* guardrails (CAS on ownerless + verified matching email) are strictly tighter, which is the right asymmetry. Consider consuming-on-first-redeem, or scoping the persisted unlock to the submission's owner and letting others ride the cookie. **2026-09-30 → fixed (scoped to the subject).** The claim-link TTL went from 24h to **7 days** (owner decision), which made this worse, so the second option shipped: redeem now runs the ownerless-guest attach first, then persists the durable `EventUnlock` only when the viewer *is* the submission's subject (`submission.humanId === viewer`, or the attach just bound it to them). Any other signed-in clicker gets no durable grant, the same as an anonymous clicker (the claim route still sets its 24h signed cookie). The token stays non-consuming so link prefetchers can't burn it. Note: the APPLICATION gate does not honour that cookie today (see the KNOWN GAP comment on `isLockedByEventGate` in `apps/web/src/server/events.ts`), so a forwarded-link clicker who isn't the applicant is simply walled out. |
| **Rate limiter fails open on Redis error** | LOW | `consumeRateLimitOrAllow` allows the request when the limiter itself errors. Pre-existing, repo-wide posture — not specific to applications. |
| **`getGatedPreview` is wider than the new public endpoint** | LOW | It returns title/slug/hero for *any* event UUID with no status or visibility check, including DRAFT. Pre-existing debt; the new `getPublicApplicationForm` is strictly narrower and cites it as precedent. |
| **`onDelete: SetNull` can violate the guest unique index** | NIT | Deleting a Human nulls `humanId` on their open submissions; if a guest row already exists for the same `(eventId, lower(email))`, the FK action fails the constraint and the account deletion errors. Narrow, but account-deletion paths are compliance-sensitive. |
| **Attach frees the email side of the dedupe** | NIT | Once `attachSubmissionToHuman` sets `humanId`, the row leaves the guest index predicate, so the same person can hold two open applications. Cosmetic — the dedupe is a workload valve, not inventory. |

## Help Center

Per the application spec, articles are due after Phase 2 and again after Phase 4.
Deliberately written **once**, after templates land, so they describe final shipped
behaviour rather than being rewritten twice:

- `restrict-event-access.md` — rewrite: application window (opens/closes), submission
  cap, auto-approve, the Waitlist decision, applicant withdrawal + re-apply, choice
  questions, anonymous applicants.
- New article — application forms & templates (starter catalogue, save-as-template,
  fork-on-use semantics).
- `troubleshooting/faq.md` — "I withdrew my application by mistake".

Place-rail help drift was already swept during A2/A3 (`recruit-standing-volunteers.md`,
`booking-requests.md`, `faq.md` now describe the rail's Venue/Operate groups and the
Verification page).
