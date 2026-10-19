# Event Revenue Splits + Payout Terms UI

**Date:** 2026-04-26
**Status:** complete
**Priority:** P1 (Important)
**Depends on:** `Event`, `EventHuman`, `TicketType`, `Organization`, `Agreement`, `PayoutTerms`, `PayoutTermsLine`, `Payee`, existing `upsertAgreementShared`, Stripe Connect onboarding flow
**Supersedes:** Place-level default-payout-terms inputs added in `docs/specs/2026-04-26/places-admin-v2.spec.md` (those four fields get removed — see § Cleanup)

---

## Problem

The platform has the *plumbing* for ticket-revenue splits (`Event` → `Agreement` → `PayoutTerms` → `PayoutTermsLine` → `Payee`) but no surface that lets an organizer compose payout lines, the artists/promoters on a payout line have no way to confirm them, and the publish step has no gate ensuring everyone on the take has a working Stripe Connect account by the time tickets sell. Today that whole "who gets what" conversation lives in DMs and email; the platform just hopes the splits the organizer eventually types in match what was agreed verbally. We also can't represent merch revenue in the same model, even though POS-driven merch is a near-term roadmap item — without a model that already accommodates it, we'll re-litigate this whole architecture when the POS feature lands.

---

## Goal

Give organizers a single event-level payout-terms editor that composes lines for ticket revenue, resale margin, and (forward-looking) merch revenue. Notify each non-owner payee that they're on a line and give them the ability to acknowledge, counter, or decline — but treat confirmation as **informational, not a publish gate**. Gate `DRAFT → PUBLISHED` only on the splits being valid AND every line's payee having an active Stripe Connect account (because money has to actually be able to flow). Add an org-level default resale policy so the platform's most differentiated piece — clean resale economics — has a real surface. Stay strictly inside the boundary of money the platform actually controls (Stripe Connect = ticket revenue + resale margin + merch when POS lands). Explicitly do NOT model deal terms (guarantees, riders, hospitality) the platform can't enforce.

---

## Context

| What exists | Where |
|---|---|
| `PayoutTerms` (single-use, kind PRIMARY/RESALE, basis, lines) | `packages/db/prisma/finance.prisma:77` |
| `PayoutTermsLine` (payee, percent, floor, cap, priority, rounding, **optional `ticketTypeId` scoping**) | `packages/db/prisma/finance.prisma:117` |
| Fresh PayoutTerms minted per agreement | `packages/core/src/use-cases/agreements/_shared/upsert-agreement-shared.ts:320` |
| `Agreement` (proposer/counterparty + payoutTermsId) | `packages/db/prisma/agreement.prisma:5` |
| `Event.payoutTermsId` + `Event.resalePayoutTermsId` | `packages/db/prisma/event.prisma:271` |
| `EventHuman` lineup row (humanId, role, sortOrder) | `packages/db/prisma/event.prisma:71` |
| `TicketType` (already has `payoutTermsLines` relation) | `packages/db/prisma/ticket.prisma:43` |
| `Payee` (subjectType + subjectId, stripeAccountId, payoutsEnabled) | `packages/db/prisma/finance.prisma:10` |
| `Organization.defaultPrimaryPayoutTermsId` exists; no resale equivalent yet | `packages/db/prisma/org.prisma:5` |
| `Place.defaultPrimary/ResalePayoutTermsId` schema fields + just-added text-input UI | `apps/web/src/app/admin/[slug]/places/[placeId]/edit/page.tsx` |
| Connect status query | `trpc.stripeConnect.getStatus` |
| FeePolicy / platform fee | `packages/db/prisma/finance.prisma:38` |

**Pre-existing capability:** `PayoutTermsLine.ticketTypeId` is already nullable, with `null` meaning "applies to all ticket types under these terms" and a value meaning "applies only to this ticket type". Per-ticket-type overrides do not need a new model.

---

## Conceptual model (load-bearing)

Three concepts that keep getting tangled, kept distinct in this spec:

1. **Ownership** — `Event.orgId` / `Event.humanId`. Drives "Organized by …" attribution. Already structural.
2. **Lineup / roster** — `EventHuman` rows. Public who's-on-the-bill list. **Pure roster** — has no payment fields and never will. The lineup informs the payout-line *picker* (a convenient quick-pick list when adding payees) but the line itself is the only payment record.
3. **Payout participation** — `PayoutTermsLine[]` pointing at `Payee`s. The single source of truth for who gets paid out of each revenue stream. Confirmation lives here, not on the lineup.

Three legitimate sources for adding a payout line in the editor:

- **Owner** — auto-suggested at editor open: a line for `Event.orgId`/`humanId` resolved to that owner's Payee.
- **From lineup** — quick-pick: clicking a lineup row in the picker drops a line keyed to that human's Payee. The lineup row stays unchanged on either side; the line is just freshly added data.
- **Manual** — search any Human or Org and add a line. Sound engineer, booking agent, manager, co-promoter, the host's mom.

Plus the platform fee, applied implicitly via `FeePolicy` — never an editable line.

---

## Three revenue streams, one model

Each event can have up to three payout terms, each with their own line list:

| Stream | FK on Event | `PayoutTerms.kind` | Status today |
|---|---|---|---|
| Ticket revenue | `payoutTermsId` | `PRIMARY` | Built; needs UI |
| Resale margin | `resalePayoutTermsId` | `RESALE` | Built; org default + per-event UI new |
| Merch revenue (future) | `merchPayoutTermsId` (NEW, optional) | `MERCH` (NEW enum value) | Schema-only; UI + POS integration deferred |

Adding `MERCH` and `Event.merchPayoutTermsId` now means when POS-driven merch lands, the organizer's existing payout-line composer just gains a third tab. No re-architecture of the financial model.

---

## Three-layer ticket revenue split

For PRIMARY (ticket) terms only:

1. **Event-level default split** — top-level allocation across the line list. `PayoutTermsLine` rows with `ticketTypeId IS NULL`.
2. **Per-ticket-type override** — uses the existing `PayoutTermsLine.ticketTypeId` scoping. When a TicketType has any override lines on the same `payoutTermsId`, those completely replace the default lines for that type's revenue. ("For VIP, ignore the default lines and use these instead.")
3. **(no third layer)** — the payout shares for individual performers are just regular lines, sourced via the lineup picker. There is no separate per-lineup-member layer.

For RESALE: only the event-level layer applies (no per-ticket-type override; resale economics are uniform across ticket types).

For MERCH (deferred build): same single-layer shape — one line list applied to all merch revenue at the event. **No per-product scoping** ("this t-shirt has its own split"). Merch is just merch; the organizer composes one set of payees once. This decision is firm — `PayoutTermsLine.ticketTypeId` stays the only scope dimension on the model.

---

## Resale margin policy (org-level default)

`Organization` gains default resale-margin policy fields. These default into `Event.resalePayoutTermsId` at event creation. Per-event override allowed. This is the most genuinely differentiated piece — clean, transparent resale economics is rare on competing platforms.

---

## Data Model

### `PayoutTermsKind` — extend

```prisma
enum PayoutTermsKind {
  PRIMARY    // ticket revenue
  RESALE     // resale margin
  MERCH      // NEW: merchandise revenue (POS-driven; UI deferred)
}
```

### `Event` — additions

```prisma
model Event {
  // ... existing fields ...

  /// FK to the merch-revenue payout terms. Null until POS goes live and the
  /// organizer composes a merch split. Schema-only for now — no use case
  /// reads or writes this in v1.
  merchPayoutTermsId String?
  merchPayoutTerms   PayoutTerms? @relation("EventMerchPayoutTerms", fields: [merchPayoutTermsId], references: [id])
}
```

### `PayoutTermsLine` — additions

