# Chargeback / Dispute Handling

**Date:** 2026-05-14
**Status:** complete
**Priority:** P0 (launch blocker — platform-liability risk)
**Depends on:** Stripe platform-account PaymentIntents + explicit Connect transfers (`packages/adapters/src/payment-processors/stripe/stripe-adapter.ts`), refund flow (`packages/core/src/use-cases/orders/refund-order-items.ts`), settlement pipeline (`packages/core/src/use-cases/settlements/`), Stripe webhook router (`apps/api/src/routes/stripe/webhook.ts`)

---

## Problem

Stripe Connect is configured with **platform liability** for refunds and chargebacks. When a buyer disputes a charge, Stripe immediately debits our platform balance for the disputed amount plus a non-refundable dispute fee. The connected account or settlement payee is **not** automatically debited. Recovering the loss from future payouts is our responsibility.

Today the codebase has none of the machinery required to make this safe:

1. `charge.dispute.created` and `charge.dispute.closed` are currently logged in `apps/api/src/routes/stripe/webhook.ts`, but they do not persist dispute state, hold settlements, or notify anyone. Other lifecycle events such as `charge.dispute.funds_withdrawn`, `charge.dispute.updated`, and warning events are not modeled as first-class workflow inputs.
2. Settlements are generated from order splits after order finalization. A dispute filed after settlement generation can still leave the organiser eligible for payout unless the settlement pipeline explicitly checks dispute state and ledger holds.
3. There is no payee-scoped ledger or running balance. Every payout is a fresh per-order transfer. There is no mechanism to claw back a loss from a future payout for the payee who would otherwise receive the disputed funds.
4. No evidence package is assembled automatically when a dispute is filed. Stripe gives roughly 7-21 days; manual evidence gathering per dispute is not realistic at volume.
5. No platform-wide dispute-rate monitoring exists. A single fraudulent or sloppy organiser can push the platform over network thresholds, which gets the whole merchant account flagged and eventually terminated.

The realistic loss scenarios:

- **Silent leakage:** organiser is paid, buyer disputes, we eat the full amount. No alert, no clawback. Repeat at scale.
- **Operational paralysis:** 50 disputes land in a week, ops manually pulls evidence for each and misses the response window on half. Half are auto-lost.
- **Existential:** dispute rate climbs above network thresholds. Stripe places us in a monitoring program; eventually our processing is terminated and the platform stops functioning.

## Goals

- Detect every dispute lifecycle event from Stripe and persist it as a first-class entity.
- Hold organiser payouts the instant a dispute is opened on one of their orders.
- Assemble a baseline evidence package (receipt, scan log, refund-policy acknowledgement, AVS result when available, customer comms when available) within minutes of dispute creation, then route it to platform ops for approval before submission.
- Claw back lost-dispute exposure from future payouts via a payee-scoped balance ledger. The event risk owner is the owning organization or direct human owner, but payout math must follow the existing `Payee` settlement model.
- Make organisers explicitly aware that chargebacks can cause payout holds, payout skips, and future-payout recovery before they can take real payments.
- Surface disputes to platform ops in real time and notify organisers when money is held, a dispute needs context, or a lost dispute affects a payout.
- Add prevention controls (billing descriptor, checkout policy acknowledgement, opportunistic 3DS) to keep disputes from being filed in the first place. The baseline quick wins are tracked in `dispute-prevention-quick-wins.spec.md`; advanced Radar rules are later tuning, not required for the initial hold/evidence loop.
- Keep the dispute-response phases behind feature flags so they can be rolled out and rolled back independently. The companion prevention quick wins can ship without flags unless product wants a slower rollout.

## Non-Goals

- Replacing the existing refund flow. Current online and POS checkout use platform-account charges plus explicit settlement transfers, so transfer reversal remains the source of truth for settled refunds. Future application-fee flows may also pass Stripe's fee/transfer reversal flags where applicable.
- Building a full fraud-scoring engine. We rely on Stripe Radar defaults at launch; custom Radar rules are post-launch tuning once real dispute data exists. Custom fraud ML is out of scope.
- Automatic rolling-reserve infrastructure for high-risk organisers. `reservePct` defaults to `0`; any reserve is a later, manual ops tool after legal terms and organiser notice exist.
- Changing the charge model, settlement architecture, or Connect account type.
- Replacing the per-order settlement model wholesale. The payee ledger is added alongside, not as a replacement, so existing payouts keep working during cutover.

## Context

| Surface | File |
|---|---|
| Stripe webhook router | `apps/api/src/routes/stripe/webhook.ts` |
| Stripe adapter (payments port) | `packages/adapters/src/payment-processors/stripe/stripe-adapter.ts` |
| Refund use case (item-level) | `packages/core/src/use-cases/orders/refund-order-items.ts` |
| Refund use case (full order) | `packages/core/src/use-cases/orders/refund-full-order.ts` |
| Transfer reversal use case | `packages/core/src/use-cases/orders/reverse-transfers-for-items.ts` |
| Settlement creation | `packages/core/src/use-cases/settlements/create-from-order.ts` |
| Settlement batch executor | `packages/core/src/use-cases/settlements/run-batch.ts` |
| Settlement transfer | `packages/core/src/use-cases/settlements/execute-transfer.ts` |
| Order entities | `packages/core/src/entities/order.ts` |
| Prisma schema | `packages/db/prisma/*.prisma` (`finance.prisma` for dispute/ledger models, plus relation additions in `order.prisma` and `org.prisma`) |
| Org email / notification adapters | `packages/adapters/src/notifications/` |

