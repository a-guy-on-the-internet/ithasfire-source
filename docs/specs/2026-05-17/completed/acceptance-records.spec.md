# AcceptanceRecord — Narrow Unification for Platform-Wide Documents

**Date:** 2026-05-17
**Status:** complete
**Priority:** P2 (pre-launch foundation — cheap to do before any real organizer accepts anything; expensive to retrofit after)
**Depends on:** `Organization`/`Human` schema (existing chargeback fields will be migrated off), authn (`actorHumanId` on every authenticated call)
**Does NOT replace:** `EventAttestation` (per-event typed facts), `WaiverAcceptance` (per-ticket, joins to `WaiverTemplate`), `Order.*` chargeback fields (point-in-time buyer-side acceptances).

---

## Problem

Ithas Fire already has six places that record "a human accepted a document":

| Acceptance | Stored on | Lifecycle | Notes |
|---|---|---|---|
| Chargeback / payout-hold terms (organizer) | `Organization.chargebackTerms{Version,AcceptedAt,AcceptedByHumanId}` + parallel `Human.chargebackTerms{Version,AcceptedAt}` | Once per org/human, re-accept on version bump | Two parallel field-sets doing the same thing |
| Host responsibilities | `EventAttestation` table (per-event row) | Per private-location publish | Has 5 typed sub-checkboxes |
| Buyer Terms of Service at checkout | (no structured persistence; checkbox state only) | Every checkout | **Superseded 2026-06-10:** stamped on `Order.termsVersion/termsAcceptedAt` + GLOBAL `AcceptanceRecord` ledger row — see `../../2026-06-10/completed/buyer-tos-refund-policy-persistence.spec.md` |
| Refund policy acknowledgement | Same as above (form state) | Every checkout | **Superseded 2026-06-10:** stamped on `Order.refundPolicyAck*` + GLOBAL `AcceptanceRecord` ledger row — same spec as above |
| Event waiver | `WaiverAcceptance` table, joins `WaiverTemplate` | Per ticket if event has waiver | Has its own typed template relationship |
| Chargeback terms (buyer-side, 2026-05-15 migration) | `Order.chargebackTerms*` fields | Every checkout | Point-in-time, frozen to the order |

The first row is structurally redundant with itself (Organization + Human carrying the same field-set in parallel). The third and fourth aren't persisted at all. A future master Organizer ToS would add a *fourth* parallel field-set if we keep the current pattern.

Meanwhile rows 2, 5, and 6 have **typed, per-doc structure** that benefits from staying in dedicated tables. Forcing them under a generic shape would create a leaky abstraction.

This spec scopes a **narrow** unification: introduce one table for the "platform-wide, human-keyed, version-gated" documents, and migrate only the rows that fit that pattern.

## Non-goals

- **Do not** absorb `EventAttestation`. Its 5 typed sub-checkboxes and per-event scope are well-served by the dedicated table.
- **Do not** absorb `WaiverAcceptance`. Its FK to `WaiverTemplate` is structural, not just a text snapshot.
- **Do not** absorb point-in-time buyer-side fields on `Order`. They don't need cross-time querying ("has this buyer ever accepted X").
- **Do not** ship a CMS-style document registry. The doc text lives in code (`CURRENT_*_TERMS_TEXT` constants), versioned via const bumps. That model is working for chargeback terms and there's no reason to change it.

## Goal

A single table that stores acceptances for documents matching all of:
1. **Platform-wide** — applies to every event/org, not specific to one entity
2. **Human-keyed** — bound to the natural person who clicked accept, not to an org or order
3. **Version-gated** — a bump in the document's `CURRENT_VERSION` constant invalidates all prior acceptances and forces re-accept
4. **Free of typed sub-structure** — text + checkbox, no per-field business logic

