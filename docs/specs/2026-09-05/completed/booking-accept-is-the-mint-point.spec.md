# Accept Is The Mint Point

> Superseded by docs/specs/2026-09-25/booking-the-night.spec.yaml (2026-10-08 docs consolidation)

**Date:** 2026-09-05 (revised 2026-09-06, corrected against the build 2026-09-09)
**Status:** partly built. **Mint point superseded 2026-09-25** by `docs/specs/2026-09-25/booking-the-night.spec.yaml`: the event is created when the act agrees the terms (or when a venue books without terms on a night the pitch asked for), not at the venue's request accept. FR-002's retirement of `bookingHolds.confirm` from the request flow is adopted there as N4; P-1..P-3 and FR-006 stay useful.
**Priority:** P1 (Important)
**Build state (2026-09-09):** P-1 `0fbb7661`, P-2 `87067393`, P-3 `6f423a16`, FR-004 `6aaae426`, and the accept mint `ec8544c5` are landed, each with no production caller. FR-006's derivation landed with the mint; retiring the second derivation belongs to FR-001. FR-001, FR-002, FR-003, FR-007, FR-008 and every UI change are not started.
**Depends on:** `BookingRequest`, `BookingHold`, `Agreement`, `Event`, `PlaceOwnership`; specs/2026-08-25/completed/booking-holds.spec.yaml, specs/2026-07-14/completed/booking-conversation-and-event-step.spec.yaml
**Supersedes:** the confirm half of booking-holds FR-008 (the hold-confirm entry point; the line-taking mechanics survive intact)

---

## Problem

Two things mint an event from a booking, and they disagree about the date.

`confirmBookingHold` anchors the event on the **hold's** night. `createEventFromAgreement` anchors it on the agreement's `proposedDate`, falling back to the request's **first preferred date**. The second is a known defect, documented in the code that papers over it:

> `createEventFromAgreement` seeds the event's start from the act's FIRST preferred date, which is frequently not the night the two sides settled on in the thread — a real booking agreed Sep 25 in conversation and produced an event dated Sep 18, silently.
> — `apps/web/src/components/bookings/booking-stage-rail.ts:81-88`

The `dateOffPitch` flag on the stage rail exists solely so a venue can catch that from a list row. From the inbox, "what actually makes the event" is unanswerable.

Confirm also buys less than it appears to. FR-018 (`settleHeldDatesForPublishedEvent`) already runs `takeLine` **inside the publish transaction** — the winning hold is confirmed and competitors released whether or not anyone pressed Confirm. Confirm's only unique contribution is doing it earlier, and it pays for that by being a second mint route.

---

## Goal

One path from booking to event. Holds are the shortlist; **accept is the pen**. A venue accepts a request against a chosen held date, and that single action accepts the request, mints the agreement, takes the line, and creates the draft event — atomically. If any part fails, none of it happened. And once accepted, the agreement and the event are one booking: cancel either and both go.

---

## Context

| What exists | Where |
|---|---|
| Hold confirm (tx1 + post-commit mint, the route being retired) | `packages/core/src/use-cases/booking-holds/confirm-booking-hold.ts` |
| The accept body, already extracted as a tx participant | `packages/core/src/use-cases/booking-requests/_shared/accept-in-tx.ts` |
| Line-taking mechanics (confirm winner, release siblings + competitors) | `packages/core/src/use-cases/booking-holds/_shared/take-line.ts` |
| The other mint route | `packages/core/src/use-cases/booking-agreements/create-event-from-agreement.ts` |
| FR-018: publish already takes the line | `packages/core/src/use-cases/booking-holds/settle-held-dates-for-published-event.ts` |
| The event save all mints run through | `packages/core/src/use-cases/events/_shared/save-event-shared.ts` (`finalizeSaveEvent`) |
| The same save, joined to a caller's transaction (FR-004) | same file, `finalizeSaveEventInCallerTx` |
| The accept mint FR-001 calls (FR-004b) | `booking-requests/_shared/accept-mint.ts` |
| Who a booking is owned by (FR-006) | `booking-requests/_shared/venue-booking-party.ts` (`deriveVenueBookingParty`) |
| Counterparty derivation for the agreement — see FR-006 | `_shared/accept-in-tx.ts` (`deriveCounterparty`) |
| Agreement cancel (CASes on `expectEventIdNull`; orphans the draft) | `booking-agreements/cancel-booking-agreement.ts` |
| The three accept surfaces | `components/bookings/BookingInbox.tsx`, `admin/[slug]/bookings/_components/OrgReceivedRequestsTable.tsx`, `account/settings/_components/ReceivedBookingRequestsList.tsx` |
| Holds strip UI (loses Confirm) | `apps/web/src/components/bookings/BookingHoldsStrip.tsx` |

### Verified facts this spec is built on