## Threat model & loss boundaries

Per-dispute cost when lost: `disputed_amount + dispute_fee + processor/acquirer fees if applicable + ops time`.

Per-platform-wide cost when dispute rate breaches network thresholds:

- **Visa Dispute Monitoring Program (VDMP):** triggered at 100 disputes / month and 0.9% ratio. Fines start at $50/dispute and escalate.
- **Mastercard Excessive Chargeback Merchant (ECM):** triggered at 100 disputes / month and 1.5% ratio for two consecutive months.
- Termination of Stripe processing is possible above sustained excessive levels.

Mitigation philosophy: **prevention first, fast evidence second, clawback third, monitoring throughout.**

## Data model

New dispute and ledger models should live with the existing money models in `packages/db/prisma/finance.prisma` unless implementation finds that file too large to keep readable. Relation fields belong in `order.prisma` and `org.prisma`.

### `Dispute`

```prisma
model Dispute {
  id                  String         @id @default(cuid())
  stripeDisputeId     String         @unique
  stripeChargeId      String
  paymentIntentId     String?
  orderId             String?
  order               Order?         @relation(fields: [orderId], references: [id])
  ownerSubjectType    PayeeSubjectType? // ORGANIZATION | HUMAN; null only while orphaned
  ownerSubjectId      String?           // matches the Payee subject that owns the disputed event revenue
  ownerOrgId          String?           // set when ownerSubjectType = ORGANIZATION
  ownerOrg            Organization?     @relation("OrganizationDisputes", fields: [ownerOrgId], references: [id])
  ownerHumanId        String?           // set when ownerSubjectType = HUMAN
  ownerHuman          Human?            @relation("HumanDisputes", fields: [ownerHumanId], references: [id])
  amountCents         Int
  currency            String         @db.VarChar(3)
  reason              String         // Stripe's reason code
  status              DisputeStatus  // NEEDS_TRIAGE | OPEN | UNDER_REVIEW | WON | LOST | WARNING_CLOSED
  triageReason        String?
  linkedAt            DateTime?
  evidenceSubmittedAt DateTime?
  evidenceDueBy       DateTime?
  fundsWithdrawnAt    DateTime?
  closedAt            DateTime?
  outcome             String?        // Stripe's closing reason
  metadata            Json?
  createdAt           DateTime       @default(now())
  updatedAt           DateTime       @updatedAt

  evidence            DisputeEvidence[]
  ledgerEntries       PayeeLedgerEntry[]

  @@index([orderId])
  @@index([ownerSubjectType, ownerSubjectId, status])
  @@index([ownerOrgId, status])
  @@index([ownerHumanId, status])
  @@index([status, evidenceDueBy])
}

enum DisputeStatus {
  NEEDS_TRIAGE
  OPEN
  UNDER_REVIEW
  WON
  LOST
  WARNING_CLOSED
}
```

When a dispute is linked to a local order, exactly one risk-owner relation must be set:

- Org-owned event: `ownerSubjectType = ORGANIZATION`, `ownerSubjectId = event.orgId`, `ownerOrgId = event.orgId`, `ownerHumanId = null`.
- Direct human-owned event: `ownerSubjectType = HUMAN`, `ownerSubjectId = event.humanId`, `ownerHumanId = event.humanId`, `ownerOrgId = null`.

Do not treat `ownerOrgId = null` as orphaned by itself; `status = NEEDS_TRIAGE` plus missing `ownerSubjectType` is the orphan signal.

### `DisputeEvidence`

Records what we submitted and when. Append-only.

```prisma
model DisputeEvidence {
  id          String   @id @default(cuid())
  disputeId   String
  dispute     Dispute  @relation(fields: [disputeId], references: [id])
  payload     Json     // mirrors Stripe DisputeEvidence shape
  submittedAt DateTime @default(now())
  submittedBy String   // 'system' | userId
  stripeResp  Json?
}
```

### `PayeeLedgerEntry`

Per-settlement-payee running ledger. Settlements *credit* the ledger; refunds and lost disputes *debit* it. Payouts draw against the balance. This matches the current payout pipeline, where `OrderSplit`, `Settlement`, and `PayoutItem` are all keyed by `Payee`.

```prisma
model PayeeLedgerEntry {
  id             String               @id @default(cuid())
  idempotencyKey String               @unique
  payeeId        String
  payee          Payee                @relation("PayeeLedger", fields: [payeeId], references: [id])
  type           PayeeLedgerEntryType // SETTLEMENT_CREDIT | REFUND_DEBIT | DISPUTE_HOLD | DISPUTE_DEBIT | DISPUTE_RELEASE | PAYOUT | RESERVE_HOLD | RESERVE_RELEASE | MANUAL_ADJUSTMENT
  amountCents    Int                  // signed; credits positive, debits negative. Holds affect pendingHoldCents until released/debited.
  currency       String               @db.VarChar(3)
  sourceKind     String               // settlement_line | refund | dispute | payout_item | reserve | manual
  sourceId       String
  orderId        String?
  settlementId   String?
  disputeId      String?
  dispute        Dispute?             @relation(fields: [disputeId], references: [id])
  relatedEntryId String?              // release/debit entries point back to the hold entry when applicable
  relatedEntry   PayeeLedgerEntry?    @relation("PayeeLedgerEntryRelated", fields: [relatedEntryId], references: [id])
  relatedEntries PayeeLedgerEntry[]   @relation("PayeeLedgerEntryRelated")
  description    String
  metadata       Json?
  createdAt      DateTime             @default(now())

  @@index([payeeId, createdAt])
  @@index([orderId])
  @@index([disputeId])
}

enum PayeeLedgerEntryType {
  SETTLEMENT_CREDIT
  REFUND_DEBIT
  DISPUTE_HOLD
  DISPUTE_DEBIT
  DISPUTE_RELEASE
  PAYOUT
  RESERVE_HOLD
  RESERVE_RELEASE
  MANUAL_ADJUSTMENT
}
```

