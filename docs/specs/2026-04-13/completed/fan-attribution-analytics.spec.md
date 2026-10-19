# Fan Attribution & Analytics

**Date:** 2026-04-13
**Status:** complete
**Depends on:** Event, Order, Ticket, EventHuman (all exist in schema)

---

## Problem

When a fan buys a ticket to a multi-artist event, there's no way to know which artist drove that purchase. The venue doesn't know which artist is drawing. The artist doesn't know which city their fans are in. The fan data disappears into a generic order table with no attribution.

Joel Gouveia (Sincerely Mgmt) documented this exact problem: his artist had 460,000 monthly Spotify listeners and couldn't reach a single fan without asking a platform's permission. He had to stitch together 6 different tools — TicketTailor, Shopify, Laylo, Spotify, Instagram, Forms.app — to build what should be a native feature of any ticketing platform.

Ithas Fire controls the checkout. That means we can solve attribution at the transaction layer with deterministic rules and role-permitted, consent-aware outputs.

---

## Core Concept: Referral Attribution

Every performer on an event's lineup gets a unique referral link. When a fan buys through that link, the order attribution is assigned to that performer. Attribution is deterministic and idempotent.

### Referral Link Format

```
https://hearthfire.community/events/{slug}?ref={event-human-id}
```

Extended with optional UTM parameters for platform tracking:

```
https://hearthfire.community/events/{slug}?ref={event-human-id}&utm_source=instagram&utm_medium=story&utm_campaign=album-release
```

`ref` is an immutable key: `EventHuman.id` (UUID) for the performer on that specific event.

Canonical parse/validation rules:

1. Read `ref` from query string once on landing and persist in checkout session state.
2. Normalize as `trim()` + URL decode; do not case-convert UUID.
3. Valid only if UUID parses and resolves to `EventHuman` where:
  - `EventHuman.id === ref`
  - `EventHuman.eventId === eventId in checkout`
  - `EventHuman.role === PERFORMER`
4. If validation fails, treat `ref` as invalid and continue with checkout selector fallback (no hard failure).
5. Persist both `refRaw` and normalized `refEventHumanId` (nullable) for debugging/audit.

### Checkout Attribution (Backup)

