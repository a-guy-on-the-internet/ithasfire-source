# Host Attestation at Event Publish

**Date:** 2026-05-14
**Status:** complete
**Priority:** P1 (launch blocker — required before first organiser publishes a paid event)
**Companion to:** `web-launch-checklist.spec.md` Item 4, launch-backlog 3.3
**Depends on:** Event publish flow (`packages/core/src/use-cases/events/publish-event.ts`), event creation UI (`apps/web/src/app/admin/[slug]/events/...`)

---

## Problem

Ithas Fire is a marketplace. When an organiser publishes an event, they're representing — to us, to attendees, and to the law — that they have the right to host it and will follow basic rules. If a city shuts down a backyard show, if a neighbour calls the cops over noise, if someone gets hurt because alcohol was being sold without a license, if 1099-K paperwork is botched at year-end — the platform's defence in every one of those scenarios is "the organiser attested to these obligations before publishing."

Today the codebase has none of this. `Event` has no attestation fields. `publish-event.ts` doesn't check for them. There are no checkboxes in the event creation UI for legal-right-to-host, noise compliance, no-alcohol-sale, tax responsibility, or FAQ review.

This isn't a hypothetical legal worry — it's the kind of thing that turns one organiser's bad event into platform-wide liability when no paper trail exists. Cheap to fix now, expensive to retrofit after the first incident.

## Goals

- Gate event **publish** (not draft creation) on a one-time attestation flow
- Capture **per-checkbox** acknowledgements (not just "agreed to everything")
- Snapshot the **policy text version** so we can prove what the organiser actually saw and accepted
- Persist actor, timestamp, IP, and user-agent for forensic value
- Re-attest when an unpublished event is published again, or when policy text materially changes before the next publish transition
- Keep the attestation history append-only so we have an audit trail per organisation

## Non-Goals

- Gating draft creation, ticket-type editing, or any pre-publish UX. Organisers iterate freely until they hit "Publish."
- Building a legal-text CMS. Attestation copy lives in code with a version number; updates ship via deploy.
- Per-event renewal cadence (e.g. "attest every 30 days"). One attestation per publish event.
- Exempting free events. The attestation applies regardless — the legal/zoning/tax obligations don't go away just because the event is free.
- Alcohol licensing review. We're not the gatekeeper; we just ask the organiser to confirm their own legal status.

## Context

| Surface | File |
|---|---|
| Event Prisma model | `packages/db/prisma/event.prisma:211` |
| Publish use case | `packages/core/src/use-cases/events/publish-event.ts` |
| Unpublish use case | `packages/core/src/use-cases/events/unpublish-event.ts` |
| Event creation flow (admin UI) | `apps/web/src/app/admin/[slug]/events/...` |
| tRPC events router | `packages/transport/trpc/src/routers/events.ts` (or similar) |
| Attendee waiver (analogous pattern, NOT this) | `apps/web/src/app/.../EventWaiverSection.tsx` |

The attendee-side liability waiver already exists for the buyer side. This spec adds the **organiser-side** equivalent for the publish side.

## Data model

New Prisma model in `packages/db/prisma/event.prisma`:

### `EventAttestation`

```prisma
model EventAttestation {
  id                       String   @id @default(cuid())
  eventId                  String
  event                    Event    @relation("EventAttestationHistory", fields: [eventId], references: [id])
  attestedByHumanId        String
  attestedBy               Human    @relation("EventAttestations", fields: [attestedByHumanId], references: [id])
  attestedAt               DateTime @default(now())
  ipAddress                String?
  userAgent                String?
  policyVersion            String   // e.g. "2026-05-14"; bump when copy changes
  policyTextSnapshot       Json     // full rendered HOST_ATTESTATION_TEXT object

  // Granular per-checkbox acknowledgements (all required)
  legalRightToHost         Boolean
  zoningAndNoiseCompliance Boolean
  alcoholCompliance  Boolean
  taxResponsibility        Boolean
  organizerFaqReviewed     Boolean

  metadata                 Json?
  createdAt                DateTime @default(now())
  currentForEvent          Event?   @relation("EventCurrentAttestation")

  @@index([eventId, attestedAt])
  @@index([attestedByHumanId, attestedAt])
}
```