### Liability and amount rules

Launch v1 treats payout exposure as payee-scoped:

- Dispute hold amount per payee = that payee's unpaid order-split/settlement-line share for the disputed order.
- Lost-dispute debit per payee = the full affected payee-share liability, less only prior real debits or settled recoveries. Pending holds are released/closed separately and never reduce the real `DISPUTE_DEBIT` amount.
- `DISPUTE_DEBIT` and `REFUND_DEBIT` only apply to payee-share amounts that already have a `SETTLEMENT_CREDIT`. If a dispute is lost or a refund occurs before any settlement credit exists for that payee/share, void or skip the unpaid share instead of creating negative balance against unrelated future revenue.
- Platform fees, processor fees, taxes, and Stripe's dispute fee remain platform exposure unless legal/product explicitly approve passing them to the event-owner payee.
- If product decides the event risk owner should absorb 100% of the buyer dispute amount, implement that as a separate policy decision by debiting the owner `Payee` (`subjectType = ORGANIZATION` or `HUMAN`) rather than all split payees.
- Partial disputes/refunds must prorate hold/debit amounts by order item and split share; do not debit unrelated items or payees.
- Ledger balances are currency-isolated. Do not net a USD debt against an EUR payout. `PayeeLedgerRepo.getBalance` must take a currency and return balances for that currency only.

### `Order` additions

```prisma
disputes           Dispute[]
disputedAt          DateTime?
disputeStatus       DisputeStatus? // mirror of latest dispute
checkoutIp          String?        // server-observed request IP at checkout, not client supplied
refundPolicyAckAt   DateTime?      // when buyer accepted refund policy
refundPolicyAckIp   String?
refundPolicyVersion String?
refundPolicyText    String?        // snapshot of the rendered policy text shown at purchase time
billingDescriptor   String?        // captured snapshot
```

`refundPolicyAckAt`, `refundPolicyAckIp`, `refundPolicyVersion`, `refundPolicyText`, and `billingDescriptor` already shipped with the quick-wins work. The dispute migration should add only the missing relation/status/IP fields and must not attempt to recreate existing columns.

### `Payee` additions

```prisma
ledgerEntries     PayeeLedgerEntry[] @relation("PayeeLedger")
ledgerBalances    PayeeLedgerBalance[]
reservePct        Int       @default(0) // manual, Phase 5 only; default stays 0
payoutSuspendedAt DateTime?
```

### `PayeeLedgerBalance`

Per-payee, per-currency denormalised balance. This avoids pretending one payee has a single balance when orders can carry different currencies.

```prisma
model PayeeLedgerBalance {
  payeeId                String
  payee                  Payee    @relation(fields: [payeeId], references: [id])
  currency               String   @db.VarChar(3)
  ledgerBalanceCents     Int      @default(0) // real credits/debits only
  ledgerPendingHoldCents Int      @default(0) // active dispute/reserve holds
  reserveBalanceCents    Int      @default(0)
  updatedAt              DateTime @updatedAt

  @@id([payeeId, currency])
}
```

### `Organization` additions

```prisma
disputes                          Dispute[] @relation("OrganizationDisputes")
disputeRatePct                    Float?   // rolling 30d, recomputed nightly
disputeCount30d                   Int      @default(0)
chargebackTermsVersion            String?
chargebackTermsAcceptedAt         DateTime?
chargebackTermsAcceptedByHumanId  String?
chargebackTermsAcceptedBy         Human?   @relation("OrganizationChargebackTermsAcceptedBy", fields: [chargebackTermsAcceptedByHumanId], references: [id])
suspendedAt                       DateTime? // platform-imposed suspension

@@index([chargebackTermsAcceptedByHumanId])
```

### `Human` additions

Direct human-owned paid events use the human as the risk owner. Mirror the chargeback-terms pointer on `Human` so personal organisers have the same legal gate as org organisers.

```prisma
disputes                          Dispute[] @relation("HumanDisputes")
chargebackTermsAcceptedForOrgs    Organization[] @relation("OrganizationChargebackTermsAcceptedBy")
disputeRatePct                    Float?   // rolling 30d for direct human-owned paid events
disputeCount30d                   Int      @default(0)
chargebackTermsVersion            String?
chargebackTermsAcceptedAt         DateTime?
suspendedAt                       DateTime? // platform-imposed suspension for direct human organisers
```

## New ports and repos

External processor actions belong on a provider-facing port. Database-backed state belongs in `packages/ports/src/repos/` and is exposed through `Repos` / `TxRepos`, matching the existing settlement and payout repositories.

### `DisputePort`