If a fan arrives without a `ref` parameter (e.g., typed the URL, clicked the venue's link), capture attribution at checkout:

**"Who are you most excited to see?"**

Render as optional chip selector showing the lineup (pulled from `EventHuman` where `role = PERFORMER`, sorted by `sortOrder`). Options include "All of them" and "Just exploring." This is low-friction — one tap, not required.

### Attribution Priority

1. Valid `ref` query parameter (`REF_LINK`)
2. Checkout selection (`CHECKOUT_SELECT`)
3. No attribution (`NONE`)

Tie-break rule: if both are present, `REF_LINK` always wins and checkout selection is stored only as metadata.

## Canonical Attribution Grain + Dedupe

Canonical grain is **one row per completed order per event**.

- `TicketAttribution` row is written once when order transitions to paid/succeeded.
- No per-order-item attribution in V1.
- Uniqueness is enforced with `@@unique([eventId, orderId])`.
- Retry dedupe is enforced with `@@unique([idempotencyKey])`.

Deterministic idempotency key:

`ticket-attribution:v1:{eventId}:{orderId}`

This key is stable across transport retries, webhook retries, and worker restarts.

---

## Data Model

### New: TicketAttribution

```prisma
model TicketAttribution {
  id              String    @id @default(uuid())
  eventId         String
  orderId         String
  
  // ── Canonical grain and idempotency ────────────────────────────
  /// Stable dedupe key: ticket-attribution:v1:{eventId}:{orderId}
  idempotencyKey  String

  // ── Who drove this purchase ─────────────────────────────────────
  /// FK to EventHuman (the performer who gets credit)
  attributedToEventHumanId  String?
  /// FK to Human record of the attributed performer (denormalized for query speed)
  attributedToHumanId       String?
  
  // ── Attribution method ──────────────────────────────────────────
  source          TicketAttributionSource   // REF_LINK, CHECKOUT_SELECT, NONE
  trackingConsent AttributionConsentStatus  @default(UNKNOWN)
  
  // ── Referral tracking ───────────────────────────────────────────
  refRaw          String?     // raw ref parameter value from URL
  refEventHumanId String?     // normalized immutable key (EventHuman.id)
  utmSource       String?     // instagram, twitter, facebook, email, etc.
  utmMedium       String?     // story, post, bio, link, etc.
  utmCampaign     String?     // artist-defined campaign name
  
  // ── Fan data (denormalized from Order.buyer) ────────────────────
  /// Null when consent is denied or data has been deleted/redacted
  fanHumanId      String?
  fanCity         String?     // from billing address or profile
  fanState        String?
  fanCountry      String?
  
  // ── Checkout selection ──────────────────────────────────────────
  checkoutArtistSelection   String?   // "ALL_OF_THEM" | "JUST_EXPLORING" | EventHuman.id
  
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  order           Order       @relation(fields: [orderId], references: [id], onDelete: Cascade)
  event           Event       @relation(fields: [eventId], references: [id], onDelete: Cascade)
  attributedToEventHuman EventHuman? @relation(fields: [attributedToEventHumanId], references: [id], onDelete: SetNull)
  attributedToHuman      Human?      @relation("AttributedArtist", fields: [attributedToHumanId], references: [id], onDelete: SetNull)
  fan             Human?      @relation("TicketFan", fields: [fanHumanId], references: [id], onDelete: SetNull)

  @@unique([eventId, orderId])
  @@unique([idempotencyKey])
  @@index([eventId])
  @@index([attributedToHumanId])
  @@index([attributedToEventHumanId])
  @@index([fanHumanId])
  @@index([eventId, attributedToHumanId])
  @@index([fanHumanId, eventId])
}
```

### New Enum

```prisma
enum TicketAttributionSource {
  REF_LINK          // Fan clicked artist's referral link
  CHECKOUT_SELECT   // Fan selected artist at checkout
  NONE              // No attribution data
}

enum AttributionConsentStatus {
  GRANTED
  DENIED
  UNKNOWN
}
```

### Modifications to Existing Models

**Order** — add relation:
```prisma
  attributions    TicketAttribution[]
```

**Event** — add relation:
```prisma
  ticketAttributions  TicketAttribution[]
```

**EventHuman** — add relation:
```prisma
  ticketAttributions  TicketAttribution[]
```

**Human** — add relations:
```prisma
  artistAttributions  TicketAttribution[]  @relation("AttributedArtist")
  fanAttributions     TicketAttribution[]  @relation("TicketFan")
```

---

## Referral Link Generation

### Artist Share Links

When an event is published with performers in the lineup (`EventHuman` records with `role = PERFORMER`), automatically generate share links for each performer.

Primary transport is tRPC.

**tRPC query:** `event.getPerformerShareLinks`

Input:

```ts
{ eventId: string }
```

Output:

Returns:
```json
{
  "performers": [
    {
      "eventHumanId": "...",
      "humanId": "...",
      "name": "Artist Name",
      "shareUrl": "https://hearthfire.community/events/friday-night-live?ref=3f7ab314-49f9-4e2d-b10e-e741f6956da4",
      "qrCodeUrl": "https://hearthfire.community/api/qr?url=..."
    }
  ],
  "venueUrl": "https://hearthfire.community/events/friday-night-live"
}
```

Optional thin REST wrapper (for non-tRPC clients):

- `GET /api/v1/events/{eventId}/share-links`
- Must delegate to the same use case, with no additional business logic.
- Versioning rule: additive response fields only in `v1`; breaking changes require `v2` route.

Each performer can access their share link from:
1. Their Ithas Fire dashboard (if they have an account)
2. An email sent automatically when they're added to the lineup
3. A public link the organizer shares with them

### QR Code Generation

Generate a QR code for each share link. Artists print this on flyers, display at merch tables, or share on social. The QR encodes the full referral URL including `ref` parameter.

---

## Checkout Integration

### Ref Parameter Capture

On the event detail page and checkout page, capture the `ref` query parameter from the URL on initial page load. Store it in session/state so it persists through the checkout flow even if the URL changes.

```typescript
// In event detail page or checkout
const searchParams = useSearchParams();
const ref = searchParams.get('ref');
const utmSource = searchParams.get('utm_source');
const utmMedium = searchParams.get('utm_medium');
const utmCampaign = searchParams.get('utm_campaign');
```

Pass these values through to the order creation endpoint.

### "Who Are You Here to See?" Selector

Add to the checkout flow (after ticket selection, before payment):

- Render only when the event has 2+ performers in the lineup
- Show performer names as tappable chips (same ChipGroup pattern from the review form)
- Include "All of them" and "Just exploring" options
- Optional — fan can skip without selecting
- Persist exactly one normalized value in `checkoutArtistSelection`: `ALL_OF_THEM`, `JUST_EXPLORING`, or selected `EventHuman.id`.

### Attribution Write Contract (Use Case + Transaction)

Attribution write must run in the same `repos.tx()` as order finalization.

Contract:

1. Use case validates order is eligible for finalization.
2. Within the same `repos.tx()`:
  - finalize order state
  - compute canonical attribution payload
  - upsert/insert `TicketAttribution` with deterministic `idempotencyKey`
  - append audit log event (`ticket.attribution.recorded`)
3. Commit once.

Idempotency behavior:

- Use `IdempotencyPort.begin(idempotencyKey)` before mutation path.
- On duplicate key / already-committed idempotency state, return existing attribution row and do not write duplicates.
- On transient failure, mark idempotency as failed and allow retry with same key.

---

## Analytics Views

### For Artists: "My Draw"

Artists see a dashboard showing:

- **Total tickets attributed to them** across all events
- **Draw by city** — map + table of where their fans are buying from
- **Draw over time** — are they growing in specific markets?
- **Draw by venue** — which venues work best for them?
- **Conversion by platform** — which social channels drive the most ticket sales? (from UTM data)
- **Repeat fans** — fans who've bought tickets to multiple events featuring this artist
- **Fan list** — email, name, city for consented, role-permitted attributed rows (export-scoped, not global raw access)

This is Joel's "621 superfans with names, emails, and locations" outcome when consent and role checks pass for that artist's attributed rows.

### For Venues/Organizers: "Event Intelligence"

Organizers see per-event:

- **Attribution breakdown** — which artists drove which percentage of ticket sales
- **Walk-in vs attributed** — how many tickets had no artist attribution (organic/venue-driven)
- **Genre performance** — which genre tags correlate with higher ticket sales at this venue
- **Day-of-week performance** — which nights sell better
- **Repeat attendees** — fans who've attended multiple events at this venue
- **Top-performing artists** — ranked by draw at this specific venue

### For the Platform: "Market Intelligence"

Ithas Fire sees across all events:

- **Artist draw rankings by city** — who's pulling in Nashville, who's pulling in Atlanta
- **Venue performance by genre** — which venues are best for indie, country, hip-hop
- **Fan density maps** — where are the most active fans geographically
- **Cross-pollination** — fans who attend events across multiple genres (valuable for discovery)

---

## Privacy & Data Ownership

Operational policy:

1. **Consent and opt-out semantics**
  - Attribution consent state is recorded as `GRANTED | DENIED | UNKNOWN`.
  - If consent is `DENIED`, store `source = NONE`, keep financial/order linkage, and redact fan-level PII fields (`fanHumanId`, `fanCity`, `fanState`, `fanCountry`).
  - If consent changes from granted to denied, run redaction job on existing attributable rows.

2. **Retention and deletion**
  - Fan-level attribution fields are retained for 24 months by default.
  - Aggregated event/artist metrics may be retained longer if no direct PII remains.
  - Deletion request must remove or redact fan-identifying fields while preserving non-PII aggregate counts.

3. **Export behavior**
  - Artist export includes only rows where `attributedToHumanId == artistHumanId` and consent is `GRANTED` at export time.
  - Export format includes source metadata (`source`, UTM fields, event/date) for auditability.

4. **Role-scoped visibility boundaries**
  - Performer role: fan-level rows only for attribution to that performer.
  - Organizer role: event-level aggregates only (no fan contact details).
  - Platform admin role: least-privilege support access, audited read path for sensitive exports.

### Consent State Field Semantics (Canonical)

The consent state governs what is preserved, what is redacted, and whether aggregate attribution credit remains available.

| Consent state | `source` + attribution credit | `attributedToEventHumanId` / `attributedToHumanId` | `fanHumanId` | `fanCity` / `fanState` / `fanCountry` | Export eligibility |
| --- | --- | --- | --- | --- | --- |
| `GRANTED` | Preserve computed `source`; include in aggregate attribution metrics. | Preserved. | Preserved. | Preserved (if collected). | Performer export allowed for role-permitted rows. |
| `DENIED` | Force persisted `source=NONE`; preserve non-PII aggregate counts only. | Preserved for aggregate attribution math and trend continuity. | Redacted (`null`). | Redacted (`null`). | Excluded from performer fan-level export. |
| `UNKNOWN` | Preserve computed `source`; include in aggregate attribution metrics. | Preserved. | Redacted (`null`) until positive consent is recorded. | Redacted (`null`) until positive consent is recorded. | Excluded from performer fan-level export. |

Consent transition rule:
- `GRANTED -> DENIED` must trigger redaction for existing rows (`fanHumanId`, `fanCity`, `fanState`, `fanCountry`) while preserving non-PII aggregate attribution credit.

### Standards Alignment

This spec aligns with:
- `docs/engineering-standards.md` section 4.2 (single transaction + audit logging), section 6 (idempotency), and section 8 (RBAC).
- `docs/hot-paths.md` sections "Idempotency and concurrency" and "Security and access control".

---

## Implementation Checklist

- [ ] Create `TicketAttribution` model + migration
- [ ] Add `TicketAttributionSource` enum
- [ ] Add `AttributionConsentStatus` enum
- [ ] Add relations to Order, Event, EventHuman, Human models
- [ ] Replace slug-based refs with immutable `EventHuman.id` refs
- [ ] Implement canonical `ref` parse/validate fallback rules
- [ ] Capture `ref` and UTM params on event detail page load, persist through checkout
- [ ] Pass attribution data to order creation endpoint
- [ ] Create `TicketAttribution` row with canonical grain (`eventId + orderId` uniqueness)
- [ ] Enforce dedupe with deterministic `idempotencyKey` unique constraint
- [ ] Write attribution in same `repos.tx()` as order finalization + audit log
- [ ] Build "Who are you here to see?" chip selector in checkout (conditional on 2+ performers)
- [ ] Build `event.getPerformerShareLinks` tRPC query + optional thin `GET /api/v1/...` wrapper
- [ ] Send auto-email to performers with their share link when added to lineup
- [ ] Build artist analytics dashboard: draw by city, by venue, by platform, repeat fans, fan list export
- [ ] Build organizer analytics: attribution breakdown, walk-in rate, genre performance, day-of-week
- [ ] Build fan data export for artists (CSV: email, name, city, events attended)
- [ ] Add privacy controls: fan opt-out, artist data export, retention + deletion/redaction support

---

## Test & Acceptance Matrix

1. **Happy path: valid referral attribution**
  - Given valid `ref` for performer on event
  - When order finalizes successfully
  - Then one `TicketAttribution` row exists with `source=REF_LINK`, correct performer IDs, and `@@unique([eventId, orderId])` satisfied.

2. **Fallback path: invalid referral + checkout selection**
  - Given invalid/mismatched `ref` and valid checkout selection
  - When order finalizes
  - Then row is written with `source=CHECKOUT_SELECT`, `refEventHumanId=null`, and selection metadata preserved.

3. **Retry/idempotency path**
  - Given duplicate transport/webhook delivery for same order
  - When finalize flow executes concurrently or repeatedly
  - Then exactly one row is committed; subsequent attempts return existing row via idempotency key.

4. **Conflict path: concurrent writes**
  - Given two workers try to record attribution for same `{eventId, orderId}`
  - When both reach persistence
  - Then one succeeds, one resolves as duplicate-without-side-effects, and audit log contains one `ticket.attribution.recorded`.

5. **Privacy redaction path: consent denied**
  - Given consent `DENIED`
  - When attribution is persisted
  - Then row keeps aggregate attribution state but fan-level PII fields are null/redacted.

6. **Deletion/export path**
  - Given fan deletion request or artist export request
  - When process runs
  - Then deletion redacts fan-identifying fields and export includes only consented, role-allowed rows.

7. **Precedence path: ref beats checkout selection**
  - Given a valid `ref` and a checkout chip selection are both present
  - When order finalizes
  - Then persisted attribution uses `source=REF_LINK`; checkout choice is retained only as non-authoritative metadata.

8. **RBAC visibility boundary path**
  - Given the same attributed dataset
  - When queried by performer, organizer, and platform admin roles
  - Then performer sees only own consent-allowed fan rows, organizer sees event aggregates only, and platform admin access is audited and least-privilege.

9. **Consent transition redaction path**
  - Given prior rows with `trackingConsent=GRANTED`
  - When consent changes to `DENIED`
  - Then historical fan-level identity/location fields are redacted and aggregate attribution credit remains intact.

10. **Denormalized identity integrity path**
  - Given an attributed row with both `attributedToEventHumanId` and `attributedToHumanId`
  - When performer identity relationships are validated
  - Then `TicketAttribution.attributedToHumanId` must match `EventHuman.humanId` for `attributedToEventHumanId`, or the write fails validation.

---

## Expected Product Outcomes

With this spec implemented:

1. Artists can measure draw by event, city, venue, and source with deterministic attribution logic.
2. Organizers can evaluate lineup performance using aggregate attribution analytics.
3. Attribution behavior remains safe under retries and concurrency.
4. Fan data handling is explicit for consent, export, retention, and deletion.

This preserves the product vision while making the behavior implementation-ready for core, adapters, and transport layers.
