# POS Operator Acknowledgement

**Date:** 2026-05-14 (rewritten lean from earlier maximal draft)
**Status:** implementation-ready
**Priority:** P1 (ships with first Tap to Pay rollout — blocked behind Apple LLC conversion anyway)
**Companion to:** `host-attestation.spec.md`, `../2026-04-26/scanner-deployment-tap-to-pay.spec.yaml`, ToS Section 6

---

## Why this exists at all

The organisation admin already agreed to platform ToS (Section 6 covers operator delegation, refund discipline, sales-tax responsibility). Stripe Connect onboarding covered the Card Present terms. So **why have anything user-facing in the scanner app at all?**

One reason: when an event staff member opens the scanner POS module for the first time, they're entering a financial-handling context. A 30-second "here's the obligations of running this device" modal serves two purposes:

1. **User education** — gives the operator a quick reminder of don'ts (don't share device, refund only through app, report lost device) so the org admin doesn't have to brief every volunteer themselves
2. **Soft legal touchpoint** — records that this specific user account saw and acknowledged the obligations on this date, useful in the rare case where misconduct happens and the user claims ignorance

This is **not** a contract; it's a UX moment. Square, Toast, Clover, and Stripe Dashboard all do this exact pattern. The legal weight rides on the org admin's ToS acceptance — the user-level ack is belt-and-suspenders comfort.

## Scope: Tier 2

Three possible tiers were considered (lean / middle / maximal). This spec is the middle:

- **Tier 1 (skipped — too minimal):** one timestamp column, no version. Breaks the day you tweak the wording.
- **Tier 2 (this spec):** timestamp + version columns + version constant + re-prompt on bump. ~80 lines of code.
- **Tier 3 (deferred — overengineered):** separate audit table with per-row policy snapshots, per-checkbox booleans, renewal cron, per-org variations. ~500 lines. Solves problems Ithas Fire doesn't have at current scale.

If we ever need Tier 3 (compliance auditor visit, complex multi-org operator litigation, etc.), the migration from Tier 2 → Tier 3 is "add a new table that records each ack, backfill from existing column pointers." Not a rewrite.

## Goals

- One blocking modal on first POS-screen entry per user
- Modal disappears forever after "Got it" — never shown again for the same version
- Bumping the policy version constant re-prompts every operator on next launch
- No per-org variation. Same modal text for everyone. (Defer until we hit an org with materially different obligations — probably never.)

## Non-Goals

- Audit table or per-ack history. Current column + git log of policy text constant is enough proof.
- Renewal cron. Org-membership removal already kicks out departed staff via the per-request `requireOrgRole` check.
- Per-checkbox granular booleans. One "Got it" button.
- Blocking non-POS scanner functions (ticket scan, attendee lookup). Only money-moving POS sale creation flows are gated.
- Forcing the user to scroll the FAQ link before enabling the button. Cheap to add if anyone ever asks for it.

## Context

| Surface | File |
|---|---|
| `Human` Prisma model | `packages/db/prisma/human.prisma` (or wherever Human is defined) |
| Scanner POS module | `apps/scanner/src/...` (specific path TBD when Tap to Pay UI lands) |
| POS tRPC router | `packages/transport/trpc/src/routers/pos.ts` (`pos.startSale`, `pos.recordCashSale`) |
| POS card sale use case | `packages/core/src/use-cases/pos/start-pos-sale.ts` |
| POS cash sale use case | `packages/core/src/use-cases/pos/record-cash-sale.ts` |
| tRPC humans router | `packages/transport/trpc/src/routers/humans.ts` (or similar) |
| ToS Section 6 (legal basis) | `apps/web/src/app/terms/page.tsx:149-197` |

## Data model

Two columns on `Human`:

```prisma
// in model Human
scannerTermsAckAt      DateTime?
scannerTermsAckVersion String?
```

Plus, optionally and very cheaply, IP + user-agent at time of ack — only useful for forensics if ever needed. Recommend including them; they're free:

```prisma
scannerTermsAckIp        String?
scannerTermsAckUserAgent String?
```

No new tables. No migrations beyond this column add. Nullable so existing users are unaffected.

## Policy text + version constant

In `packages/types/src/scanner-terms.ts` (new, exported by `@th/types`):

```ts
export const SCANNER_TERMS_VERSION = "1";

export const SCANNER_TERMS_TEXT: Record<string, ScannerTerms> = {
  "1": {
    title: "Before you take your first payment",
    bullets: [
      "Tap to Pay is in your user account name — sign out when you hand the device off.",
      "If the device is lost or stolen, tell your event organizer and Ithas Fire immediately.",
      "Refunds always go through the app — never refund in cash.",
      "Do not photograph or copy card numbers, PINs, or expiration dates.",
    ],
    confirmLabel: "Got it",
  },
};

export type ScannerTerms = {
  title: string;
  bullets: string[];
  confirmLabel: string;
};
```

When you change the bullets, bump the version key (`"2"`, `"3"`, etc.) and keep the old entry around so legacy acks can still be looked up. Old text never gets deleted; new versions get added.

Git history of this file is the legal audit trail. `git blame packages/types/src/scanner-terms.ts` answers "what did v2 say and when did it deploy."

The scanner app must not import `@th/core` for this copy. If needed, add `@th/types` as a scanner dependency/path alias and import the constants from `@th/types/scanner-terms` (or the package barrel). The core acknowledgement use case imports the same constants, so the modal and server validation share one source of truth.

## Use case

`packages/core/src/use-cases/humans/acknowledge-scanner-terms.ts`:

```ts
export const acknowledgeScannerTermsInputSchema = z.object({
  humanId: z.string().min(1),
  version: z.string().min(1),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});

type AckInput = {
  humanId: string;
  version: string;
  ipAddress: string | null;
  userAgent: string | null;
};

export async function acknowledgeScannerTerms(
  deps: Deps,
  rawInput: unknown,
): Promise<void> {
  const input = parseInput(acknowledgeScannerTermsInputSchema, rawInput);

  if (input.version !== SCANNER_TERMS_VERSION) {
    throw { code: "scanner_terms_version_mismatch" as const };
  }

  await deps.repos.tx(async (tx) => {
    await tx.humans.updateScannerTermsAck(input.humanId, {
      scannerTermsAckAt: new Date(),
      scannerTermsAckVersion: input.version,
      scannerTermsAckIp: input.ipAddress,
      scannerTermsAckUserAgent: input.userAgent,
    });

    await tx.auditLog.record({
      actorHumanId: input.humanId,
      action: "scanner_terms.acknowledged",
      metadata: { version: input.version },
    });
  });
}
```

That's it. One use case, one transaction, one small audit entry. Keep the repo method names aligned with the existing `Human`/audit ports when implementing; the invariant is that the ack write and audit log commit together.

## tRPC endpoint

`packages/transport/trpc/src/routers/humans.ts` adds:

```ts
acknowledgeScannerTerms: authedProcedure
  .input(z.object({ version: z.string() }))
  .mutation(async ({ ctx, input }) => {
    await acknowledgeScannerTerms(ctx.deps, {
      humanId: ctx.user.humanId,
      version: input.version,
      ipAddress: ctx.clientIp ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  }),
```

## Gate before POS sale creation — REQUIRED

The server must check the operator acknowledgement before any in-person sale creates local money-moving state. Gate these use cases:

- `start-pos-sale.ts` before creating the PENDING `Order` or card-present PaymentIntent
- `record-cash-sale.ts` before creating the SUCCEEDED cash order and minting/admitting tickets

The check is:

```ts
if (
  !user.scannerTermsAckAt ||
  user.scannerTermsAckVersion !== SCANNER_TERMS_VERSION
) {
  throw new ScannerTermsNotAcknowledgedError();
}
```

**Why this is non-negotiable:** the server is the source of truth. The client is whatever the user has on their device — possibly stale, possibly tampered, possibly a direct API call from a leaked token. "We don't trust the client" is the foundational principle of any code path that moves money. The cost of the gate is one `if` block and one test per sale-start use case; the cost of trusting the client is being unable to prove an operator saw the disclosure on the day a real incident happens.

When the client receives `SCANNER_TERMS_NOT_ACKNOWLEDGED` from `pos.startSale` or `pos.recordCashSale`, it opens the modal, lets the user ack, and retries. `pos.completeSale` is read-only polling and is too late to be the primary gate.

## Scanner UI

`apps/scanner/src/components/ScannerTermsModal.tsx` (new):

- Renders `SCANNER_TERMS_TEXT[SCANNER_TERMS_VERSION]` — title, bullet list, single Got it button
- Disabled state? No — there's nothing to validate. Single tap.
- Submit → calls tRPC `humans.acknowledgeScannerTerms({ version: SCANNER_TERMS_VERSION })` → on success, dismiss

`apps/scanner/src/screens/PosEntryScreen.tsx` (or wherever POS module entry lives):

```tsx
const needsAck =
  !user.scannerTermsAckAt ||
  user.scannerTermsAckVersion !== SCANNER_TERMS_VERSION;

if (needsAck) return <ScannerTermsModal />;
// otherwise show POS UI
```

Client refreshes `user` from the tRPC cache after ack so the modal goes away immediately.

## Tests

- **Unit:** `acknowledgeScannerTerms` writes the columns and audit log inside one transaction; rejects on version mismatch
- **Unit:** `startPosSale` and `recordCashSale` reject with `SCANNER_TERMS_NOT_ACKNOWLEDGED` before creating an order or PaymentIntent when `scannerTermsAckAt` is null or version mismatches; both succeed when current
- **E2E (scanner, manual until automated):** fresh user opens POS → modal blocks → tap Got it → can take a test payment; bumping `SCANNER_TERMS_VERSION` re-prompts existing users on next launch

## Rollout

Pure additive. Ships in whatever sprint contains the first Tap to Pay UI.

1. Prisma migration (adds the columns)
2. Backend (`scanner-terms.ts`, use case, tRPC endpoint, payment-endpoint check)
3. Scanner UI (`ScannerTermsModal`, gate on POS entry)

No feature flag needed — first-time users will trigger the modal naturally. No backfill because there are zero POS operators in prod today.

## When this spec needs to grow

Add Tier 3 (audit table) only if any of these become true:

- A compliance auditor (state, federal, or major partner) asks for "show me every ack event by every user over the past N years" and won't accept "we have git history of the policy + current pointers per user"
- We start letting one operator work for multiple orgs and need to track per-(operator, org) acceptance separately
- We get sued and the discovery process needs more granular records than git history gives

None of those are pre-launch concerns. Tier 2 → Tier 3 is a future task with a clear migration path; don't pre-pay it.

## Acceptance criteria

- The modal blocks the POS UI on first entry and disappears after Got it
- Bumping `SCANNER_TERMS_VERSION` re-prompts everyone on next POS open
- `acknowledgeScannerTerms` writes the four columns, records a generic audit-log entry in the same transaction, and rejects on version mismatch
- No dedicated scanner-terms history table; no renewal cron
- A user without a current ack cannot start a card or cash POS sale — `pos.startSale` / `pos.recordCashSale` return `SCANNER_TERMS_NOT_ACKNOWLEDGED` before creating orders or PaymentIntents
