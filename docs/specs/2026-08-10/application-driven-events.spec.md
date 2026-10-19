# Application-Driven Events — Redesign

> Not built yet (2026-10-08 docs consolidation): Phase 5 (approval holds, bulk approve/reject, CSV export, funnel strip) not found

> **Status**: Draft
> **Created**: 2026-08-10
> **Supersedes/absorbs**: `docs/specs/2026-03-23/completed/generic-form-builder.component.yaml` (FormBuilder extraction folded into Phase 4 here)
> **Companion**: `place-admin-rail-context.spec.yaml` (same date — the context-registry work that keeps organizer surfaces on the shared rail)

## Where we actually are

An application-gated event feature is **already shipped end-to-end**: `Event.gateType = APPLICATION` (`event.prisma:332`), `EventApplicationForm`/`Question`/`Submission` (`application.prisma`), organizer builder (`ApplicationFormBuilder.tsx`, 770 ln), consumer gate (`EventApplicationGate.tsx` in `@th/ui`), review queue (`admin/[slug]/events/[id]/applications/page.tsx`), approval → `EventUnlock` → `ensureEventAccessible` in checkout (`checkout-helpers.ts:828-846`), claim-token cookie route, and one email (`ApplicationApproved.tsx`).

The redesign is therefore a **rework of an existing vertical slice**, sequenced so the live defects go first. The core architecture is sound and is deliberately kept:

- The gate is **orthogonal to attendance mode** — an application can sit in front of TICKETED *or* RSVP. We do **not** add a third `EventAttendanceMode`; that would mean auditing ~28 `attendanceMode === "RSVP"` guard sites for zero modelling gain. "Application-driven event" = `gateType: APPLICATION` + whatever attendance mode fits.
- `EventUnlock` stays the single source of truth for "can this person get in", keyed `(eventId, humanId)`, source-tagged.

## What's broken or missing (verified against code)

| # | Gap | Severity |
|---|-----|----------|
| 1 | `SINGLE_CHOICE`/`MULTI_CHOICE` **do not render** — `EventApplicationGate.tsx:305-307` prints "Choice questions coming soon", while the builder happily creates them and `submit-event-application.ts` accepts array answers. Organizers are shipping forms applicants can't complete. | P0, live dead-end |
| 2 | No rejection email (only `ApplicationApproved.tsx`), no submission-received ack, no organizer notification on new application (booking requests have all three). | P0 |
| 3 | No `decisionReason` on submission (BookingRequest has `declineReason`, required ≥3 chars). | P1 |
| 4 | `events.submitApplication` has **no rate limit and no captcha**; the anonymous booking embed already uses Turnstile. | P1 |
| 5 | Editing/deleting a question silently orphans historical `answers` Json — no snapshot discipline (waivers snapshot `version` + `bodyHash`). | P1 |
| 6 | No application window (open/close), no submission cap, no TTL/expiry sweep (`expire-booking-requests.ts` has no analogue). | P1 |
| 7 | Statuses only `PENDING\|APPROVED\|REJECTED` — no WITHDRAWN, WAITLISTED, EXPIRED. `WaitlistEntrySource.APPLICATION` exists but nothing writes it. | P1 |
| 8 | Anonymous applicants impossible in practice: `getApplicationForm` + `getViewerApplicationStatus` are `authedProcedure`, so the gate shows a sign-in CTA — even though the model supports `humanId: null` + `contactEmail` and the claim-token path handles guests. | P2 |
| 9 | No auto-approve (volunteers have `volunteerAutoApprove`). | P2 |
| 10 | Approval grants an unlock, then the applicant **races everyone at checkout** — no held allocation, no approve-into-tier. | P2 |
| 11 | **No templates** — every form is built from scratch; `EventTemplate.defaults` doesn't carry a form. | P2 (explicit ask) |
| 12 | Queue is per-row only (no bulk ops), no CSV export, no funnel numbers. | P3 |
| 13 | Unlock is gate-agnostic and non-evicting on `gateType` change (`get-event-gate-state.ts:77-82`). | Accepted behaviour — document, don't change (see D6) |

## Decisions