- `repos.tx` always opens a **fresh** interactive transaction off the root Prisma client and `TxRepos` has no `tx` member — nesting is a type error by construction, and calling it inside a transaction would open a second connection that blocks on the first's advisory locks. `packages/adapters/src/db/prisma/index.ts`
- **A live third-party HTTP call ran inside the save transaction** — `resolveEventTaxRate` reaching `ziptax-adapter.ts`, a `fetch` to `api.zip-tax.com` with a 5-second timeout, with production wiring the raw adapter and no memoization. **Fixed by P-1**: `prepareEventTaxRate` now runs before the transaction opens and only the stamp happens inside it. Still in-tx elsewhere, out of scope here: `publish-event.ts`, `update-event-settings.ts`, `orders/_shared/resolve-checkout-tax-rate.ts`, `places/upsert-place.ts`.
- `materializeSections` was a doubly-nested loop doing **one round trip per seat**, with no cap on seat count anywhere in the layout pipeline. **Fixed by P-2.**
- `repos.tx` hardcoded `timeout: 30_000` for every caller. **Fixed by P-3**: an optional per-call `{ timeout, maxWait }`, same defaults.
- Notification intents are minted in-tx as **data**, returned, and dispatched by the tRPC router only after the use case resolves (`routers/booking-holds.ts`). Dispatch failure is swallowed at two levels, both with `reportError` per the repo's Sentry convention.
- **Live bug this change fixes for free:** when the post-commit mint throws today, competitors are already released in the database but `result` is never assigned, so the router never dispatches — losing acts are bumped off a date with no notification. The documented healing re-run skips tx1 and returns `intents: []`, so those notifications are lost permanently. `confirm-booking-hold.ts`
- The owned venue-accept path currently notifies the act of **nothing** — it returns `{bookingRequestId, status, agreementId}` and dispatches nothing. `respond-to-booking-request.ts`
- `BookingHold.spaceId` is nullable (`agreement.prisma`) and the 2026-08-31 ruling removed the space select from the hold picker: a hold is a date on a calendar, and the room was to be chosen "at confirm, on the draft event". With confirm gone, that choice has no home unless this spec gives it one.
- The DB enforces **one `CONFIRMED` hold per line** (partial unique, `agreement.prisma`). A `CONFIRMED` hold whose booking has died therefore makes its date unbookable by anyone until it is released.
- `deriveVenueCounterpartyFromPlace` picks the **lexicographically smallest** human owner (`accept-agreement.ts`). Copied as-is into the accept path it would make co-owner B's accept mint under co-owner A and then refuse B's own mint with `NOT_RESOURCE_OWNER`.
- `finalizeSaveEvent` has **4** call sites, not 3 — `save-event-for-human.ts`, `save-event-for-org.ts`, `create-human-event.ts` and `create-event-from-agreement.ts`. The fourth is the existing mint from an agreement, which is the one most likely to break. `saveEventForOrg` has 4 and `saveEventForHuman` 3; 3 of those 7 are seed scripts.
- **Line numbers are deliberately absent from this block.** The originals were stale by roughly a hundred lines before the work started, which taxes trust in every other fact here. Grep the symbol.

---

## Phases

**v1 (this spec): one held night → one event, atomically.** One additive enum migration.

**v2 (deferred, own spec): a run.** Several held nights become an `EventSeries` (`schedule.kind: "FIXED_DATES"` takes an explicit date array natively) whose occurrences materialize into N real Events, with the Agreement anchoring the series. Deferred because: every series use case opens its own transaction and takes `Repos` not `TxRepos`, so composing them into the accept transaction needs a new use case writing against tx-level repos directly; and `generateEventsFromSeries` mints thinner events than the booking path needs — no `setVenuePlacement`, and ticket types copied from a sibling event rather than series defaults.

---

## Prerequisites

These are **gates**, not nice-to-haves. The accept transaction holds advisory locks on hold lines; joining it to the save transaction as it stands would make one venue's slow ZipTax response another venue's hung inbox.

### P-1 — Hoist the tax lookup out of the save transaction — **LANDED `0fbb7661`**

Resolve the admission tax rate **before** opening the tx; stamp inside it. `resolveEventTaxRate` splits into `prepareEventTaxRate` (point reads plus the provider call, no writes) and `commitEventTaxRateCache` (the cache write), with the composed original kept for the callers that are out of scope.

Every DB write stays inside the transaction — the cache onto `Place`/`SavedLocation` and the event stamp — so a rollback leaves no half-written cache.

The freeform **new** `SavedLocation` path is the one that is not a one-line move: the row that caches the rate is created inside the tx, so the rate is resolved pre-tx from the typed address and the cache write is redirected onto the row the transaction mints or links.

**Correction found by building it.** Resolve the freeform ref inline from the typed address — do **not** route it through `eventTaxRateLocationRef`, whose inline arm requires a postal code **and** a country. A Canadian address carrying a province but no postal code resolves to `null` there and silently stamps no tax, where row hydration reached the static GST/HST branch. Use the exported `saveEventTaxRateLocationRef`.