Documents that qualify today and in the near future:
- Chargeback / payout-hold terms (organizer-side)
- Master Organizer Terms of Service (planned — see separate spec)
- Buyer Terms of Service (the checkbox we currently don't persist)
- Privacy policy version bumps
- Age verification confirmation (when COPPA / 18+ events ship)

## Why per-human, not per-organizer

The current `Organization.chargebackTermsAcceptedAt` has a latent bug: when Human A accepts on behalf of Org A, that row is written, and any Human B who later joins Org A inherits the acceptance through the org without ever having personally consented. In a deposition, "the org accepted" is a weaker posture than "Human B accepted on date X, IP Y, UA Z."

Binding acceptances to the human directly:
- Survives membership churn (new admins must accept; departed admins keep their record)
- Matches how Stripe Connect / Plaid / every fintech treats principal acceptances
- Lets us compute org-level state as a *derived view* ("does this org have at least one current admin with current acceptance?") rather than a stored fact

## Schema

```prisma
model AcceptanceRecord {
  id        String  @id @default(uuid())

  /// Natural person who clicked accept. Never null. The actor — not an
  /// org membership, not an order — is the source of legal truth.
  humanId   String

  /// Stable enum of platform-wide documents. New documents add a value.
  documentType AcceptanceDocumentType

  /// e.g. "2026-05-17". Bumping this constant in code invalidates all
  /// prior acceptances of the same documentType and forces re-accept on
  /// the next gate check.
  documentVersion String

  /// Verbatim text the user saw — kept for forensic value. If legal
  /// rewrites the text, version bumps; this column preserves the exact
  /// rendering the user agreed to.
  documentTextSnapshot String

  /// Optional scope discriminator for documents accepted on behalf of
  /// something else.
  ///   • GLOBAL  — applies to the human across all activity (privacy
  ///               policy, age verification, master ToS)
  ///   • ORGANIZATION — accepted by a human in their capacity as an admin
  ///                    of a specific org (chargeback terms organizer-side)
  ///   • EVENT   — reserved for future use (per-event acceptances that
  ///               aren't typed enough to deserve EventAttestation)
  scopeType AcceptanceScope @default(GLOBAL)
  scopeId   String?

  acceptedAt DateTime @default(now())
  ipAddress  String?
  userAgent  String?

  /// Optional small blob for document-specific metadata. Use sparingly;
  /// anything that needs validation belongs in a typed table, not here.
  metadata   Json?

  human Human @relation(fields: [humanId], references: [id], onDelete: Cascade)

  @@index([humanId, documentType, documentVersion])
  @@index([scopeType, scopeId, documentType])
  @@index([documentType, documentVersion]) // version-bump invalidation queries
}

enum AcceptanceDocumentType {
  CHARGEBACK_TERMS_ORGANIZER  // Migration target for current chargeback fields
  BUYER_TERMS                 // Currently un-persisted checkout checkbox
  REFUND_POLICY               // Currently un-persisted checkout checkbox
  ORGANIZER_TERMS             // Future master Organizer ToS
  PRIVACY_POLICY              // Future
  AGE_VERIFICATION            // Future
}

enum AcceptanceScope {
  GLOBAL
  ORGANIZATION
  EVENT
}
```

## Helper API

```ts
// packages/core/src/lib/legal/acceptance.ts

export type DocumentSpec = {
  type: AcceptanceDocumentType;
  currentVersion: string;
  currentText: string;
  scopeType: AcceptanceScope;
};

/** Central registry — single source of truth for what version is current. */
export const DOCUMENT_REGISTRY: Record<AcceptanceDocumentType, DocumentSpec> = {
  CHARGEBACK_TERMS_ORGANIZER: {
    type: "CHARGEBACK_TERMS_ORGANIZER",
    currentVersion: CURRENT_CHARGEBACK_TERMS_VERSION,
    currentText: CURRENT_CHARGEBACK_TERMS_TEXT,
    scopeType: "ORGANIZATION",
  },
  // …
};

export async function hasCurrentAcceptance(input: {
  repos: Pick<TxRepos, "acceptances">;
  humanId: string;
  documentType: AcceptanceDocumentType;
  scopeType?: AcceptanceScope;
  scopeId?: string | null;
}): Promise<boolean>;

export async function recordAcceptance(input: {
  repos: Pick<TxRepos, "acceptances">;
  humanId: string;
  documentType: AcceptanceDocumentType;
  scopeType: AcceptanceScope;
  scopeId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<AcceptanceRecord>;
```

Existing `requireCurrentChargebackTermsForPaidEvent` is rewritten to call `hasCurrentAcceptance({humanId: actorHumanId, documentType: "CHARGEBACK_TERMS_ORGANIZER", scopeType: "ORGANIZATION", scopeId: event.orgId})` — same gate, new backend.

## Migration plan

### Phase 1 — additive (no breaking change)

1. Add `AcceptanceRecord` table + enums via Prisma migration.
2. Add `acceptancesRepo` to ports + prisma adapter.
3. Add the registry + helpers in `packages/core/src/lib/legal/`.
4. **Dual-write**: `accept-chargeback-terms` use case writes to both `Organization.chargebackTerms*` (existing) AND `AcceptanceRecord` (new). Reads continue from the old field for now. Zero behavior change.

### Phase 2 — read-side migration

5. Backfill: for every existing `Organization` and `Human` row with `chargebackTermsAcceptedAt != null`, insert a corresponding `AcceptanceRecord`. Run idempotently (skip if a matching row exists).
6. Update `requireCurrentChargebackTermsForPaidEvent` to read from `AcceptanceRecord` instead of `Organization.chargebackTerms*`.
7. After one deploy cycle of dual-write + new reads, stop writing to the legacy fields.

### Phase 3 — schema cleanup

8. Drop `chargebackTerms*` columns from `Organization` and `Human` in a follow-up migration. (Optional — leave them for a release as a safety net.)

### New documents skip all of this

When master Organizer ToS lands, it just registers a new `AcceptanceDocumentType` and uses the helpers. No new fields, no new migrations.

## What the UX looks like

No visible change for organizers in Phase 1 or 2 — the same modals appear at the same moments. In Phase 3, the modal copy can shift slightly because we're no longer accepting "chargeback terms" specifically; we're accepting a versioned document tracked uniformly.

The bigger UX win comes when the **second** platform-wide document lands (master Organizer ToS). With this infrastructure, that flow is:

- Define `ORGANIZER_TERMS_TEXT` + `ORGANIZER_TERMS_VERSION` constants
- Add the enum value
- Register in `DOCUMENT_REGISTRY`
- Add the gate at the right spot (first event create / first publish / etc.)

No new schema, no new fields, no new tables. The renderer can be generic too — `usePendingAcceptances({ humanId, scopeId })` returns the list of documents to prompt for, and a single `<AcceptanceModal />` component renders any of them.

## Risk and review

- **The metadata blob is the foot-gun.** If any future document needs validation on a sub-field, it's tempting to drop it in `metadata` and skip building a proper table. The rule: if it needs validation, it doesn't belong here. Keep it text + checkbox.
- **The version-as-string scheme** is the same as today's chargeback terms. Calendar-style (`"2026-05-17"`) is fine; semver would be overkill for documents that bump once or twice a year.
- **Indexes** assume the dominant query is "does this human have current acceptance of doc X (optionally in scope Y)?" That's true for gates. If we add a "list all acceptances by human" admin view later, we may need another index.

## Status checklist

- [x] Phase 1 — schema + helpers + dual-write
- [ ] Phase 2 — backfill + read-side migration
- [ ] Phase 3 — drop legacy columns
- [ ] Use case rewired: `requireCurrentChargebackTermsForPaidEvent`
- [x] Use case rewired: `accept-chargeback-terms` tRPC
- [ ] Generic `<AcceptanceModal />` component in `@th/ui` or `apps/web/_components`
- [x] First *new* document plumbed through — BUYER_TERMS + REFUND_POLICY registered and dual-written by the buyer checkout flows (2026-06-10, `../../2026-06-10/completed/buyer-tos-refund-policy-persistence.spec.md`)

## Related specs

- `docs/specs/2026-05-14/host-attestation.spec.md` — per-event typed attestation; **stays separate**, doesn't migrate
- `docs/specs/2026-03-25/waiver-system.spec.md` — per-ticket waiver acceptance; **stays separate**, joins to template
- Future spec (TBD): **Master Organizer Terms of Service** — collapses the chargeback terms + general organizer reps into a single document accepted at first event publish, using this AcceptanceRecord infrastructure