```ts
export interface DisputePort {
  submitEvidence(stripeDisputeId: string, evidence: DisputeEvidenceShape): Promise<DisputeEvidenceResult>;
  closeAsAccepted(stripeDisputeId: string): Promise<void>; // optional: concede without evidence
  retrieve(stripeDisputeId: string): Promise<StripeDispute>;
}
```

Implemented by `StripeDisputeAdapter` in `packages/adapters/src/payment-processors/stripe/`.

### `DisputesRepo`

New repo interface in `packages/ports/src/repos/disputes.ts` with Prisma implementation in `packages/adapters/src/repos/prisma/`. It owns dispute upsert, status transitions, evidence record linkage, and lookup by Stripe dispute/charge/payment intent/order.

### `PayeeLedgerRepo`

```ts
export interface PayeeLedgerRepo {
  credit(payeeId: string, params: CreditParams): Promise<PayeeLedgerEntry>;
  debit(payeeId: string, params: DebitParams): Promise<PayeeLedgerEntry>;
  hold(payeeId: string, params: HoldParams): Promise<PayeeLedgerEntry>;
  releaseHold(holdEntryId: string): Promise<PayeeLedgerEntry>;
  getBalance(payeeId: string, currency: string): Promise<{ availableCents: number; pendingHoldCents: number; reserveCents: number }>;
  listEntries(payeeId: string, opts: ListOpts): Promise<PayeeLedgerEntry[]>;
}
```

Prisma-backed adapter writes the entry and updates `PayeeLedgerBalance.ledgerBalanceCents` / `PayeeLedgerBalance.ledgerPendingHoldCents` in the same transaction. Holds are not final debits: a won dispute releases the hold. A lost dispute may mark/close the hold for ops visibility, but the real `DISPUTE_DEBIT` for already-credited payee-share liability is Phase 4 behavior.

Every ledger write must be idempotent. `PayeeLedgerRepo` upserts by `idempotencyKey` and treats unique conflicts as replay. Required key patterns:

- `settlement-credit:{settlementLineId}`
- `refund-debit:{refundId}:{payeeId}:{currency}`
- `dispute-hold:{disputeId}:{payeeId}:{currency}`
- `dispute-debit:{disputeId}:{payeeId}:{currency}`
- `dispute-release:{disputeId}:{holdEntryId}`
- `payout:{payoutItemId}`
- `reserve-hold:{reserveActionId}:{payeeId}:{currency}`
- `manual:{manualAdjustmentId}`

## Order lookup and metadata

The dispute webhook receives a Stripe dispute whose source is a charge, not an order. The use cases must resolve the order in this order:

1. Use the charge's `payment_intent` to find `Order.stripePaymentIntentId`.
2. Fall back to PaymentIntent metadata (`orderId`, `eventId`, `buyerHumanId`, `source`) when present.
3. Once an order resolves, load the event and set the risk owner from `event.orgId` or `event.humanId` using the `ownerSubjectType` invariants above.
4. If neither path resolves a local order, persist an orphan dispute record with `status = NEEDS_TRIAGE`, nullable `orderId` / owner fields, the Stripe IDs, and an ops alert; never silently drop the event. Orphan disputes do not create ledger holds until linked to an order.

`create-checkout.ts` already stamps `orderId` and `eventId` on PaymentIntent metadata. This spec should preserve that invariant and add only server-derived fields; clients must not supply dispute ownership or ledger data.

## Webhook handling

Replace the logged-only dispute handlers in `apps/api/src/routes/stripe/webhook.ts` and add the missing lifecycle events. Each handler dispatches to a use case so the webhook stays thin and testable.

```mermaid
sequenceDiagram
    participant Stripe
    participant Webhook as apps/api/routes/stripe/webhook.ts
    participant UC as core/use-cases/disputes
    participant Ledger as PayeeLedgerRepo
    participant Notify as NotificationPort

    Stripe->>Webhook: charge.dispute.created
    Webhook->>UC: openDispute(event)
    UC->>UC: create Dispute row
    UC->>Ledger: hold affected payee share(s)
    UC->>UC: record evidence due date/status
    opt FEAT_DISPUTE_AUTO_EVIDENCE
      UC->>UC: enqueue evidence package job
    end
    UC->>Notify: notify risk owner + ops slack

    Stripe->>Webhook: charge.dispute.funds_withdrawn
    Webhook->>UC: recordFundsWithdrawn(event)
    UC->>UC: stamp fundsWithdrawnAt

    Stripe->>Webhook: charge.dispute.updated
    Webhook->>UC: refreshDispute(event)

    Stripe->>Webhook: charge.dispute.closed (won)
    Webhook->>UC: closeDispute(event, "won")
    UC->>Ledger: releaseHold(disputeId)
    UC->>Notify: notify risk owner

    Stripe->>Webhook: charge.dispute.closed (lost)
    Webhook->>UC: closeDispute(event, "lost")
    UC->>Ledger: close holds; Phase 4 writes debit affected payee share(s)
    UC->>Notify: notify risk owner
```

### Use cases (new, in `packages/core/src/use-cases/disputes/`)

