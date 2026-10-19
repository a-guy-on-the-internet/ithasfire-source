# Hot Paths Checklist

Use this as a review checklist before merging changes in money, payments, ticketing, settlement, webhooks, embeds, and other high-risk paths.

## Money math and pricing

Checklist:

- [ ] All currency math uses integer cents (or bigint where required); no floats.
- [ ] Rounding is deterministic and uses shared pricing helpers.
- [ ] Split math is correct: floors, caps, priority, and remainder handling are explicit.
- [ ] Split and percent invariants hold (`sum(order_splits) === basis`, percent totals are valid).
- [ ] Fee basis follows agreement rules and matches checkout behavior.
- [ ] Processor flat fee is applied once per payment, not per line item.
- [ ] `maxPlatformFeeCents` cap is applied at order level when configured.

Tax checks:

- [ ] Tax rate is cached per location: `Place` and `SavedLocation` each cache their own `admissionTaxRateBps`. Publish stamps `Event.admissionTaxRateBps` from the event's location, resolved Place, then SavedLocation, then inline address (`packages/core/src/use-cases/events/_shared/resolve-event-tax-rate.ts`; an inline address has no row to cache on).
- [ ] The taxable base comes from `resolveTaxableBase` (`packages/core/src/lib/pricing/taxable-base.ts`): `TICKET_FACE` or `BUYER_TOTAL` per jurisdiction. A situs missing from the table reports through `reportUnknownTaxableBaseSitus`.
- [ ] Each tax is one imposition line (`resolveTaxImpositions`, `tax-impositions.ts`). `PLATFORM` lines add to the charge; `ORGANISER` lines are disclosed only. What an order was charged is persisted as `OrderTaxLine` rows.
- [ ] No tax provider call inside the checkout transaction. For an unstamped event the last-chance ZipTax lookup runs before the transaction (`orders/_shared/resolve-checkout-tax-rate.ts`, ~8s budget with retries) and refuses with `TAX_RATE_UNAVAILABLE` rather than charging 0% when it fails. The one exception is the stale-prepare fallback: when the prepared rate no longer fits (the event moved), `resolveCheckoutTax` resolves inside the transaction and logs `tax_rate_prepared_stale_resolving_in_tx`.

Refund and chargeback checks:

- [ ] Pre-transfer refund path reduces basis correctly.
- [ ] Post-transfer refund path handles negative splits and clawback policy correctly.

## Idempotency and concurrency

Checklist:

- [ ] Webhooks, transfers, refunds, and QR scans are idempotent.
- [ ] Idempotency keys are stable and scoped correctly for each flow.
- [ ] Retries do not duplicate side effects.
- [ ] Concurrency protections exist for high-contention paths.

Database and key guards:

- [ ] Unique protection is present where required, including `(order_id,payee_id)`.
- [ ] Listing uniqueness and settlement uniqueness constraints are preserved.
- [ ] Ticket scan flow allows exactly one success transition.

Settlement and jobs:

- [ ] Settlement batching rules are explicit (accrual, threshold, cadence).
- [ ] Retry and DLQ behavior is defined and tested.
- [ ] Jobs use visibility timeout and exactly-once semantics where required.

## Security and access control

Checklist:

- [ ] RBAC is org-scoped and deny-by-default.
- [ ] Finance-sensitive actions enforce step-up controls where required.
- [ ] Webhooks verify signatures and enforce replay windows/timeouts.
- [ ] QR tokens are signed, short-lived, and single-use at state transition.
- [ ] Public embed procedures enforce the domain allowlist (`assertEmbedOriginAllowed`) and strict CORS.
- [ ] Embed domain checks stay low latency and run no external fetches.
- [ ] PII is minimized in logs and masking is applied to phone/email fields.

## Ticketing and publish gates

Checklist:

- [ ] Paid ticketing requires Stripe Connect (server-side enforcement; UI is advisory).
- [ ] Free tickets require no payment and no Stripe dependency.
- [ ] Free-only events can publish without Stripe.
- [ ] Events with paid ticket types cannot publish until Stripe is connected.
- [ ] Paid `TicketType` creation is blocked unless organizer Stripe is connected.
- [ ] Paid checkout session creation is blocked unless organizer Stripe is connected.
- [ ] Free ticket issuance is idempotent and concurrency-safe.
- [ ] Promotion from free to paid ticketing is an explicit controlled transition.

## Schema and persistence guards

Checklist:

- [ ] Event location XOR rule holds (`placeId` set, or `savedLocationId` / address fields set, never both). No DB CHECK exists for it today (`packages/db/prisma/event.prisma`, note above `@@index([placeId])`), so enforce it in the use case.
- [ ] Finance and listing uniqueness constraints remain enforced.
- [ ] FK `onDelete` behavior is correct (`Cascade` for contained children, `Restrict` for finance links).
- [ ] Enums are used for statuses, roles, and kinds.
- [ ] Numeric constraints remain enforced (percent range, capacity > 0, amounts >= 0).

Ledger and audit checks:

- [ ] Every external event writes an immutable ledger/audit record.
- [ ] Derived tables are treated as computed outputs, not source-of-truth ledgers.
- [ ] Factor changes, role changes, payouts, refunds, and listing actions are audited.

## Read-hot and latency-sensitive paths

Checklist:

- [ ] Public entity page rendering (`/p/[slug]`) stays fast.
- [ ] `EntityPagesRepo.getBySlug` performance is monitored and optimized.
- [ ] Page block JSON payloads remain bounded and schema-validated server-side.
- [ ] Routing/travel-time enrichment has timeout protection (default 5s).
- [ ] Travel-time failures degrade gracefully and do not block event rendering.

## Tests required before merge

Checklist:

- [ ] Property test: split sums match basis after rounding.
- [ ] Property test: repeated webhook delivery is state-stable.
- [ ] Property test: refund behavior differs correctly before vs after transfer.
- [ ] Race test: concurrent settlement jobs produce one transfer per payee.
- [ ] Race test: simultaneous scans yield exactly one success.
- [ ] Round-trip test: listing hold TTL expiry relists ticket.
- [ ] Failure test: provider outage triggers retry/backoff without duplicate sends.

## Kill switches and observability

Checklist:

- [ ] Global transfer disable switch is available and verified.
- [ ] Global refund disable switch is available and verified.
- [ ] Per-org payout freeze is available and verified.
- [ ] Per-event sales freeze is available and verified.
- [ ] Metrics and alerts cover webhook 5xx rate, settlement lag, and orphan balances.
- [ ] Trace IDs and key business metrics are emitted for critical flows.