A line tracks acknowledgement state from its payee — **for transparency and audit, not as a publish blocker**. A line "requires acknowledgement" when its payee is **not** the owning party (org or human owner of the event). Owner lines auto-stamp `requiresConfirmation = false`; everyone else's line starts in `PENDING` and a notification fires.

```prisma
model PayoutTermsLine {
  // ... existing fields (id, payoutTermsId, payeeId, ticketTypeId, percent, floorCents, capPercent, priority, rounding) ...

  /// True when this line's payee is someone other than the event/agreement
  /// owner. Owner lines flip this to false (auto-confirmed). Computed and
  /// stamped at line creation; not user-editable.
  requiresConfirmation Boolean @default(false)

  /// Confirmation lifecycle. Null when requiresConfirmation = false.
  /// PENDING → invited but no decision; CONFIRMED → payee confirmed share;
  /// COUNTERED → payee proposed a different share, event back to draft;
  /// DECLINED → payee refused.
  confirmationStatus PayoutLineConfirmationStatus?

  /// When the payee confirmed. Reset to null whenever percent/floor/cap
  /// change after first confirmation, forcing re-confirm.
  confirmedAt DateTime?

  /// Optional counter-share (in basis points) attached to a COUNTERED row.
  counterPercentBps Int?

  /// Free-form counter-offer message. Required (≥10 chars) when COUNTERED.
  counterNote String?

  @@index([payoutTermsId, confirmationStatus])
}

enum PayoutLineConfirmationStatus {
  PENDING
  CONFIRMED
  COUNTERED
  DECLINED
}
```

### `EventHuman` — no changes

Lineup stays as roster. No payout fields, no confirmation status, no setup-required gating.

### `Organization` — no schema changes

The existing `Organization.defaultResalePayoutTermsId` FK is the storage mechanism. `setOrganizationResalePolicy` creates or updates a long-lived `PayoutTerms` row (kind=RESALE) keyed off this FK. That template row encodes only:
- `resaleSellerMarkupShareBps` (existing field) — % the original buyer keeps
- `resalePayoutReleaseDays` (existing field) — release window

The template **has no lines.** Lines are event-specific (they reference Payees that depend on which org/lineup is involved), so they're composed when the organizer opens an event's Resale tab. This sidesteps the "what Payee do we point at if Connect isn't set up yet?" chicken-and-egg.

When an event is created with any resale-allowed TicketType, the event's `resalePayoutTermsId` is minted by copying the org's template's seller share + release days into a fresh single-use PayoutTerms; the event editor then surfaces an empty resale line list for the organizer to fill in. Per-event edits never touch the org's template; subsequent org-level changes never touch already-created events. The "frozen at creation" decision is enforced by the copy.

**Why no PayoutTermsTemplate?** Tabled. `PayoutTerms` stays single-use per event. Each event keeps minting its own draft inside `upsertAgreementShared`.

---

## Use Cases

All in `packages/core/src/use-cases/`. Stateless factory pattern, Zod input/output, typed error codes (`invalid_input | forbidden | not_found | conflict | rate_limited | dependency_failed | transient`), single `repos.tx()` per mutation, idempotency on money-shaping mutations.

### `getEventSplits` — new

The composite read for the event editor's Splits section.

**Input:** `{ actorHumanId, eventId, kind: "PRIMARY" | "RESALE" }` (MERCH not yet readable in v1)
**Output:**
```ts
{
  terms: { id, basis, totalAllocatedBps },
  lines: Array<{
    id, payeeId, payeeKind: "org" | "human",
    payeeDisplayName, payeeStatus: "missing" | "pending_setup" | "active",
    ticketTypeId | null, ticketTypeName | null,
    percentBps, floorCents, capPercent, priority,
    source: "owner" | "lineup-picker" | "manual",  // derived: owner if payee == event owner; "lineup-picker" if payee humanId matches an EventHuman.humanId; otherwise "manual"
    requiresConfirmation, confirmationStatus, confirmedAt,
    counterPercentBps, counterNote,
  }>,
  platformFeeBps: number,
  publishGateBlockers: string[],
  // Quick-pick suggestions for the line picker — derived, not a separate model.
  lineupSuggestions: Array<{
    eventHumanId, humanId, displayName, role,
    payeeStatus: "missing" | "pending_setup" | "active",
    alreadyOnTerms: boolean,
  }>,
}
```