- `open-dispute.ts` — creates or links `Dispute`, creates `PayeeLedgerEntry` rows of type `DISPUTE_HOLD` for affected payee shares, marks `Order.disputeStatus = OPEN`, records evidence due dates/status, and fires notifications. If `FEAT_DISPUTE_AUTO_EVIDENCE` is enabled, it enqueues the evidence-package job; otherwise ops assembles/submits evidence manually in Stripe Dashboard. If the dispute is orphaned, it records `NEEDS_TRIAGE` and skips holds/evidence job enqueueing until linked.
- `record-funds-withdrawn.ts` — stamps `fundsWithdrawnAt`. No financial action (the hold already happened).
- `refresh-dispute.ts` — pulls latest dispute state from Stripe, updates `evidenceDueBy`, `status`.
- `close-dispute.ts` — branches on `won` vs `lost`. Won -> release the active hold. Lost -> mark the dispute/order lost and close or preserve the hold state so payout remains blocked; once Phase 4 is enabled, write a `DISPUTE_DEBIT` without double-counting. Always updates `Order.disputeStatus`.
- `submit-dispute-evidence.ts` — assembles evidence (see below) and calls `DisputePort.submitEvidence` after platform ops approval. Idempotent via `IdempotencyPort`.
- `mark-dispute-warning.ts` — handles `charge.dispute.warning_*` events; informational only, no money moves.

### Idempotency

Every webhook handler runs inside `IdempotencyPort.run` keyed on `dispute:${event.id}`. Replays from Stripe and our own retries become safe no-ops.

### Phase boundary: holds vs clawback

Phase 1 may write/release `DISPUTE_HOLD` entries to stop pending settlement shares from being paid while a dispute is open. It must not rely on negative-balance payout offsets. `DISPUTE_DEBIT`, `REFUND_DEBIT`, payout-offset math, and any transfer reduction based on a payee's negative ledger balance belong to Phase 4 (`FEAT_LEDGER_CLAWBACK`). Until Phase 4 is live, production payout transfers remain disabled or manually approved.

## Evidence submission

`submit-dispute-evidence.ts` assembles a payload from existing order/event/ticket data, plus optional sources when they exist. In launch mode it creates a draft evidence package for platform ops review; after ops approves, the same use case submits to Stripe and records the submitted payload. Missing optional sources must be surfaced in the draft, not treated as job failures.

| Stripe evidence field | Launch v1 source |
|---|---|
| `receipt` | Deterministic order receipt summary rendered from existing order/event/ticket DTOs; PDF rendering/storage is optional follow-up |
| `customer_communication` | Optional support-thread export when a support source exists; otherwise mark unavailable |
| `customer_email_address` | Resolve buyer email via `buyerHumanId`/identity repo; do not assume `order.buyer.email` exists on `OrderRecord` |
| `customer_name` | Resolve buyer display name via `buyerHumanId`/human repo when available |
| `customer_purchase_ip` | `order.checkoutIp` or `order.refundPolicyAckIp` |
| `billing_address` | `order.billingAddressLine1` etc. |
| `service_date` | `event.startsAt` |
| `service_documentation` | Ticket scan log when present; event-page screenshot capture is optional follow-up |
| `access_activity_log` | Optional auth/session IP/user-agent context when available; dedicated buyer activity log is a follow-up dependency |
| `refund_policy` | `order.refundPolicyText`, plus version |
| `refund_policy_disclosure` | `order.refundPolicyAckAt`, `order.refundPolicyAckIp` |
| `uncategorized_text` | Order summary: event name, seats, scan status, billing descriptor |

If the ticket was **scanned at the venue**, that's the strongest evidence — attach it under `service_documentation` with the scan timestamp and scanner user.

The job retries on transient evidence-package generation failures and surfaces to ops if evidence due date is < 48h away and we have not approved/submitted evidence. Optional missing evidence sources should create warnings in the draft package, not retries. Auto-submit can be a later feature flag once generated packages are consistently high quality.

## Settlement integration

`create-from-order.ts` changes:

1. Reject settlement creation for orders with `disputeStatus` of `OPEN`, `UNDER_REVIEW`, or `LOST`.
2. For `WON` disputes, settlement proceeds normally — the hold was released.
3. Refunded portions (already tracked) must be subtracted from the settlement amount before transfer. Use `quote-item-refund.ts` shape to compute net.
4. When settlement lines are created, write one `SETTLEMENT_CREDIT` per settlement line using `idempotencyKey = settlement-credit:{settlementLineId}`. If a refund/dispute already voided the line before settlement creation, do not create a credit.

`run-batch.ts` changes:

1. Phase 1 safety guard: before claiming or transferring a settlement, check its settlement lines. If any line references an order whose `disputeStatus` is `OPEN`, `UNDER_REVIEW`, or `LOST`, skip that settlement for this batch and alert ops. Conservative whole-settlement skip is acceptable for launch; Phase 4 can reduce only the disputed line amount.
2. `SETTLEMENT_CREDIT` is written exactly once, when the settlement line is created. `run-batch` must never create a duplicate credit for the same settlement line.
3. Before transferring, check `PayeeLedgerRepo.getBalance(payeeId, currency)` after the existing settlement credit is included. If the payee still has negative available balance, skip the transfer and create no `PAYOUT` entry. The existing credit has already reduced the debt.
4. If the settlement credit exactly clears the debt, create no transfer and no `PAYOUT` entry.
5. If the settlement credit clears the debt and leaves positive available balance, transfer only the positive surplus/eligible amount and write one `PAYOUT` ledger entry for that transferred amount.
6. Never net across currencies. A USD debt cannot reduce an EUR payout.
7. Surface negative balances to ops; trigger `Payee.payoutSuspendedAt` and, where the payee belongs to an org, `Organization.suspendedAt` if balance has been negative for > 14 days without resolution.