Independently valuable regardless of the rest of this spec.

### P-2 — Batch seat materialization — **LANDED `87067393`**

Read the existing sections and seats once, diff against the layout, `createMany` the new rows in chunks of 1000, and correct the drifted ones with a batched `UPDATE ... FROM (VALUES ...)`.

Two rules the original one-liner — "`createMany` with `skipDuplicates` in place of the per-seat loop" — would have broken, both now enforced by tests beside the code:

- **The loop it replaces is an upsert.** It also updates an existing seat's `row`/`number` and an existing section's `name`/`type`/`capacity`. An insert that skips duplicates stops doing that half, so a layout edit appears to save while the seats keep their old labels.
- **Renames run before inserts.** Otherwise a new section claiming a name an existing one is about to release collides on `(eventId, name)`, is skipped, and throws — and because materialization runs on **every** event save, that organiser cannot save the event at all until they edit the layout.

The estimate here was understated about fivefold: 2500 seats took **52,280 ms across 2503 queries**, already past the 30s ceiling. After, 3,060 ms and 7 statements.

### P-3 — Per-call transaction timeout — **LANDED `6f423a16`**

An optional `{ timeout, maxWait }` on `repos.tx`, defaults unchanged at 30s / 10s, non-positive or non-finite values rejected rather than clamped. Not so accept can take longer — so that if accept cannot fit in 30s after P-1 and P-2, that is visible rather than quietly raised.

**Thread it through `withGuardedRepos`.** Both composition roots wrap repos in that decorator, so a per-call option that stops there evaporates before it reaches Prisma.

---

## Data Model

One additive migration: `BookingHoldReleaseReason` gains **`BOOKING_CANCELLED`** — the confirmed hold's release reason when its agreement or event is cancelled (FR-008). Additive enum values are non-breaking.

Nothing else. The linkage v1 needs — `Agreement.draftEventId @unique` — already exists.

v2 will need an Agreement→series anchor, since both `Agreement.eventId` and `Agreement.draftEventId` are `@unique` and one agreement can therefore hold at most one event.

---

## Use Cases

### FR-001 — `acceptBookingRequest`: a new use case and procedure

A **new** use case, `booking-requests/accept-booking-request.ts`, exposed as `bookingRequests.accept`. It owns every `TO_VENUE` accept — owned senders (mint) and anonymous senders (invite-to-claim) — so the UI has one mutation. `respondToBookingRequest` keeps **decline** in both directions and the **`TO_PERFORMER` accept**; its `TO_VENUE` accept branch is removed. `TO_PERFORMER` is unchanged by this spec: no holds exist on that side, and the performer's accept still mints only the agreement.

**Input:** `actorHumanId`, `bookingRequestId`, then exactly one of `holdId` or `{date, calendarId}`; optional `spaceId`
**Output:** `bookingRequestId`, `status`, `agreementId`, `eventId | null`, `releasedHoldIds`, `notificationIntents` (server-side only), `staffRecipientHint`
**Idempotent:** yes — one envelope (FR-005)
**Money:** yes — the accept clones payout terms onto the agreement
**Authorization:** `requirePlaceOwnership` with `ORG_EDIT_ROLES`, unchanged

For an **owned** sender, **three phases**. The transaction is the middle one, and putting the first or the third inside it is the defect each was built to prevent.

**Phase 1 — before the transaction opens.** `prepareBookingAcceptMint` (FR-004b). Every refusal *of the mint*, and the only outbound HTTP call, live here: it resolves the tax rate, and a plan cannot be built for a venue this actor may not book. Running it inside the transaction puts a 5-second ZipTax call inside a transaction already holding hold-line advisory locks, which is what P-1 exists to remove, and no test catches it because the provider fake answers instantly.

The caller composes the event `title` from the act's name; phase 1 sanitizes it, so do not reach for `plainTextRequired` yourself. On the `{date, calendarId}` arm the hold does not exist yet, so feed phase 1 a **synthesized hold shape** carrying the chosen date and calendar with a null space. The plan uses `hold.id` only for log and error context, so the real id assigned at step 3 is not needed.

**Phase 2 — one transaction, in order:**