Plus a denormalised pointer on `Event` for the *currently effective* attestation (cleared on unpublish, reset on re-publish):

```prisma
// in model Event
attestations          EventAttestation[] @relation("EventAttestationHistory")
currentAttestationId String?             @unique
currentAttestation   EventAttestation? @relation("EventCurrentAttestation", fields: [currentAttestationId], references: [id])
```

And the inverse relation on `Human`:

```prisma
// in model Human
eventAttestations EventAttestation[] @relation("EventAttestations")
```

This denormalisation lets the publish-validation read a single foreign key without joining the full history. The history table `EventAttestation` remains the audit log.

## Attestation copy (version `2026-05-14`)

Lives in `packages/core/src/use-cases/events/host-attestation-text.ts` as a versioned constant. Each item maps 1:1 to a boolean field on the model.

```ts
export const HOST_ATTESTATION_VERSION = "2026-05-14";

export const HOST_ATTESTATION_TEXT = {
  legalRightToHost:
    "I have the legal right to host this event at the location stated. " +
    "If the venue is private property, I am the owner or have explicit " +
    "written permission from the owner. If public, I have any required permits.",

  zoningAndNoiseCompliance:
    "This event complies with local zoning, occupancy, and noise ordinances. " +
    "I understand that complaints from neighbours or enforcement actions by " +
    "local authorities are my responsibility, not Ithas Fire's.",

  alcoholCompliance:
    "All alcohol service at this event — whether sold by me, provided by " +
    "a caterer or vendor, given to attendees, or accepted by donation — " +
    "complies with applicable state and local law, including any required " +
    "licenses or permits. I am responsible for verifying my own legal " +
    "status (and that of any vendor I engage). Ithas Fire does not act as " +
    "a seller, distributor, or facilitator of alcohol.",

  taxResponsibility:
    "I am responsible for any income, sales, or admissions taxes owed on the " +
    "revenue from this event. Ithas Fire will issue a 1099-K where required " +
    "by federal or state law; the underlying tax obligation is mine.",

  organizerFaqReviewed:
    "I have read the Ithas Fire Organizer FAQ and understand the platform's " +
    "policies on refunds, chargebacks, cancellation, and payouts.",
};
```

Each field is the **full sentence** the organiser sees next to its checkbox.

### Snapshot the rendered text on the row — REQUIRED

Store the entire `HOST_ATTESTATION_TEXT` object as it existed at attestation time directly on the `EventAttestation.policyTextSnapshot` column (JSON). Do not rely solely on the `policyVersion` string + git history.

Why this matters: in 18 months when a court or auditor asks "what exact text did Sarah see when she attested on 2026-05-14?", you need to answer in seconds, not by archaeology. Git history is fragile evidence:

- Force-pushes can rewrite it
- The build deployed at attestation time may not match the commit you'd point to
- Feature flags or A/B tests could have surfaced different text
- Repo migrations (Forgejo → wherever) break the link

Cost: a few KB per attestation. At realistic volume that's ~1MB extra storage over 5 years. Trivial. Skip this and you have no defensible answer to the basic question.

```ts
// in EventAttestation row
policyTextSnapshot: HOST_ATTESTATION_TEXT  // full JSON, not just the version key
```

When the text changes, **bump `HOST_ATTESTATION_VERSION`**. Events whose `currentAttestation.policyVersion` doesn't match the latest version must re-attest on next publish toggle. Don't force re-attest on existing published events — only when they're re-published.

## Use case wiring

### `publish-event.ts` — add attestation gate

Current signature accepts `{ eventId, actorHumanId, clientKey }` and uses `clientKey` with `IdempotencyPort`. Preserve that contract. Extend the input with request evidence and a conditionally-required `attestation` block:

```ts
type PublishEventInput = {
  eventId: string;
  actorHumanId: string;
  clientKey: string;
  ipAddress: string | null;
  userAgent: string | null;
  attestation?: {
    legalRightToHost: boolean;
    zoningAndNoiseCompliance: boolean;
    alcoholCompliance: boolean;
    taxResponsibility: boolean;
    organizerFaqReviewed: boolean;
  };
};
```