## Refund integration

Two small changes to existing flow:

1. `stripe-adapter.ts` — for future destination/application-fee flows, pass `refund_application_fee: true` and `reverse_transfer: true` where Stripe accepts them. For current online and POS platform-account charges plus explicit settlement-transfer model, keep the existing explicit transfer reversal path as the source of truth.
2. `refund-order-items.ts` — write `REFUND_DEBIT` ledger entries only for refunded payee-share amounts that already have matching `SETTLEMENT_CREDIT` entries. If the refund happens before settlement credit, reduce/void the future settlement share instead of creating payee debt.

## Notifications

In `packages/adapters/src/notifications/`:

- **Dispute opened** -> email to the risk owner (org owner/admins for org-owned events; direct human owner for human-owned events) + `#ops-disputes` Slack. Subject: `[Dispute] $X on ${event.name} — payout held, evidence due ${due}`. The organiser copy must plainly state that Ithas Fire is holding the affected payee share while the bank reviews the dispute.
- **Evidence draft ready** -> platform ops alert with the assembled package and approval CTA.
- **Evidence submitted** -> email to the risk owner with copy of the evidence summary after ops approval/submission.
- **Dispute closed (won)** -> email to the risk owner: hold released.
- **Dispute closed (lost), before `FEAT_LEDGER_CLAWBACK`** -> email to the risk owner: affected payout remains held/manual-review blocked; ops will follow up before any payout adjustment.
- **Dispute closed (lost), after `FEAT_LEDGER_CLAWBACK`** -> email to the risk owner: payee-share loss was recorded and will offset future eligible payouts. Include link to ledger view.
- **Payout skipped for debt, after `FEAT_LEDGER_CLAWBACK`** -> email to the risk owner explaining that the payout was applied to dispute/refund debt and no transfer was sent.
- **Reserve adjustment** -> email when reserve % is manually increased in a later phase.

## Organiser awareness and terms

Organisers need to know this system exists before they take real money. Chargebacks usually arise from buyer confusion, event cancellation, service issues, fraud, or fulfilment evidence gaps tied to the event/operator, even though Stripe initially debits the platform. Ithas Fire owns the payment rails; organisers/payees own the payout exposure for their disputed event revenue.

Launch requirements:

- Add a chargeback and payout-hold acknowledgement to organiser onboarding and payout setup.
- Block paid event publishing, paid checkout/payment creation, and payout enablement until the event risk owner accepts the current chargeback terms version. For org-owned events, an org owner/admin accepts on behalf of the org. For direct human-owned events, the human owner accepts on their own account.
- `create-checkout.ts` is the final server-side enforcement boundary: for any paid order, it must reject checkout before creating a PaymentIntent if the event risk owner has not accepted the current chargeback terms version.
- Persist chargeback terms acceptance on `Organization` for org-owned events and on `Human` for direct human-owned events.
- State plainly that Ithas Fire may hold disputed payout shares, skip payouts while a payee has unresolved dispute/refund debt, and recover lost-dispute amounts from future payouts.
- State that `reservePct` starts at `0`; reserves are not automatically applied at launch.
- If we ever pass Stripe's dispute fee or other platform costs through to organisers, legal copy must say that explicitly before the fee is charged.

## Prevention controls

These are not part of the dispute-response loop but materially reduce the volume Stripe ever sends us.

### Billing descriptor

In `stripe-adapter.ts` checkout flow, set `statement_descriptor_suffix` to a clean short event identifier. The full descriptor becomes `ITHASFIRE* ${eventShortName}`. Snapshot it on the order for later use in dispute responses.

### Refund policy acknowledgement

`apps/web/src/app/events/checkout/[...slug]/_components/` — require a refund-policy acknowledgement before payment. On surfaces that also require platform Terms, use the combined Terms/refund checkbox box; standalone refund-only surfaces may render the refund acknowledgement by itself. Persist `refundPolicyAckAt`, `refundPolicyAckIp`, `refundPolicyVersion`, and `refundPolicyText` on the order from server-owned policy text.

### 3D Secure

Baseline quick win: set `payment_method_options.card.request_three_d_secure = "automatic"` on online card PaymentIntents. 3DS-authenticated fraud disputes shift liability to the issuer when Stripe/issuer risk signals choose a challenge. Custom Radar rules can be added later after launch data shows the right thresholds.

### Self-serve refund window

Audit indicates self-serve refunds already exist through `get-refund-eligibility.ts` and `refund-full-order.ts`. Before launch, verify the buyer UI exposes this path clearly. Any missing buyer-facing refund surface should become a separate follow-up spec, not part of the quick-wins companion.

### Radar rules

Potential post-launch custom Radar rules for ticketing-specific patterns:

- Block when `:card_funding = "prepaid"` AND `:amount_in_usd > 500`
- Review when buyer email domain is in our high-fraud-domain list
- Block when same card has > 3 declines in 1h

## Dispute-rate monitoring

Nightly job in `apps/jobs/` computes per-risk-owner and platform-wide 30-day dispute rate:

```text
disputeRatePct = (disputesIn30d / chargesIn30d) * 100
```

