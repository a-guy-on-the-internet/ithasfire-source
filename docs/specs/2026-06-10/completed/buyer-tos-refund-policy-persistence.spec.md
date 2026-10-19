# Buyer ToS + Refund Policy — Server-Authoritative Persistence

**Date:** 2026-06-10
**Status:** completed (shipped in `2791290f`; validated 2026-07-06 — all acceptance criteria pass. Deviation: `CURRENT_BUYER_TERMS_VERSION` shipped as `"2026-05"`, not the `"2026-04"` assumed below, matching the ToS version actually published at `/terms` and previously sent by web clients)
**Priority:** P1 (legal exposure on every paid checkout; cheap fix)
**Companion to:** `../../2026-05-17/completed/acceptance-records.spec.md` (AcceptanceRecord ledger), `../../2026-05-14/pos-attestation.spec.md` (operator-side ack), ToS page `apps/web/src/app/terms/page.tsx`

---

## Decision context (read this first)

We are **keeping the acceptance models separate** — this was decided explicitly on 2026-06-10:

- `EventAttestation` (typed per-event host facts) — stays its own table
- `WaiverAcceptance` (per-ticket, joins `WaiverTemplate`) — stays its own table
- `Order.*` point-in-time buyer stamps — stay on Order
- `Human.scannerTermsAck*` columns (POS operator ack, shipped 2026-06-10) — stays on columns; do NOT migrate it
- `AcceptanceRecord` — remains the narrow ledger for platform-wide, human-keyed, version-gated documents only

This spec does **not** consolidate anything. It fixes defects in how the buyer-side ToS and
refund-policy acceptances are persisted today, and adds the human-keyed ledger rows that the
`AcceptanceRecord` infrastructure already reserved enum values for.

## Current state (verified 2026-06-10 — corrects stale docs)

The comments in `enums.prisma` (`BUYER_TERMS // Currently un-persisted checkout checkbox`) and the
problem table in the acceptance-records spec are **stale**. Reality:

All four buyer entry points gate on the checkboxes AND stamp the Order:

| Entry point | Gate | Order stamp |
|---|---|---|
| `packages/core/src/use-cases/orders/create-checkout.ts` | `terms_required` (L165), `refund_policy_required` (L174) | L659-665 |
| `packages/core/src/use-cases/orders/claim-free-tickets.ts` | (verify gate parity — see Step 4) | L206-211 |
| `packages/core/src/use-cases/resale/create-resale-checkout.ts` | `terms_required` (L89), `refund_policy_required` (L98) | L391-397 |
| `packages/core/src/use-cases/embeds/create-embed-guest-checkout.ts` | `refund_policy_required` (L101) | delegates to `createCheckout` (L175), inherits its stamps |

What gets stamped on `Order` (`packages/db/prisma/order.prisma:43-51`):

- **Refund policy — done right.** `refundPolicyAckAt`, `refundPolicyAckIp`, `refundPolicyVersion`,
  `refundPolicyText` — version + verbatim text come from the server-side constant
  `CURRENT_REFUND_POLICY_VERSION = "platform-refund-2026-05"` in
  `packages/core/src/lib/payments/refund-policy.ts` (`getCurrentRefundPolicySnapshot()`).
- **ToS — done weakly.** `termsVersion`, `termsAcceptedAt` only. Three defects:
  1. **`termsVersion` is client-supplied** — `input.termsVersion ?? "2026-04"`
     (`create-checkout.ts:659,759,925`, `claim-free-tickets.ts:206,279`,
     `create-resale-checkout.ts:391,472`). A buyer's client can assert any version string.
     There is no server-side `CURRENT_BUYER_TERMS_VERSION` constant anywhere.
  2. No text snapshot (refund policy has one).
  3. No IP/UA (refund policy has IP).

What is genuinely **not** persisted: any cross-time, human-keyed record. "Has this human accepted
the current ToS?" requires scanning their orders. `AcceptanceDocumentType.BUYER_TERMS` and
`REFUND_POLICY` exist in the enum (`packages/db/prisma/enums.prisma:724-731`) but are **not
registered** in `DOCUMENT_REGISTRY` (`packages/core/src/lib/legal/acceptance.ts:30-39`), so the
ledger helpers throw if asked about them.