**Auth:** event editor (org member with edit-event scope OR human-owned event's owner).
**Error codes:** `not_found | forbidden`.

### `updateEventSplits` — new

Authoritative writer for payout lines on a given `kind`. The owner line is synthesized — passing it in input is allowed but the use case will collapse it into the auto-managed line and ignore caller-provided IDs for it.

**Input:**
```ts
{
  actorHumanId, eventId, kind: "PRIMARY" | "RESALE",
  lines: Array<{
    id?: string,
    payeeRef: { kind: "org" | "human", id: string },
    ticketTypeId: string | null,        // ignored when kind != "PRIMARY"
    percentBps: number,
    floorCents: number,
    capPercent?: number | null,
    priority: number,
  }>,
  clientKey: string,
}
```

**Behavior:**
1. Resolve each `payeeRef` to a `Payee` (creating the row if the org/human exists but has no Payee yet — Connect onboarding is a separate flow that flips `payoutsEnabled`).
2. Inside one `repos.tx()`:
   - Diff incoming lines against existing lines on the event's PayoutTerms of the given kind.
   - Stamp `requiresConfirmation = (payee.subjectType, subjectId) != event-owner` on each new/changed line.
   - Owner lines: `requiresConfirmation = false`, `confirmationStatus = null`, no confirmation flow.
   - Non-owner lines: when newly created → `confirmationStatus = PENDING`, fire notification. When share/floor/cap changes on an existing CONFIRMED line → reset to `PENDING` + clear `confirmedAt` + re-fire.
3. Reject if the running total (manual + owner + platform fee on the chosen `basis`) does not reconcile to 100% within ±1 bps. Reject TicketType-scoped lines for `kind != "PRIMARY"`.
4. Idempotency keyed by `(eventId, kind, clientKey)`.

**Auth:** event editor.
**Error codes:** `invalid_input | forbidden | not_found | conflict`.

### `confirmPayoutLine` — new (v1: CONFIRM only; COUNTER + DECLINE deferred)

The payee-side action handler. **Acknowledgement is not a publish gate** — it's a transparency mechanism.

**v1 ships:** CONFIRM only. The schema scaffolding for COUNTER and DECLINE (enum values, `counterPercentBps`, `counterNote`, the use-case branches) is included so we don't migrate the model again later, but the UI surfaces only the "Looks good" path. Counter and Decline buttons are not rendered in v1.

**Input:** `{ actorHumanId, payoutTermsLineId, decision: "CONFIRM" | "COUNTER" | "DECLINE", counterPercentBps?, counterNote? }`
**Behavior:**
1. Validate the actor owns the line's Payee (i.e., the actor is the human or an org admin whose org's Payee this line points at).
2. CONFIRM (v1): sets `confirmationStatus = CONFIRMED`, stamps `confirmedAt = now()`. Does NOT require `payoutsEnabled = true` — confirming is informational; Connect activation is a separate concern enforced by the publish gate.
3. COUNTER (deferred — code path stubbed): would require `counterPercentBps` and `counterNote` (≥10 chars), set `confirmationStatus = COUNTERED`, transition a `PUBLISHED` event back to `DRAFT`, and notify the owner. v1 returns `not_implemented` if invoked; the API surface accepts the input shape so client code can be written against the eventual contract.
4. DECLINE (deferred — code path stubbed): would mark `confirmationStatus = DECLINED`, treat as zeroed in reconciliation, transition a `PUBLISHED` event back to `DRAFT`. Same `not_implemented` v1 behavior.