1. Lock every line this call may touch, in the global sorted order (`hold-line.ts`), from a pre-lock read; re-read under the locks and give up with `HOLD_LINE_CHANGED` if the set grew.
2. `settleLine` — lapsed challenges expire first.
3. `{date, calendarId}` only: place the hold (`placeHoldOnLine`), so the rest of the transaction sees a live hold exactly as the `holdId` path does.
4. `takeLine` — open-challenge guard, CAS the winning hold to `CONFIRMED`, release the request's siblings as `SIBLING_CONFIRMED` and competitors as `CONFIRMED_OTHER`, renumber.
5. `acceptBookingRequestInTx` — the existing body, with one change: the agreement header's `proposedDate` is the **hold's date**, not the pitch's first preferred date, taken from `plan.startsAt` so the header and the event cannot disagree. The pitch seeds everything else. That alignment is implemented today by `alignAgreementDateToHold`, which lives in the file FR-002 retires — either give `acceptBookingRequestInTx` an explicit date override or move the helper across, but decide which rather than letting it go out with the file.
6. `plan.mintInTx(tx)` — the draft event. Never `finalizeSaveEventInCallerTx` directly. The plan anchors on the hold's date at the hold calendar's default start time, 19:00 fallback, in the place zone.

   **Calendar: always the hold's — only the space falls back.** The original text said both "on the hold's calendar" and "otherwise the place's default calendar", which cannot both hold. The calendar fallback is the dangerous reading: publishing settles held lines by the **event's** `calendarId`, so an event moved to the default calendar would settle a line the booking never touched and leave the real one live and unbookable. The space falls through the hold's space, the hold calendar's first active space, the default calendar's first active space, then spaceless.

   **Carry over the named-slot precedence.** `confirmBookingHold`, the path FR-002 retires, honours a *timed* `preferredDates` entry on the held night over the calendar default. Dropping it silently moves shows to the venue's default hour after the act picked a slot out of the venue's own availability. A timed entry on any other night cannot move the show.

   **`endsAt` cannot come from the agreement header** — phase 1 runs before the header exists. Both derive from the same `addSetLength(startsAt, setLengthMinutes)`. They part company when the pitch measured nothing: the header's `proposedEndDate` stays **null**, while the event falls back to `startsAt + DEFAULT_EVENT_DURATION_HOURS`. The 3-hour fallback is the event's alone — writing it into `proposedEndDate` changes what `computeAgreementPitchProvenance` reports for every booking that never named a set length.

   Start time and space are edited afterward in the event editor; the accept dialog does not ask for a time.
7. Ledger `booking_hold.confirmed` carrying the real `eventId` (no longer `null`), plus audit. `minted.eventId` is readable here, inside the transaction.

**Phase 3 — after the commit.** `minted.runAfterCommit()`. This is the one obligation neither the types nor a runtime guard can enforce, and the save's output — `notificationIntents` included — is only reachable through it. Skip it and the draft's slug is never assigned, which makes its public page throw on the preview link the builder shows before publishing. Call it *inside* the transaction instead and it opens a second transaction that blocks on the advisory locks this one still holds, until `maxWait` gives up.

For an **anonymous** sender: invite-to-claim exactly as today. No agreement, no event, holds stay live, `eventId: null`. The mint moves to the moment the act claims. Accept means two different things by sender kind; this spec states it rather than fixing it.

**Position is advisory.** Any live hold may be booked, not only position 1 — inherited from today's confirm. The open-challenge guard still refuses while another act is owed an answer (`HOLD_LINE_HAS_OPEN_CHALLENGE`, owner ruling 2026-08-27).

**Concurrency.** Two staff accepting the same request against different holds race on the hold CAS and the line's one-`CONFIRMED` partial unique; exactly one wins, the other gets `HOLD_LINE_ALREADY_CONFIRMED`. Two staff accepting against the *same* hold race on the request-status CAS; the loser gets `INVALID_STATUS`. Never retried automatically.

### FR-002 — `confirmBookingHold` is retired as an entry point

The `bookingHolds.confirm` tRPC procedure is removed. Its only consumer is `BookingHoldsStrip`. Two things survive, extracted the way `acceptBookingRequestInTx` already was: the line-taking body, and `alignAgreementDateToHold` with its `proposedEndDate` span rule, which FR-001 step 5 needs and which would otherwise be deleted along with the file.

The "why two steps and not one" heal documentation in `confirm-booking-hold.ts` goes with it — atomicity removes the state it recovers from. Rows already *in* that state are handled by FR-003.

### FR-003 — `createEventFromAgreement` takes the line

The legacy path, for requests already `ACCEPTED` with no event when this ships. All three phases of FR-001, omitting phase 2 step 3 — it is the second caller-transaction caller, so FR-004's three obligations are its too: when the request has a **live** hold, confirm it and release competitors rather than leaving them for FR-018 to settle at publish. When the request's hold is **already `CONFIRMED`** — the pre-2026-09 "mint failed after tx1" state whose heal path FR-002 deletes — `takeLine` treats the confirmed winner as a no-op and the mint proceeds. Without this, legacy rows keep a second mint path with subtly different semantics — the thing this spec deletes.

One hazard unique to this path: a caller passing an **existing published** event must widen its pre-lock set to cover the FR-018 settle's own `lockLines`, or it takes a line lock out of order and can deadlock. FR-001 cannot hit this because it mints fresh.

Hidden in the UI unless the request is `ACCEPTED` with no event.

### FR-004 — The event mint joins the caller's transaction — **LANDED `6aaae426`**

**Two exported functions**, sharing one transaction body extracted rather than rewritten:

- `finalizeSaveEvent(deps, logger, params: FinalizeParams)` — owns its transaction, unchanged.
- `finalizeSaveEventInCallerTx(deps, logger, params: FinalizeSaveEventInCallerTxParams)` — runs every write through the caller's handle and returns `{ …output, deferred }`.

A runtime guard on the standalone one refuses caller-transaction params, which remain *assignable* to it, and where the handle would be ignored and a second transaction opened against the caller's own advisory locks.

**Do not collapse this back to one symbol.** The original requirement — "gains an optional `tx?: TxRepos`" — cannot be built. The caller-transaction shape has a different return type, because post-commit work has to come back; and once two return types exist, one symbol cannot carry both, since the caller-transaction params are a *subtype* and a variable gets no excess-property check. TypeScript then binds the standalone form, types the result without `deferred`, and runs the caller-transaction branch underneath. Measured with a compiler probe, `TS2339: Property 'deferred' does not exist`, and invisible to every gate because no tsconfig here typechecks a test file.

Still explicitly **not** "pass a `repos` whose `.tx` is a passthrough shim": the shim leaves the callee believing it owns a transaction it does not.

**Three obligations the original requirement did not mention.** A caller must:

1. **Drain the deferred work after committing.** Today that is only `assignSlugOnCreate`; skipping it leaves the draft with no slug, which throws on the pre-publish preview page.
2. **Resolve the tax rate before opening its transaction** and pass `preparedTaxRate`. "Before the transaction" has no meaning once the caller holds one, so the natural implementation puts a 5-second HTTP call inside a transaction holding hold-line locks — reintroducing exactly what P-1 removed. A restamp with no prepared rate throws; the provider is never called as a fallback.
3. **Own the idempotency envelope** (FR-005). The save's own is skipped on this path, along with its replay short-circuit.

It also loses the four checks the `saveEventForOrg` / `saveEventForHuman` wrappers perform — the attach gate, the existing-event ownership check, `ensureEndsAfterStarts`, and the Zod parse that sanitizes `title` and `locationLabel` through `plainTextRequired`. Nothing inside the save verifies that `params.owner` may attach to `params.location.placeId`. **Do not hand this list to a use case to remember — see the accept mint below.**

### FR-004b — One entry point for the accept mint — **LANDED `ec8544c5`**

FR-004 leaves a caller owning five things, one of them authorization. A list of obligations in a doc comment is not a safeguard, so core owns the assembly instead: `booking-requests/_shared/accept-mint.ts`, with FR-006's rule beside it in `_shared/venue-booking-party.ts`.

Three phases, each phase's output the only way to reach the next, so the obligations are the call graph rather than a checklist:

```
const plan   = await prepareBookingAcceptMint(deps, input);  // pre-tx, write-free
// caller: opens tx, locks lines, settleLine, takeLine, acceptBookingRequestInTx
const minted = await plan.mintInTx(tx);
// caller: commits
const result = await minted.runAfterCommit();
```

Preparation sanitizes the title, derives the venue booking party, runs the attach gate **against that derived party rather than the actor**, anchors the show, resolves the space, and prepares the tax rate. It writes nothing, so every refusal lands before a competitor's hold has been released.

Two runtime guards cover what types cannot: the mint refuses a root repos bag posing as a transaction handle (`TxRepos` is `Omit<Repos, "tx">`, so the root bag is assignable through a variable), and a plan refuses to mint twice.

`plan.venueParty` / `startsAt` / `endsAt` are exposed so step 5 stamps the agreement from the same values step 6 mints under; `minted.eventId` is readable in-tx for step 7's ledger entry; the notifications are only reachable through the drain.

**Still the caller's:** the single FR-005 envelope, hold-line locking / `settleLine` / `takeLine`, `acceptBookingRequestInTx`, the accept's ledger and audit, and notification dispatch.

**One obligation cannot be typed:** `runAfterCommit` is handed back inside the transaction and is callable immediately, where it would open a second transaction against the locks the caller still holds. Every mechanism that would detect this makes the module a participant in transaction lifecycle, which is what FR-004 rules out. A test pins the behaviour; the drain stays a caller obligation.

**Lock order for this transaction**, hold-line advisory locks first, sorted, then the save's row locks in the order its body writes them: Event → Seat → SavedLocation → Event → SavedLocation → Place *or* SavedLocation (whichever the tax cache target names) → Event → BookingRequest (third-party arm only) → ResourceUsage last.

### FR-005 — One idempotency envelope

`bookingRequest:accept:<requestId>`, wrapping the whole thing. Two nested Redis envelopes over one transaction is a deadlock waiting to be discovered in production, so the inner one drops out.

**Which inner one — the original named the wrong key.** `bookingAgreement:createEvent:<agreementId>` belongs to `createEventFromAgreement`, a use case the accept path never calls. The envelope that actually nests is **the save's own**, `saveEventForOrg:…` / `saveEventForHuman:…`, and it is skipped on the caller-transaction path along with its replay short-circuit. Remove the key originally named and the real nesting survives untouched.