## Goals

1. The ToS version + text stamped on an Order come from a server-side constant, never from client input.
2. Every checkout writes (idempotently) a human-keyed `AcceptanceRecord` row for BUYER_TERMS and
   REFUND_POLICY at GLOBAL scope, carrying IP + user-agent — one row per human per document version.
3. Order point-in-time stamps remain the per-purchase source of truth (unchanged role).
4. Stale "un-persisted" comments corrected.

## Non-Goals

- No consolidation of EventAttestation / WaiverAcceptance / scanner-terms / Order fields (see decision context).
- No per-event or per-org refund policies. `getCurrentRefundPolicySnapshot()` is platform-wide; keep it.
- No re-prompt gate ("you must re-accept ToS vX before buying again"). The checkout checkbox renders
  every time anyway; version bumps are captured naturally on the next purchase. A blocking re-accept
  gate is a future product decision, not this spec.
- No new Order columns. ToS IP/UA forensics live on the ledger row, not the Order (the Order already
  carries `refundPolicyAckIp`; leave it).
- POS walk-up sales (`startPosSale` / `recordCashSale`) stay exempt: phantom buyers
  (`source: POS_WALKUP`) never see a checkout form. The operator-side obligations are covered by the
  scanner-terms ack. Do not add buyer ToS stamping to POS orders.
- No backfill of ledger rows from historical orders. Order stamps already exist for history; ledger
  starts accruing from deploy.

## Design

### 1. Server-side ToS constants

New `packages/core/src/lib/legal/buyer-terms.ts` (mirror `lib/payments/refund-policy.ts`):

```ts
export const CURRENT_BUYER_TERMS_VERSION = "2026-04"; // matches the version currently defaulted
export const CURRENT_BUYER_TERMS_TEXT = "..."; // short canonical summary + pointer, see note

export function getCurrentBuyerTermsSnapshot() {
  return { version: CURRENT_BUYER_TERMS_VERSION, text: CURRENT_BUYER_TERMS_TEXT };
}
```

Text note: follow whatever `CURRENT_REFUND_POLICY_TEXT` does in `refund-policy.ts` — same style,
same length discipline. The full ToS lives at `apps/web/src/app/terms/page.tsx`; the snapshot text
should be the checkbox-adjacent language the buyer actually saw plus the canonical URL + version
slug. Git history of the constant is the audit trail (same convention as chargeback + scanner terms).

Keep the initial version at `"2026-04"` so existing Order rows and new ones agree until legal
actually revs the document.

### 2. Stamp from the server constant

In `create-checkout.ts`, `claim-free-tickets.ts`, `create-resale-checkout.ts`:

- Replace every `termsVersion: input.termsVersion ?? "2026-04"` with
  `termsVersion: CURRENT_BUYER_TERMS_VERSION` (all occurrences — create-checkout has three:
  L659, L759, L925; claim-free-tickets two: L206, L279; resale two: L391, L472).
- Remove `termsVersion` from the input schemas of all three use cases AND from
  `create-embed-guest-checkout.ts` (schema L51, pass-through L193). Clients no longer send it.
  Check `apps/web` checkout forms and the embed widget for callers that still pass it and drop
  the field there too (it was optional everywhere, so this is non-breaking).

### 3. Ledger rows (the genuinely new persistence)

Register both documents in `DOCUMENT_REGISTRY` (`packages/core/src/lib/legal/acceptance.ts`):

```ts
BUYER_TERMS: {
  type: "BUYER_TERMS",
  currentVersion: CURRENT_BUYER_TERMS_VERSION,
  currentText: CURRENT_BUYER_TERMS_TEXT,
  scopeType: "GLOBAL",
},
REFUND_POLICY: {
  type: "REFUND_POLICY",
  currentVersion: CURRENT_REFUND_POLICY_VERSION,
  currentText: CURRENT_REFUND_POLICY_TEXT,   // export from refund-policy.ts if not already
  scopeType: "GLOBAL",
},
```

Then, in the same transaction that creates the Order in `create-checkout.ts`,
`claim-free-tickets.ts`, and `create-resale-checkout.ts` (embed inherits via delegation), after the
order create:

```ts
await recordAcceptance({
  repos: tx,
  humanId: input.buyerHumanId,
  documentType: "BUYER_TERMS",
  scopeType: "GLOBAL",
  scopeId: null,
  acceptedAt: now,
  ipAddress: input.requestIp ?? null,
  userAgent: input.requestUserAgent ?? null,
});
await recordAcceptance({ ...same, documentType: "REFUND_POLICY" });
```

`recordAcceptance` is already idempotent per (human, documentType, version, scope) — repeat buyers
cost zero extra rows until a version bump. Volume is one row per human per document version.

Guest + phantom nuance: embed guests get a real `humanId` via `ensureGuestHuman`, so ledger rows
work for them. (POS phantoms are exempt per Non-Goals.)

### 4. Plumb user-agent + verify gate parity

- All three use-case input schemas already carry `requestIp`. Add `requestUserAgent: z.string().nullable().optional()`
  alongside, and set it from `ctx.userAgent` in the tRPC routers that call them
  (`packages/transport/trpc/src/routers/orders.ts`, `resale.ts`, `embeds.ts` — same pattern as
  `humans.acknowledgeScannerTerms` uses `ctx.clientIp` / `ctx.userAgent`; both fields exist on ctx).
- **Verify `claimFreeTickets` gates `termsAccepted`/`refundPolicyAccepted` the same way
  `createCheckout` does** (it stamps both but the gate wasn't confirmed during scoping). If the gate
  is missing, add it — free claims still bind the claimer to ToS + refund policy.

### 5. Doc/comment cleanup

- `packages/db/prisma/enums.prisma:726-727`: update `BUYER_TERMS` / `REFUND_POLICY` comments —
  they're now registered + dual-written (Order stamp + ledger row), not "un-persisted".
- `packages/core/src/lib/legal/acceptance.ts:24-28`: update the registry doc comment (BUYER_TERMS /
  REFUND_POLICY are no longer "future").
- `docs/specs/2026-05-17/completed/acceptance-records.spec.md`: tick the relevant status-checklist
  items if appropriate; note that the problem-table rows 3-4 were superseded by Order stamps + this spec.

## Tests

- **Unit (each of the 3 use cases):** order stamp uses `CURRENT_BUYER_TERMS_VERSION` regardless of
  any client-supplied value (schema rejects/strips it); both ledger rows written in the same tx as
  the order with ip/ua; replay via idempotency cache does NOT duplicate ledger rows (early return
  precedes the tx — assert no second `acceptances.create`).
- **Unit:** repeat purchase by the same human creates no new ledger row for the same version;
  bumping `CURRENT_BUYER_TERMS_VERSION` in the test causes a second row.
- **Unit:** embed guest checkout produces ledger rows keyed to the guest human.
- **Unit:** `claimFreeTickets` rejects without `termsAccepted` / `refundPolicyAccepted` (after Step 4 verification/fix).
- **Existing tests** asserting `termsVersion: "2026-04"` keep passing because the constant starts at `"2026-04"`.

## Rollout

Pure additive + one input-field removal (optional field — non-breaking). No migration (table,
enums, and repo already exist from the acceptance-records Phase 1). No feature flag. No backfill.

Suggested order:
1. `buyer-terms.ts` constants + export `CURRENT_REFUND_POLICY_TEXT` from refund-policy.ts
2. Registry entries
3. Use-case changes (server-stamp + ledger writes + `requestUserAgent`) — one use case at a time, tests with each
4. Router plumbing + client field removal sweep
5. Comment/doc cleanup

## Acceptance criteria

- `git grep "input.termsVersion"` returns nothing in `packages/core`.
- A paid checkout, a free claim, a resale purchase, and an embed guest purchase each produce: the
  existing Order stamps (ToS version now server-authoritative) AND exactly two GLOBAL-scope
  `AcceptanceRecord` rows (first purchase) / zero new rows (repeat purchase, same versions), each
  with ip + user-agent populated.
- Bumping `CURRENT_BUYER_TERMS_VERSION` or `CURRENT_REFUND_POLICY_VERSION` causes the next purchase
  per human to write a fresh ledger row.
- POS sales produce no buyer ledger rows or ToS stamps (unchanged).
- The stale "un-persisted" comments are gone.