- **D1 — Gate, not mode.** Keep `gateType: APPLICATION` orthogonal to `EventAttendanceMode`. The organizer-facing language becomes "**Approval required**" with the attendance mode deciding what approval unlocks (checkout vs RSVP).
- **D2 — One form per event stays.** Per-track applications (artists vs vendors vs attendees on one event) are out of scope; templates make spinning up sibling forms cheap, and multi-form would fork the gate UX. Revisit only with a concrete event that needs it.
- **D3 — Answers snapshot at submit.** `EventApplicationSubmission` gains `questionsSnapshot Json` (id → `{label, type, options}` at submit time). Cheap, waiver-style integrity; the review queue renders from the snapshot, never from live questions.
- **D4 — Templates are snapshots, not references.** `ApplicationFormTemplate` stores `questions Json` (ordered array) + `introText`, follows the established `TemplateOwnerScope` pattern (`ownerId` null = platform catalogue), and **fork-on-use** copies rows into the event's form — exactly `fork-platform-ticket-template.ts`. No live link between template and event forms; editing a template never mutates shipped forms.
- **D5 — Anonymous applies ride the booking-embed pattern.** Public form read, Turnstile-protected guest submit, claim-token to attach identity later. The model already supports it; only transport + UI block it.
- **D6 — Unlock semantics stay gate-agnostic.** A PASSWORD unlock satisfying an APPLICATION gate is accepted (unlock = "this person is in"). Switching `gateType` keeps existing grants. Documented in help + code comment; revocation stays a manual per-submission rescind.
- **D7 — Holds are Phase 5 and optional per event.** "Approve with hold" reserves `quantity × ticketType` for `holdHours` (default 72) using the existing cart-hold machinery, releasing to waitlist on expiry. This is the piece that makes gated *paid* events not a race; it's also the riskiest (capacity concurrency), hence last.
- **D8 — FormBuilder extraction lands with templates.** The 2026-03-23 generic-FormBuilder draft is absorbed: Phase 4 extracts `FormBuilder`/`FormRenderer` (callback-driven, no hardcoded tRPC) because the template editor needs the builder outside the event context anyway. The `ApplicationQuestionType → FormQuestionType` enum rename from that spec is **dropped** (churn, no behavioural gain).

## Phases

Each phase independently shippable, in order of harm reduction.

### Phase 1 — Stop the bleeding (correctness & trust)

1. **Render choice questions.** Implement `SINGLE_CHOICE` (radio/select) and `MULTI_CHOICE` (checkboxes) in `EventApplicationGate.tsx`; validation for required choice answers; e2e over a form containing both.
2. **Notification triple**, mirroring booking requests (`notify-booking-request-received` pattern, idempotency keys per the notify-channel convention):
   - applicant ack on submit (`ApplicationReceived` email),
   - organizer notify on new submission (in-app + email),
   - decision emails: extend approved; add `ApplicationDecision` rejected variant (includes `decisionReason` when present). Build `ui-email` dist (footgun: silent `template_not_found`).
3. **`decisionReason String?`** on submission; review UI gets an optional reason field on reject (not required — unlike booking decline — because attendee-facing tone differs).
4. **Abuse guardrails**: rate-limit `submitApplication` (same budget as `redeemApplicationToken`), Turnstile when unauthenticated (prep for Phase 3; authed users skip it).
5. **`questionsSnapshot`** per D3; queue renders answers from snapshot.

### Phase 2 — Lifecycle

1. Form gains `opensAt DateTime?`, `closesAt DateTime?`, `maxSubmissions Int?`, `autoApprove Boolean @default(false)`.
   - Gate shows "applications open {date}" / "applications closed" states; closed also enforced server-side in `submit-event-application`.
   - `autoApprove` = instant APPROVED + unlock + ack email ("registration with questions" mode — parity with `volunteerAutoApprove`).
2. Status enum grows: `+ WITHDRAWN, EXPIRED, WAITLISTED`.
   - Applicant can withdraw while PENDING (parity with booking requests).
   - `WAITLISTED` decision in the queue writes an `EventWaitlistEntry` with `source: APPLICATION` (finally using the enum value) and links back via `metadata.submissionId`.
   - Nightly sweep job (jobs app, manifest entry) expires PENDING submissions past `closesAt + grace` — analogue of `expire-booking-requests.ts`.
3. Queue filter chips extend to the new statuses; `getViewerApplicationStatus` surfaces them to the applicant.

### Phase 3 — Anonymous applicants