**Lock TTL ≥ transaction ceiling.** The envelope's `begin(key, ttl)` uses 120s (the save's own figure), never less than the tx timeout — a lock that expires mid-transaction lets a retry start a second one.

The cached-record intent-stripping (`respond-to-booking-request.ts`) carries over unchanged: intents are removed from the **cached** copy only, so the call that committed dispatches and any replay returns an intent-free record and re-sends nothing. Enforced by data absence, not a flag.

### FR-006 — Ownership derives from the place, and never from a fallback

`deriveCounterparty` used to return the owning org when access came through an org membership and **otherwise fall back to the actor**. A fallback, not a check: it never re-verified that the actor was a direct human owner. With `requirePlaceBookingAuthority` returning `via: "grant"` for a `PlaceBookingGrant` holder, that fallback made a grant-holder the agreement's venue counterparty and minted the venue's show owned by them personally, silently. Grant-holder accept is pinned as supported behaviour, so refusing the third path was never an option — it had to be handled.

Two different things a grant-holder can do, which the rule must keep apart:

- **Booking themselves** — the event-first path, `canCreateEvents`. The grantee is the act *and* the organizer; the event is theirs and confirmed by construction. Not this use case.
- **Booking an act on the venue's behalf** — accept, `canPlaceHolds`. The grantee acts *for* the venue: the agreement's venue side and the event's owner are the **venue's**, never the grantee's. The owner's ruling — accept stays with the venue unless the grant confers it — applied to ownership.

The new rule, in order. **Rule 1's "regardless" was wrong and is corrected here:**