Stored on `Organization.disputeRatePct` for org-owned events, `Human.disputeRatePct` for direct human-owned events, and a platform-wide metric exported to Sentry/Grafana. Thresholds:

| Rate | Action |
|---|---|
| Risk owner > 0.5% | Email org owner/admins or direct human owner: dispute rate concern |
| Risk owner > 1.0% | Platform ops review; future payouts require manual approval until dispute rate improves |
| Risk owner > 1.5% | Freeze payouts and require ops review before new paid events or transfers |
| Platform > 0.5% | Slack `#ops-disputes` daily |
| Platform > 0.7% | Page on-call (this is the VDMP threshold approach) |

`reservePct` is not managed automatically at launch. Dispute rate can recommend a manual reserve later, but the default is `0` and ops must explicitly change it after organiser notice/legal approval.

## Admin and organiser surfaces

### Organiser communications

- Launch does **not** require self-serve organiser dispute or ledger pages.
- Risk owners are notified by Ithas Fire when a dispute opens, evidence is submitted, a payout is held/skipped, or a dispute closes. For org-owned events this means org owner/admins; for direct human-owned events this means the human owner.
- Future organiser self-service pages can be added after the platform dispute desk is stable.

### Platform admin

- New page: `/admin/[slug]/disputes` — global dispute desk sorted by evidence due date. Add the page to `ADMIN_SECTIONS` in `apps/web/src/app/admin/[slug]/layout.tsx`.
- Evidence approval workflow: inspect generated evidence, request organiser context, submit to Stripe, or mark manual handling required.
- Per-risk-owner dispute rate on platform admin surfaces: org-owned event rates on `/admin/[slug]/orgs` or the current org-management surface, and direct human-owned event rates wherever platform admins review human organisers/payees.
- Ability to manually override: submit/skip evidence, force-release hold, skip payout, freeze payee, and adjust reserve % only when the reserve feature is enabled.

## Phasing

Each response phase is shippable independently and behind its own flag. The companion prevention quick wins are intentionally small enough to ship by normal revert instead of feature flag unless product decides otherwise.

Operational gate: production payout transfers must remain disabled or manually approved until Phase 4 is live. Phase 1 prevents disputed pending settlements from being paid, but it does not recover losses from payees who were already transferred before the dispute was lost.

### Phase 0 — Organiser awareness + legal terms (launch blocker)

- Add chargeback/payout-hold terms to organiser onboarding and payout setup.
- Block paid event publishing, paid checkout/payment creation, and payout enablement until the event risk owner accepts the current chargeback terms version: org owner/admin for org-owned events, direct human owner for human-owned events.
- Add the `create-checkout.ts` paid checkout guard before any PaymentIntent is created.
- Persist acceptance on `Organization` for org-owned events and on `Human` for direct human-owned events.
- Create notification templates for dispute opened, evidence submitted, dispute won/lost, payout skipped, and manual reserve changes.
- Keep `reservePct = 0`; do not apply rolling reserves at launch.

This is required before real-money payments because organisers must understand that chargebacks can affect their payouts. Legal copy is a blocker here.

### Phase 1 — Detect + hold (launch blocker)

`FEAT_DISPUTE_HOLDS=true`

- `Dispute`, `PayeeLedgerEntry`, `PayeeLedgerBalance` models + migration
- `DisputesRepo` / `PayeeLedgerRepo` + Prisma adapters
- `open-dispute`, `record-funds-withdrawn`, `close-dispute`, `refresh-dispute` use cases
- Webhook handlers wired
- `create-from-order` rejects disputed orders
- `run-batch` skips settlements containing disputed order lines, covering disputes opened after settlement creation but before transfer
- Notifications to risk owner + ops
- **No automatic evidence yet** — ops submits manually via Stripe Dashboard

Eliminates silent leakage for both not-yet-created and already-created pending settlements, and gives ops visibility. ~1 week.

### Phase 2 — Evidence package + ops approval (launch blocker)

`FEAT_DISPUTE_AUTO_EVIDENCE=true`

- `DisputePort` + Stripe adapter
- `submit-dispute-evidence` use case + evidence package job
- Evidence assembly from receipts, scans, policy ack, and AVS when Stripe charge/payment-method details expose it
- Platform admin dispute desk for ops approval/submission
- Risk-owner email includes evidence summary after submission

Wins a meaningful share of disputes while keeping humans in the loop until generated evidence quality is proven. ~3-5 days.

### Phase 3 — Baseline prevention quick wins (launch blocker, parallel)

- `dispute-prevention-quick-wins.spec.md` is implemented in code; keep external Stripe-dashboard/live-bank descriptor verification tracked in the web-launch checklist
- Billing descriptor wiring
- Refund-policy checkbox + persistence
- 3DS automatic mode on online card PaymentIntents
- Verify the existing self-serve refund path is buyer-visible; create a separate follow-up spec if it is not.

Reduces volume entering Phases 1+2. Target: under 1 day for the descriptor/3DS/refund-ack work.

### Phase 4 — Clawback via ledger (launch blocker before automated payouts)

`FEAT_LEDGER_CLAWBACK=true`