1. `getApplicationForm` (definition only) and gate-state form payload become public-readable for APPLICATION-gated published events (form questions are not sensitive; submissions remain authed-or-tokened).
2. Guest submit: `contactEmail` required, Turnstile enforced, per-email dedupe (one open submission per event+email — partial unique index, same trick as booking requests' one-open-per-pair).
3. Approval for a guest sends the existing claim URL (`/api/events/{id}/claim?token=`) — already built; wire the email.
4. `EventApplicationGateWrapper` drops the sign-in CTA in favour of form-first with an optional "sign in to track your application" affordance.

### Phase 4 — Form templates (the explicit ask)

**Model** (new, in `application.prisma`):

```prisma
model ApplicationFormTemplate {
  id          String             @id @default(uuid())
  ownerScope  TemplateOwnerScope
  ownerId     String?            // null = platform catalogue
  name        String
  description String?
  introText   String?
  questions   Json               // ordered [{type,label,description?,options?,isRequired}]
  isPlatform  Boolean            @default(false)
  archivedAt  DateTime?
  createdByHumanId String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([ownerScope, ownerId, archivedAt])
}
```

**Use cases** (`packages/core/src/use-cases/application-form-templates/`): `list-` (own scope + platform catalogue), `create-` , `update-`, `archive-`, `apply-application-form-template.ts` (fork-on-use: seeds `EventApplicationForm` + question **rows**; refuses if the event already has submissions), `save-form-as-template.ts` (snapshot an event's current form up into the org's library).

**UI**: in the event builder's Access & privacy group, choosing the APPLICATION gate offers "Start from a template" (platform catalogue + org library) alongside "Start blank"; the form builder header gains "Save as template". Template management lives in the org workspace (Settings · Templates, beside ticket-type templates).

**FormBuilder extraction** (per D8): `FormBuilder` + `FormRenderer` become callback-driven shared components; `ApplicationFormBuilder` and the template editor are thin wrappers. Volunteer form migration onto them is **not** in scope (their `formSchema Json` shape differs) — noted as follow-up.

**Platform starter catalogue** (seeded, `isPlatform: true`; copy lives in the seed, i18n-keyed where rendered):

1. **Performer / artist application** — intro: "Tell us about your act — we book from these applications." Act name (SHORT_TEXT, req) · Tell us about your act (LONG_TEXT, req) · Genre (SHORT_TEXT) · Links to music or video (SHORT_TEXT, req) · Proposed set length (SINGLE_CHOICE: 15/30/45/60 min) · Played here before? (SINGLE_CHOICE: yes/no) · Anything else? (LONG_TEXT)
2. **Vendor / market stall** — Stall name (req) · What do you sell? (LONG_TEXT, req) · Booth needs (MULTI_CHOICE: table, power, tent space, indoor only) · Links to your work (SHORT_TEXT) · Permits/licences held (SHORT_TEXT)
3. **House show RSVP** — (Living-Room heritage, `2026-04-15/obsolete/living-room-mode.spec.md`) How did you hear about this? (SINGLE_CHOICE: friend of host, friend of performer, been before, other) · Who do you know here? (SHORT_TEXT, req) · Bringing anyone? (SINGLE_CHOICE: just me, +1, +2) · Message to the host (LONG_TEXT)
4. **Workshop / limited class** — Experience level (SINGLE_CHOICE: beginner/intermediate/advanced, req) · What do you want to get out of it? (LONG_TEXT, req) · Access or accommodation needs (SHORT_TEXT)
5. **Press / media accreditation** — Outlet (SHORT_TEXT, req) · Role (SINGLE_CHOICE: photographer, writer, video, podcast, other) · Recent coverage links (LONG_TEXT, req) · Planned coverage (LONG_TEXT)
6. **Guest list / private party** — Who invited you? (SHORT_TEXT, req) · Bringing anyone? (SINGLE_CHOICE: just me, +1, +2)

### Phase 5 — Approval holds & queue operations

1. **Approve with hold** (per D7, per-event opt-in): decision dialog gains ticket-type + quantity + hold window; approval creates a capacity hold via the existing cart-hold machinery, decision email says "complete checkout by {expiry}"; expiry releases the hold and (if WAITLISTED entries exist) promotes.
2. **Bulk approve/reject** in the queue (checkbox rows; reuses per-row use case in a loop server-side with one summary notification, not N).
3. **CSV export** of submissions (pattern: `export-event-attendees.ts`).
4. **Funnel strip** on the queue page: submitted / approved / converted-to-order counts from existing tables — no new analytics infra.

## Reviewer flags (carry into every phase)

- Money/capacity paths in Phase 5 → strong review + Codex second opinion (holds are concurrency-sensitive; TOCTOU on capacity).
- Every new swallow-site takes `reportError` (ReporterPort convention).
- Help articles `restrict-event-access.md` (rewrite) + a new "Application forms & templates" article via help-center-authoring; both after Phase 2 and again after Phase 4.
- i18n dual-catalog for every new string; argument-parity gate covers ICU args.
- Typecheck is two commands minimum (packages + each touched app's own tsc).

## Out of scope

- Per-track / multi-form events (D2), paid application fees, scoring/rubrics for reviewers, applicant messaging threads, volunteer-form migration onto FormBuilder, new question types beyond fixing the four (NUMBER/DATE/FILE etc. — future; templates deliberately use only shipped types).