1. The actor got in as an **org member** (`via: "org"`, with that org on the place's access list) → the org.
2. The place is human-owned **and the actor is one of its direct owners** → the actor. (Not the smallest owner id — that is `deriveVenueCounterpartyFromPlace`'s rule for the actor-free claim path, and it would break co-owned places here: co-owner B's accept would mint under A and then fail B's own mint with `NOT_RESOURCE_OWNER`.)
3. The actor is a **grantee** → the place's owner, org first, then smallest human id. Never the grantee. The mint runs under the counterparty rather than the actor, which `finalizeSaveEvent` already supports: it takes `owner` and `actorHumanId` separately.
4. Anything else → refuse, `NOT_RESOURCE_OWNER`.

**Why rule 1 cannot say "org-owned → the org, regardless".** For a place owned by an org **and** by people, that hands a direct owner's booking to the org — and `resolvePlaceOwnership` returns `via: "human"` for a direct owner *before* it ever looks up a membership, so nothing has established that person holds any role in that org. They would then fail the ownership check on their own first edit of the event they just created, which is rule 2's failure mode one level up. Ordering by how the actor got in, not by what the place is, also keeps this in step with the landed `deriveCounterparty`.

**A correction to rule 3's pointer.** The original said `saveEventForHuman`'s "creates under the actor" contract must change and that this belongs in FR-004's shared work. It does not: `finalizeSaveEvent` already takes an explicit owner. The hardcode is one line in `save-event-for-human.ts`, it only affects the standalone wrapper, and this spec does not need it changed. The booking-agent spec still will.

Both derivations exist side by side — `deriveVenueBookingParty` for the mint, `deriveCounterparty` for the agreement — and tests pin them together. One difference they still carry, not a bug today: `deriveCounterparty`'s `via: "human"` arm trusts `via`, where `deriveVenueBookingParty` checks the actor against the place's owner list. FR-001 should use the first for both, and delete the second when it retires the old accept path.

### FR-007 — The act is told

Accept currently notifies the act of nothing. Extend the existing `hold.confirmed` intent — which already goes to the act with date and line context — to carry the event. **One notification, not two:** no separate "request accepted" message about the same event. `bookingRequests.accept` dispatches its intents in the router exactly as the hold procedures do (`makeBookingHoldIntentsNotifier`).

### FR-008 — Agreement and event are one booking: cancel either, both go

Owner ruling 2026-09-06: *"Accepting an agreement means we accept the event. Both should cancel if one does."*

The cancel that runs first depends on where the booking is:

- **Agreement cancelled** (`cancelBookingAgreement`). Its existing `expectEventIdNull` CAS means this can only succeed while the event is at most a **draft**. In the same transaction: delete the draft event, release the request's `CONFIRMED` hold with `BOOKING_CANCELLED`, ledger both. The draft is no longer orphaned.
- **Draft event deleted** (`deleteEvent`) while `Agreement.draftEventId` points at it. In the same transaction: cancel the agreement (the existing transition, same ledger entry), release the confirmed hold with `BOOKING_CANCELLED`.
- **Published event cancelled** (`cancelEvent`, which owns refunds) while `Agreement.eventId` points at it. In the same transaction, after the money work: cancel the agreement, release the confirmed hold with `BOOKING_CANCELLED`.

The hold release is forced, not chosen: the line's one-`CONFIRMED` partial unique would otherwise leave the date unbookable by anyone. Competitors released earlier with `lost_date` do **not** come back — a released hold is terminal (holds FR-019). The night is simply open again.

This does not contradict the 2026-08-27 ruling that holds never release on agreement cancel. That ruling protects **live** holds — an act's pencilled nights should survive a negotiation falling through. A `CONFIRMED` hold is not a pencil; it is the booking.

---

## UI / Flow

### Accept dialog — on all three surfaces

`BookingInbox`, `OrgReceivedRequestsTable` and `ReceivedBookingRequestsList` all call `respond({action:"accept"})` today. **All three** get the dialog and switch to `bookingRequests.accept`. Leaving either secondary surface on a date-less accept would be a third mint path, which is the thing this spec deletes.

Owned sender:

- Lists the request's live holds; the venue picks the night. Defaults to position 1.
- No holds on the request → a date picker plus the calendar (defaulting to the request's routed calendar); accepting places the hold and takes the line in the same transaction.
- When the place has more than one active space, a space picker. There is no `Calendar.defaultSpaceId`: the chain is the hold's own active space, then the hold calendar's first active space, then the default calendar's, then spaceless. The dialog prefills by applying that same chain, and **sends `spaceId` only when the venue changed it**, so the server resolves it fresh at accept time. An explicit `spaceId` is taken verbatim and skips the active-status check the chain applies — prefill it and a space retired between opening the dialog and pressing Accept is stamped on the event. Otherwise nothing is asked.
- Shows the **count** of competing holds that will be released — "2 other acts hold this date and will be released". Count, never names: naming leaks who else is negotiating with the venue.
- Primary action reads `Accept & book Fri Oct 10`. Not "confirm" — `CONTEXT.md` retires it as a booking verb.
- A note that start time and room can be changed in the event editor.

Anonymous sender: no date, calendar or space controls. The copy says an invite to claim will be sent and nothing is booked yet — the same thing today's dialog says.

### Holds strip

Loses **Confirm**. Keeps place, reorder, challenge, extend, release.

### Stage rail

`dateOffPitch` is **retired**. Its reason for existing — the event's date silently diverging from the negotiated one — cannot happen once the event, the agreement's `proposedDate` and the confirmed hold all carry the same night by construction.

### Create event from booking

Stays, hidden unless the request is `ACCEPTED` with no event (FR-003's legacy path).

### Failure copy

Typed codes → calm copy, reusing the existing mapping in `create-event-from-booking.ts`, plus an explicit **"Nothing was changed."** That line is only honest because of FR-004, and it is worth saying out loud.

Codes to map: `EVENT_QUOTA_EXCEEDED`, `HOLD_LINE_ALREADY_CONFIRMED`, `HOLD_LINE_HAS_OPEN_CHALLENGE`, `HOLD_LINE_CHANGED`, `BOOKING_HOLD_NOT_LIVE`, `BOOKING_REQUEST_EXPIRED`, `NOT_RESOURCE_OWNER`, transaction timeout, and tax-provider `dependency_failed`.

### Help center and e2e

User-facing change ⇒ `help-center-authoring` after build. `organising-events/booking-requests.md` and the holds article both describe Confirm and must be swept. `apps/web/e2e/booking-loop.spec.ts` asserts on `createEventFromAgreement` and needs the accept-mints path; the two passkey-style shared-account collisions mean it runs `--workers=1` with anything else touching the same venue.

---

## Acceptance Criteria

- [ ] A venue accepts a request against a held date and gets one draft event on **that** date, with the request `ACCEPTED`, the agreement drafted with `proposedDate` equal to the hold's date, the hold `CONFIRMED`, competitors released, and one ledger entry carrying the real `eventId`.
- [ ] Forcing the event mint to fail rolls back the whole accept: the request is still open, the agreement does not exist, every hold is still live, and **no act receives a `lost_date` notification**. Regression test required — this is the bug being fixed.
- [ ] Accepting a request with no holds, given a date and calendar, places and takes the line in one transaction.
- [ ] Accepting a request whose hold is already `CONFIRMED` with no event (legacy state) mints the event without touching the line.
- [ ] `bookingHolds.confirm` no longer exists; no UI references it. `respond` no longer accepts `TO_VENUE` requests.
- [ ] All three accept surfaces use the dialog and `bookingRequests.accept`; none calls `respond` with `action: "accept"` for a `TO_VENUE` request.
- [ ] Accepting an anonymous embed inquiry still sends invite-to-claim and mints nothing; its holds stay live; the dialog shows no date controls.
- [ ] `TO_PERFORMER` accept behaviour is byte-identical to before.
- [ ] The agreement's venue counterparty and the event's owner are the **same derived party** end to end, on all four rules, with `deriveCounterparty` retired. (The derivation itself is covered below; this is the part FR-001 still owes.)
- [ ] The act receives exactly one notification naming the booked date and the event.
- [ ] A replayed accept (same envelope key) returns the cached record and sends no second email. The envelope lock outlives the transaction ceiling.
- [ ] Two concurrent accepts of one request against different holds: exactly one succeeds; the other gets `HOLD_LINE_ALREADY_CONFIRMED`; the line has exactly one `CONFIRMED` hold.
- [ ] Cancelling the agreement while the event is a draft deletes the draft and releases the confirmed hold with `BOOKING_CANCELLED`, in one transaction. Deleting the draft does the inverse. Cancelling a published event cancels its agreement and releases the hold after refunds. Three tests; the line accepts a new hold afterward.
- [ ] `dateOffPitch` is gone from `booking-stage-rail.ts` and its tests.
- [ ] `pnpm typecheck` **and** `pnpm -F api exec tsc -p tsconfig.json --noEmit` are green (packages-only typecheck excludes `apps/**`).
- [ ] `booking-loop.spec.ts` passes on the accept-mints path. Help articles swept.
- [ ] Driven in the real app: accept from each of the three surfaces, zero new console errors, 320px viewport checked.

### Prerequisite criteria

- [x] No outbound HTTP call occurs between `repos.tx` opening and closing in `save-event-shared.ts`, on either the place-linked or the freeform new-location path. Asserted by call-order test double, not by inspection. (P-1)
- [x] `materializeSections` issues O(1) statements per section rather than O(seats). (P-2)
- [x] `repos.tx` accepts an optional timeout; the default stays 30s. (P-3)
- [x] A caller-transaction params **variable** handed to the standalone save entry point is refused at runtime, before any I/O, with a named programmer error. (FR-004)
- [ ] The type-level half of that — the assertion in `save-event-caller-tx.test.ts` that the caller-tx entry point's result keeps `deferred` — is **unrun at HEAD**. No tsconfig in this repo typechecks a test file, and no committed config lists this one. Until one exists, it is checked by hand: write `{"extends":"<repo>/tsconfig.base.json","include":[],"files":["<that file>"]}` and run `pnpm exec tsc -p <it> --noEmit`, ignoring `packages/test-utils/**` noise.
- [x] Counterparty: org member → org; dual-owned place accepted by a direct human owner → that owner, not the org; grantee → the place's owner, never the grantee; anyone else → `NOT_RESOURCE_OWNER`. (FR-004b / FR-006)
- [x] The accept mint sanitizes the event title through `plainTextRequired(140)` before any read, so an anonymous inquiry's act name cannot reach `Event.title` raw. (FR-004b)

---

## Out of Scope

- **Multi-night runs.** v2, own spec. See Phases.
- **The booking agent identity.** `PlaceBookingGrant` exists (model, port, adapter) with **zero** references in core, transport or web; the grant/revoke UI was an explicit non-goal of specs/2026-08-27/venue-confirmation-and-booking-intents.spec.md. Its own spec. Note for it: the owner's ruling is that accept stays with the venue **unless the grant confers it**, so honouring `canCreateEvents` means teaching the event-save authorization about grants — `saveEventForOrg` requires org edit-role membership and `saveEventForHuman` creates under the actor, and a granted agent is neither. That change is one line in `save-event-for-human.ts`, not in the shared save, which already takes an explicit owner. `deriveVenueBookingParty` is where that path plugs in.
- **"Break this night off the series."** A thin use case over the existing `bulkDetach` port plus the sales-confirmation dialog `reconcileSeriesSchedule` already has. Only reachable once v2 exists.
- **The same lost-notification gap on the publish path.** FR-018 settles holds inside the publish transaction and `publish-event.ts:414` fires a non-awaited search reindex before intents dispatch. Real, but a publish-path bug; folding it in makes this a two-header change.
- **Per-night payout terms.** One agreement, one set of terms across a run. Per-night terms would drag the ledger into this spec.
- **Unifying accept across sender kinds.** Owned accept mints; anonymous accept invites. Stated, not fixed.

---

## Open Questions

**Two rulings inherited from the build, 2026-09-09**, each decided by whoever implemented it and each the kind of thing an owner should say yes to rather than inherit:

- **Ownership follows the reordered FR-006.** A dual-owned place accepted by a direct human owner mints under that person, not the org.
- **The event's calendar is fixed to the hold's.** Only the space falls back.

Otherwise nothing blocking: the design tree was walked to an empty frontier 2026-09-01 through 2026-09-06, and the 2026-09-06 review pass folded in two would-ship bugs and twelve gaps.

**Corrected against the build, 2026-09-09.** Eleven errors were found by implementing against this document: two unbuildable as written, five that produce working code and fail only in production, four wrong pointers or figures. Each is corrected where it sits rather than appended as errata, and the original wording survives only where the reason it was wrong is now the requirement.