**Auth:** the payee's owning human (or org admin for org payees). No co-admin override on personal Payees — acknowledgement is personal.
**Error codes:** `invalid_input | forbidden | not_found | conflict | not_implemented` (v1; latter drops when COUNTER/DECLINE land).

### `setOrganizationResalePolicy` — new

Creates or updates the org's long-lived RESALE `PayoutTerms` template row keyed off `Organization.defaultResalePayoutTermsId`. The template encodes only seller share + release window (no lines).

**Input:** `{ actorHumanId, orgId, sellerMarkupShareBps: number, payoutReleaseDays?: number | null }`
**Behavior:**
1. Validate `0 ≤ sellerMarkupShareBps ≤ 10000`.
2. Inside `repos.tx()`: upsert the org's defaultResalePayoutTerms — if the FK is set, update fields via `repos.payoutTerms.updateDraft`; if not, create a new RESALE PayoutTerms via `repos.payoutTerms.createDraft`, then update the org's `defaultResalePayoutTermsId`.
3. Audit-log the change.

**Auth:** org `OWNER` or `ADMIN` via `requireOrgRole`.
**Error codes:** `invalid_input | forbidden | not_found`.

### `assertEventPublishable` — extend (existing publish path)

Add three blockers to the existing publish gate:

1. `splits_total_invalid` — the event's PRIMARY PayoutTerms doesn't reconcile (after applying owner + manual lines + platform fee, treating any DECLINED line as zero).
2. `payee_not_active` — at least one PRIMARY (and RESALE, when present) line's Payee has `payoutsEnabled != true`. Error `data.lineIds[]` enumerates the offending lines. This is the only payee-side block: money has to actually be able to flow.
3. `resale_terms_missing` — `Event.resalePayoutTermsId` is null AND the org has no default resale policy AND any TicketType has `resaleAllowed = true`.

**Acknowledgement state is NOT a publish blocker.** A PENDING line publishes fine; the payee can still come along later and CONFIRM, COUNTER (kicks back to DRAFT), or DECLINE (also kicks back to DRAFT, since the line zeroes).

MERCH terms are NOT a publish blocker — the column is schema-only in v1.

### `removeLineupRow` — extend (existing)