- `run-batch` reads from `PayeeLedgerRepo` and skips transfers while unresolved negative balance remains
- `run-batch` writes no duplicate settlement credits, creates no `PAYOUT` while debt remains, creates no transfer when a credit exactly clears debt, and transfers only surplus after debt is cleared
- `PayeeLedgerBalance` denormalisation kept in sync per currency
- Refund flow writes `REFUND_DEBIT` entries
- Admin surface for manual ledger adjustments
- Stripe Invoicing fallback for organisers with sustained negative balance and no upcoming events

Required before enabling automated real-money payout transfers in production. If this slips, keep payout transfer execution behind manual ops approval and freeze any payee with an open, under-review, or lost dispute. ~1 week.

### Phase 5 — Monitoring + manual reserves (nice to have, post-launch)

`FEAT_DISPUTE_RESERVES=true`

- Nightly dispute-rate job
- `Payee.reservePct` enforcement in payout pipeline, defaulting to `0` and changed only by manual ops action
- Auto-suspend logic
- Admin dashboard for dispute rate

~1 week. Nice-to-have after launch; deferred until 30+ days of post-launch data exists to calibrate thresholds and until organiser/legal reserve copy is approved.

## Risks

- **Stripe rate limits on evidence submission.** We retry with backoff; large evidence payloads (especially PDFs) might exceed the size cap. Need to verify and downsample.
- **Webhook ordering.** `dispute.created` and `funds_withdrawn` can arrive out of order. The use cases must be commutative (idempotent + status-aware). Tested in `__tests__/`.
- **Multi-currency.** Ledger entries and balances are per-currency. Supporting non-USD disputes is manageable if we avoid cross-currency netting; platform-wide exposure reporting can add USD-equivalent metrics later.
- **Negative balance collection.** If an organiser refuses to settle a debt and has no upcoming events, recovery is a legal question, not a code one. Out of scope; ops escalates.
- **Reserve UX.** Holding 10-20% from a payout will get pushback. Because reserves are not launch-default behavior, any future reserve rollout needs explicit organiser notice and copy that frames reserves as temporary risk controls.
- **TOS update required.** Phase 0 needs organiser terms that explicitly allow dispute holds, payout skips, future-payout recovery, payout suspension, and manual reserves. Legal must sign off before real-money payments.

## Resolved decisions from 2026-05-14

- Organiser legal/TOS language does not exist yet, but it is required before real-money payments. It must cover dispute holds, payout skips, future-payout recovery, payout suspension, and any future reserve or fee pass-through.
- Evidence is not auto-submitted at launch. The system assembles a baseline package, and platform ops approves/submits it from the dispute desk.
- If a payee has unresolved negative balance and a small pending payout, skip the payout and apply the settlement credit against the debt. Do not partially pay while the debt remains.
- Launch visibility is platform-admin-first. Organisers are notified by Ithas Fire; self-serve organiser dispute/ledger pages are future work.
- Currency support should be per-currency from the start. Ledger balances do not net across currencies; USD-equivalent aggregate reporting can come later.
- Reserve percentages are dispute-rate-informed but not automatic. `reservePct` defaults to `0` and only changes by manual ops action after legal/organiser notice.

## Remaining open questions

- What exact organiser chargeback/payout-hold copy does legal approve for Phase 0?
- Do we ever pass Stripe's dispute fee through to the event-owner payee, or does Ithas Fire always absorb that platform cost?

## Acceptance criteria

- Every dispute lifecycle event from Stripe results in a `Dispute` row whose state machine reflects current Stripe state within one webhook of reality.
- A risk owner cannot publish paid events or enable payouts until the current chargeback terms version is accepted: org owner/admin for org-owned events, direct human owner for human-owned events.
- A paid checkout cannot create an order PaymentIntent unless the event risk owner has accepted the current chargeback terms version.
- An organiser whose buyer files a dispute does not receive payout on that order while the dispute is open.
- A dispute opened after settlement creation but before payout causes the payout batch to skip or reduce the affected settlement before any transfer is created.
- When a dispute is lost, the payee-share loss is recorded against the affected payee ledger and reduces that payee's next payout by the corresponding amount.
- Ledger tests cover negative-balance payout cases: small payout still leaves debt and creates no transfer, exact debt clear creates no transfer, surplus after debt clear transfers only the surplus, and debts never net across currencies.
- Ledger tests cover pre-credit cases: a dispute lost before settlement creation and a refund before settlement credit do not create negative payee balance for shares never credited.
- Ledger tests cover idempotency/concurrency: duplicate settlement-credit, refund-debit, dispute-debit, and payout writes replay safely via unique `idempotencyKey` and cannot double-credit or double-debit.
- Production payout transfers remain disabled or manually approved until Phase 4 ledger clawback is enabled.
- A draft evidence package is generated within 15 minutes of `dispute.created` for at least 95% of linked disputes using required existing sources; optional unavailable sources are flagged for ops, and ops can approve/submit from the platform dispute desk.
- Ops can see all open disputes, sorted by evidence due date, on a single admin page.
- Organisers receive notifications when disputes open, evidence is submitted, payout is held/skipped, and disputes close.
- Per-risk-owner and platform dispute rate is computed nightly and exposed.
- The dispute-response phases are feature-flagged so any phase can be disabled without code changes.

## Out of scope (explicit)

- Insurance products (e.g. event cancellation insurance) sold to buyers
- Chargeback representment by third-party services (e.g. Chargeback Gurus) — revisit if auto-evidence win rate is < 30% after 90 days
- Custom fraud-scoring ML beyond Stripe Radar
- Changing connected account type from Express to Custom