**Idempotency:** keep the existing publish idempotency flow. The idempotency key still derives from `actorHumanId + clientKey`, and the payload hash includes the attestation block when one is submitted. This prevents duplicate publish clicks from creating duplicate attestation rows.

**Validation:** after loading the event state, require every checkbox to be `true` when the call transitions an unpublished event to `PUBLISHED`. Reject with a structured error (`ATTESTATION_INCOMPLETE`) listing which fields are missing/false so the UI can highlight them. If the event is already `PUBLISHED`, return the existing published output without requiring an attestation block; do not use duplicate publish calls to force legal re-attestation.

**Transaction:**
1. Preserve the current publish authorization contract: org events use existing `ORG_EDIT_ROLES` (OWNER / ADMIN / EDITOR) and direct human-owned events require the owning human
2. Validate all 5 checkboxes are true
3. Insert `EventAttestation` row with snapshot
4. Update `Event.currentAttestationId = newAttestation.id`, set `publishedAt = now`, set status to PUBLISHED
5. Emit `event.published` audit log entry

All in one Prisma transaction so partial state is impossible.

### `unpublish-event.ts` — clear pointer, keep history. NEVER gated.

When unpublishing:
- Set `Event.currentAttestationId = null`
- Preserve `publishedAt` as historical "was ever live" state; visibility is controlled by `status`, not `publishedAt`.
- **Do not delete** the historical `EventAttestation` rows — they're the audit trail. The pointer just becomes "no current attestation" until next publish.

**Critical: do NOT gate unpublish on attestation status.** Preserve the existing authorization, status, and sold-order safety guards; just do not add a new attestation prerequisite. If an event has paid orders, the current `unpublish-event` guard should still force the organiser toward cancel/refund or a future pause-sales path instead of silently hiding a paid event.

Rule: **gate adding liability, not removing it.**

### Refund flows — also NEVER gated

By the same logic: do not gate refund actions (`refund-full-order`, `refund-order-items`, in-person refunds when POS lands) on attestation. If an event needs to refund every attendee because of a cancellation, that's a fire-drill, not a legal-paperwork moment. The attestation has already been recorded for the publish event; nothing the organiser does *after* the fact should be blocked on it.

The only thing gated on attestation is **publish** (which is the moment new liability enters the platform).

### Re-publish path

When `publish-event` is called:
- If the event is already `PUBLISHED`, treat the call as idempotent: no new attestation row, no modal, no extra friction. This covers existing published events with no attestation, current-version attestations, and stale-version attestations; fresh attestation is required on the next publish transition, not on duplicate live-state calls.
- If the event is not currently published, require fresh attestation, insert a new row, update the pointer, and then publish.
- If the event was unpublished after a previous publish, `currentAttestationId` should already be null; the next publish requires fresh attestation.

This means: unpublish always clears the current pointer, and the next publish always creates a new attestation row. The only skip path is a duplicate publish call while the event is already live.

## UI flow

### Where it lives

Not on the main event-editor form. **Modal/drawer** triggered by clicking "Publish" on an unpublished event.

### Component shape

New component adjacent to the shared event builder surface, e.g. `apps/web/src/app/admin/[slug]/events/new/_components/PublishAttestationDialog.tsx`, wired from `EventBuilder.tsx` where publish currently calls `trpc.events.publishEvent`.

- Modal opens on Publish click
- Five rows, each with a `<input type="checkbox" required>` + the policy sentence (rendered from `HOST_ATTESTATION_TEXT`)
- A "Read the Organizer FAQ" link that opens in a new tab — clicking it doesn't auto-check the box; the organiser still has to tick it
- "Publish event" CTA disabled until all five are ticked
- Submit triggers the existing `trpc.events.publishEvent` mutation, but now also passes the `attestation` block

### Skip path for already-attested events

If the event is already published, the modal is skipped for duplicate publish attempts. For unpublished events, show the modal every time; the previous pointer was cleared on unpublish. Server validation remains the source of truth.

### Tone

The copy should read like a contract clause, not a friendly checkbox. The point is to make the organiser pause. Bold or otherwise emphasise key obligations ("**my responsibility, not Ithas Fire's**"). This is the moment where they take on liability — they should feel it.

## Telemetry

Useful, low-cost:

- Track time-on-modal in analytics. If most organisers tick everything in <2 seconds, the wording isn't doing its job — revise.
- Sentry breadcrumb on attestation submission (just the event ID + version, never the user's IP).
- Audit log entry on every `EventAttestation` insert with the actor + diff of checkboxes.

## Tests

- **Unit (`publish-event.test.ts`):** publish rejected when any checkbox is false; published with all true; correct `EventAttestation` row inserted with snapshot; `Event.currentAttestationId` updated.
- **Unit:** unpublish clears pointer but preserves attestation history.
- **Unit:** duplicate publish while already `PUBLISHED` returns idempotently without requiring attestation or creating a row, even when the current attestation is missing or stale.
- **Unit:** unpublished → `PUBLISHED` always requires fresh attestation and inserts a new row, regardless of any previous matching/stale policy version.
- **E2E:** new event creation → fill required fields → click Publish → modal appears → can't submit with missing checkboxes → all checked → Publish succeeds → event row has `currentAttestationId`.
- **E2E:** unpublish → re-publish (same session, same version) → modal appears and a new attestation row is written.

## Rollout

No feature flag needed. This is a pure additive change to the publish path:

1. Ship Prisma migration (adds `EventAttestation` table, `Event.currentAttestationId`, and the inverse `Human.eventAttestations` relation)
2. Ship backend (`publish-event.ts`, `unpublish-event.ts`, text constants)
3. Ship UI (modal component, wire to existing publish mutation)
4. Verify: existing published events keep `publishedAt` but have `currentAttestationId = null`. They don't need to re-attest until they unpublish + re-publish, OR we backfill (see below).

### Backfill question

Two options for existing published events:

**A) No backfill.** Existing published events keep `currentAttestationId = null` forever. Only newly-published events have attestations. **Risk:** if a pre-existing event causes a legal issue, you have no paper trail for it.

**B) Forced re-attestation.** Run a job after deploy that unpublishes all existing events, then emails their organiser "please re-publish with the new attestation." High-friction; might lose events.

**Recommendation:** A for now, since the small number of pre-launch events on the platform isn't a real liability surface yet. If you reach 50+ live events without doing B, schedule a forced re-attest at a quiet moment with email warning.

## Open questions

- **Alcohol attestation wording — RESOLVED.** Updated to a broader compliance assertion covering sale, vendor service, donation, and BYOB scenarios in one clause. Still worth ~30 min of paid legal review before launch to confirm coverage for any state-specific quirks.
- **Should `organizerFaqReviewed` require actually visiting the FAQ? — RESOLVED, NO.** Marginal legal value, real UX cost, dishonest "we made them read it" theater. Stronger version (require scroll-to-bottom of the FAQ rendered inside the modal) is available if counsel ever pushes for it.
- **Backfill for existing pre-launch events — RESOLVED for now.** No backfill while event count is near zero. At ~50 published events without attestation, schedule a forced re-attest on next material edit. Add an admin-page warning indicator now (cheap) so we can spot the gap before it gets ugly.
- **Per-state/jurisdiction text variations.** Not for v1. If we hit a state with specific event-promoter regulations (some have ticket-reseller laws), we'd add a `jurisdiction` field and a per-jurisdiction extension. Defer.
- **Re-attestation cadence.** Currently triggered only by version bump or unpublish/re-publish. Could be quarterly forced. Defer unless ops wants this.

## Acceptance criteria

- Calling `publish-event` without all five checkboxes set to `true` returns `ATTESTATION_INCOMPLETE` and does not transition the event to PUBLISHED.
- A successful publish inserts an `EventAttestation` row with snapshot text matching `HOST_ATTESTATION_VERSION` and stamps `Event.currentAttestationId`.
- Duplicate publish calls while already published do not require attestation and do not create a new attestation row, even if the current attestation is missing or stale.
- Unpublish → re-publish requires fresh attestation even when the policy version has not changed.
- After a policy-text version bump, the next publish (after the existing one is un/re-published) requires fresh attestation.
- Audit log shows actor + event + version + per-checkbox values for every attestation submission.
- Existing publish authorization is preserved: editors who can publish today can still publish once they complete attestation; any role tightening requires a separate RBAC spec and UI change.