Removing an `EventHuman` no longer touches payout lines (since they're independent). However, surface a UI warning in the lineup section: "This person has a payout line on this event — remove that line first if you don't want them paid." The use case itself stays minimal.

### `submitEventForReview` (or equivalent draft validation) — extend

Returns the same `publishGateBlockers` list early so the editor can render a permanent "what's blocking publish" sidebar without waiting for the publish click.

### `inviteLineupHumanToRegister` — new

Lets an organizer "upgrade" a free-text lineup row (`externalName` set, `humanId` null) into a registered Human + Connect onboarding invite. Once the invitee accepts and finishes Connect, they automatically appear in the payout-line picker for that event.

**Input:** `{ actorHumanId, eventHumanId, email: string, displayName?: string }`
**Behavior:**
1. Validate the actor can edit the event and the lineup row is currently free-text.
2. Call `repos.humans.ensureGuestHuman({ email, displayName })` — returns either an existing Human (by email) or a freshly-created shadow Human.
3. Set `EventHuman.humanId = result.humanId`. Keep `externalName` if it differs from the registered display name (so the public lineup keeps the stage name).
4. Send a transactional email + in-app notification: "[Organizer] added you to [Event]'s lineup. Set up payouts to receive a share of ticket revenue." Deep-link to Connect onboarding.
5. Idempotent on `(eventHumanId, email)` — re-invoking with the same email re-sends the invite without duplicating the Human.

**Auth:** event editor.
**Error codes:** `invalid_input | forbidden | not_found | conflict`.

### `getPlaceForEdit` / `updatePlace` — revert

`phone` and `website` are KEPT. Remove `defaultPrimaryPayoutTermsId` and `defaultResalePayoutTermsId` from output and input. Place editor's "Contact & directory" card drops the two payout-terms text inputs.

---

## UI / Flow

### A. Event editor — new "Splits" section

Sits between the lineup section and the publish/save bar. Tabs across the top: **Tickets** (PRIMARY) / **Resale** (RESALE) / *(Merch — disabled, "Available when POS goes live")*. The Tickets tab is the v1 focus; Resale is a smaller form (no per-ticket-type, plus the org-default-imported notice); Merch tab is a placeholder.

#### A1. Header banner

- Running pill: `Allocated 95% + Platform 5% = 100%`. Green when reconciles; red with off-by-N-bps hint otherwise.
- Status badge "Splits ready" / "N items blocking publish" linking to the blocker list.

#### A2. Line table

Six columns: Payee · Source · Scope · % · Floor · Status. Source values:
- **Owner** — auto, padlock icon, no confirmation badge.
- **From lineup** — derived label when the line's payee humanId matches an `EventHuman.humanId`. Editable like any manual line.
- **Manual** — drag handle for priority, full-edit.

The Status column shows a small confirmation badge (PENDING / CONFIRMED / COUNTERED / DECLINED) for any line where `requiresConfirmation = true`. Owner lines show "—".

#### A3. Add-line picker

Modal. Top section: **From lineup** — quick-pick chips for every `EventHuman` row that isn't already on the terms. Clicking a chip drops a line with that human's Payee at 0% (organizer fills in the share). Free-text lineup rows (no `humanId`) are NOT shown — payout lines need a registered Human.

Bottom section: **Search Human or Org** — typeahead by name/email. Adds a line with the chosen Payee.

When the chosen Payee has no Stripe Connect / `payoutsEnabled = false`, the line is added but renders an amber "Payee setup pending" inline note + a "Send setup invite" link. The line is still saveable; it just can't pass the publish gate until the Payee comes online.

#### A4. Per-ticket-type override disclosure (PRIMARY tab only)

Collapsed by default. When expanded, shows each TicketType with a toggle "Use custom split for VIP". Toggling on opens a scoped line table where every row carries `ticketTypeId = <this type>`. The default lines stay editable above. Clear visual: which lines apply to which type is filtered by the active disclosure tab.

### B. Event editor — Lineup section (no payout UI)

Lineup stays as it is today: humans, roles, sortOrder. No "% of payout" toggle, no Connect status indicator, no setup-required gating on lineup add. Adding someone to the lineup never blocks.

Two small additions:

- **Free-text rows get an "Invite to set up payouts" CTA.** Clicking it opens a small inline form (email + optional display name) that calls `inviteLineupHumanToRegister`. The row visually upgrades — externalName collapses to a sub-line, the registered name takes the lead, and a "PENDING SETUP" badge appears until the invitee finishes Connect onboarding. After that, they show up automatically as a quick-pick chip in the payout-line picker.
- **Removing a lineup row whose human has a payout line** surfaces a confirmation dialog ("They're still on the payout terms — remove that too?") with a checkbox to also remove the line. The two stay independent decisions; the dialog just nudges the right cleanup.

### C. TicketType form — handled by Splits section's per-type disclosure

No separate per-ticket-type splits form. The disclosure inside the Splits section is the canonical surface — keeping TicketType edit lean.

### D. Org settings — new "Resale policy" page

Route: `/admin/[slug]/settings/resale-policy`. Single form:
- Three percent inputs (Venue / Artist pot / Original buyer) summing to 100%.
- Optional release-window override.
- Save calls `setOrganizationResalePolicy`.
- Sidebar "Currently using" — either saved values or "Platform default (10/30/60, 7-day release)".
- Help copy on each share's meaning.

### E. Payee acknowledgement page

Route: `/payouts/acknowledge/[lineId]?token=<...>` (signed token in the email link; also reachable from in-app notifications when authenticated). The page is informational — the event can publish without the payee ever visiting it.

- Header: "[Event title] is paying you X% of [ticket revenue / resale margin]".
- Body: event date/place, the line's terms (percent, floor, cap, scope if ticketTypeId), payee identity ("Paying out to: Your Connect account · Active" or amber pending-setup state with onboarding link).
- **v1 button:** **Looks good** (CONFIRM — informational ack). Counter and Decline are deferred and not rendered in v1; the page can show a small "Disagree with these terms? Reach out to the organizer directly for now" footnote so payees aren't left with no recourse.
- **Future buttons (deferred):** Counter (inline percent + ≥10-char note; pauses publish) and Decline (zeroes the line; pauses publish).

Confirm is purely an audit signal — it changes nothing about the event's publishability.

### F. Place editor cleanup

Remove the two payout-terms text inputs from the "Contact & directory" card. Drop matching state, dirty-tracking, and `defaultPrimary/ResalePayoutTermsId` fields from the `upsertPlace` mutation invocation. `getPlaceForEdit` output schema loses them. Schema columns on `Place` remain (other code may still key off them) but become unused-by-the-editor.

### G. Notification surfaces

- Line invited / changed → email + in-app to the payee with confirm-page link.
- Counter received → email + in-app to event owner with counter percent + note.
- Confirmed → in-app to event owner.
- Connect setup completed (existing event) → re-opens the confirm page if the payee bounced earlier.

---

## Acceptance Criteria

### Schema

- [ ] `PayoutTermsKind` enum gains `MERCH`.
- [ ] `Event.merchPayoutTermsId` (nullable FK to `PayoutTerms`) added.
- [ ] `PayoutTermsLine` has `requiresConfirmation`, `confirmationStatus`, `confirmedAt`, `counterPercentBps`, `counterNote`.
- [ ] `PayoutLineConfirmationStatus` enum (PENDING / CONFIRMED / COUNTERED / DECLINED).
- [ ] `Organization.defaultResalePayoutTermsId` is the storage mechanism (already in schema; no new fields). `setOrganizationResalePolicy` creates the long-lived template PayoutTerms row.
- [ ] **No** schema changes to `EventHuman`. Lineup stays roster-only.
- [ ] Migration is non-destructive; existing PayoutTermsLine rows get `requiresConfirmation = false` (their payees were the event owner historically; we'll re-stamp lazily as terms are edited).

### Use cases

- [ ] `getEventSplits` returns lines with derived source labels, payee status, confirmation state, lineup suggestions.
- [ ] `updateEventSplits` reconciles total to ±1bps, stamps `requiresConfirmation` correctly, resets confirmation on share-changing edits.
- [ ] `updateEventSplits` rejects `ticketTypeId` on RESALE/MERCH writes.
- [ ] `confirmPayoutLine` v1 accepts CONFIRM (no Connect-active requirement; informational only). COUNTER and DECLINE branches return `not_implemented` but accept the input shape and have schema state available for the eventual implementation.
- [ ] `setOrganizationResalePolicy` validates shares sum to 10000 bps; gated by org OWNER/ADMIN.
- [ ] `inviteLineupHumanToRegister` upgrades a free-text lineup row to a registered Human via `ensureGuestHuman`, sends a Connect-onboarding invite, and is idempotent on `(eventHumanId, email)`.
- [ ] `assertEventPublishable` blocks publish when splits don't reconcile, when any line's payee has `payoutsEnabled != true`, or when resale terms are required but missing. Acknowledgement state never blocks.
- [ ] DECLINED lines are treated as zero in total reconciliation but the row is preserved for audit.
- [ ] MERCH terms never trip the publish gate.

### UI

- [ ] Event editor has a Splits section with three tabs (Tickets / Resale / Merch-disabled), running-total banner, line table, per-ticket-type override disclosure on Tickets tab only.
- [ ] Add-line picker shows lineup quick-pick chips + Human/Org search; never shows free-text lineup rows.
- [ ] Lineup section has no payout UI on registered rows; free-text rows get an "Invite to set up payouts" CTA that triggers `inviteLineupHumanToRegister`. Upgraded rows show "PENDING SETUP" until Connect onboarding completes, then surface as quick-pick chips in the payout-line picker.
- [ ] Removing a lineup row whose human has a payout line surfaces a confirm-also-remove dialog.
- [ ] Org settings has "Resale policy" page enforcing 100% sum.
- [ ] New events inherit org default resale policy; per-event override editable from Splits section.
- [ ] Payee acknowledgement page reachable via signed email token AND in-app notifications. v1 surfaces only the "Looks good" CONFIRM button + a "reach out to the organizer directly to disagree" footnote. Counter/Decline UI deferred.
- [ ] Place editor's payout-terms text inputs removed; `getPlaceForEdit` and `updatePlace` no longer expose those fields.

### Cross-feature

- [ ] Confirmation flow notifications (invited / countered / confirmed) wired through the existing notifications repo.
- [ ] Publish gate blockers surface in event editor's permanent "What's blocking publish" sidebar.
- [ ] Audit log captures every confirmation transition + every resale-policy change.

---

## Decisions (locked)

- **Platform fee is implicit.** Comes from the active `FeePolicy`, folded into running-total math, never an editable line. Surfaced in the banner ("Allocated 95% + Platform 5% = 100%").
- **Acknowledgement is informational, not a publish gate.** Payees get notified and can CONFIRM ("Looks good") in v1. COUNTER and DECLINE are scaffolded in schema + use-case stubs but the UI/behavior is deferred — when they ship, they'll kick the event back to DRAFT. PENDING never blocks publish.
- **Connect-active IS still a publish gate.** A line whose payee can't actually receive money blocks publish — different concern from acknowledgement.
- **DECLINED lines stay in the row** with `confirmationStatus = DECLINED` and are treated as zero for reconciliation. The audit trail of "they were offered X% and declined" survives. (Behavior ships when DECLINE lands.)
- **Counter scope is inline percent + free-text note.** Editing other lines from the payee side is out. (Ships when COUNTER lands.)
- **Lineup→line linkage is derived, not persisted.** `getEventSplits` matches `payee.subjectId` against `EventHuman.humanId` to label source as "lineup-picker". No FK on `PayoutTermsLine`.
- **Merch is one line list, no per-product scoping.** "This shirt has its own split" is explicitly out of scope — now and later.
- **Resale policy is frozen at event creation.** Org-level changes only affect new events; existing events keep their stamped values.
- **Multi-org / co-promoted events: no first-class feature.** A co-promoter org just gets added as a manual payout line by the event owner — that's the entire interaction surface in this spec. The line they're on is theirs; they don't get edit access to the rest of the event. Event-level co-authorship/co-ownership is a separate gap (see § Known Gaps below) and is NOT solved here.
- **Free-text → registered Human upgrade flow ships.** `inviteLineupHumanToRegister` lets an organizer invite a free-text lineup name to register + onboard Connect; once they accept, they auto-appear as a payout-picker chip. The lineup row stays the same EventHuman record — `humanId` just gets stamped.
- **No EventMode-specific carve-outs.** The resale publish blocker is purely a function of `TicketType.resaleAllowed`. If no ticket type allows resale, the blocker doesn't trip — for any event of any mode. EventMode plays no role in this spec, in line with the broader move toward feature toggles over hard modes.
- **DECLINE rebalance: support both paths.** When DECLINE lands, the organizer gets a manual "rebalance the remaining lines yourself" path (default) AND a one-click "Redistribute proportionally to remaining payees" button. Both ship.

## Known Gaps (not solved here, called out for visibility)

- **Event co-authorship / co-ownership.** Today an event has exactly one owner (`Event.orgId` XOR `Event.humanId`). Multi-org co-promotion in any meaningful sense (shared edit access, joint settlement reporting, both orgs visible as co-organizers on the public page) requires a real co-owner model that doesn't exist yet. This spec sidesteps the gap by treating co-promoters as payout-line recipients only. A dedicated co-ownership spec is a follow-up.

## Open Questions

(none remaining — all four prior questions are resolved in § Decisions above)
