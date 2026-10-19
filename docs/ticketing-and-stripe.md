# Ticketing and Stripe

The product contract:

- Anyone can create an event, and publish it without Stripe while the event takes no money: no tier is ever-paid and no seat carries a paid override (both defined below).
- A tier that is free and stays free never needs Stripe. A $0 tier with a scheduled price, or pay-what-you-want with no minimum, is ever-paid.
- Ever-paid tiers need the organizer's Stripe Connect account, and the server enforces it.

## Terms

- **Organizer**: the one organisation or person an event is accountable to (`CONTEXT.md`). In code, `Event.orgId`, else `Event.humanId`. Every Stripe gate below looks up that subject's `Payee`; each gate derives the subject with its own copy of `derivePayeeSubject` (`publish-event.ts`, `create-checkout.ts`, and the exported one in `ensure-stripe-connected-for-paid-ticketing.ts`). A fourth copy in `ensure-default-primary-payout-terms.ts` decides the default payout subject, so a change to the rule touches all four.
- **Linked**: the organizer's `Payee` row has a `stripeAccountId`. `initiateOnboarding` sets it the moment Connect onboarding starts, before Stripe has enabled anything.
- **Ready**: the payee is `ACTIVE` with `chargesEnabled` and `payoutsEnabled`. Those flags are derived in one place, `syncConnectAccount` (`packages/core/src/use-cases/stripe-connect/sync-connect-account.ts`), fed by the `account.updated` webhook and by the live status read (`get-connect-status.ts`, `reconcile-connect-accounts.ts`).
- **Ever-paid tier**: `isEverPaidTicketType` (`packages/core/src/lib/orders/door-pricing.ts`). A price above 0 now, a scheduled price above 0, or pay-what-you-want (`ADJUSTABLE`). A tier that is $0 today and priced later still counts.
- **Paid seat override**: a stored `Seat.priceOverride` above 0 on a seat in a section a `FIXED` tier sells (`storedSeatOverrideCharges` in `packages/core/src/use-cases/events/_shared/seat-price-override-rules.ts`). Checkout charges that seat its override, so a $0 tier with a $50 seat takes money. A $0 override does not count, and neither does an override in a section no `FIXED` tier sells (pay-what-you-want tiers ignore overrides). A stored value checkout refuses (not `{ priceCents: number }`, or a negative or fractional amount) counts as paid at publish and at the three tier writes in the table below, and is reported to Sentry.

## Server gates

The UI is advisory; these are the gates. Every error code below maps to tRPC `PRECONDITION_FAILED` (`packages/transport/trpc/src/utils.ts`).

| Action | Requires | Error code | Where |
| --- | --- | --- | --- |
| Add a paid tier, or edit a free tier into a paid one | Linked, and a resolvable fee policy | `PAID_TICKETING_REQUIRES_STRIPE`, `PAID_TICKETING_REQUIRES_FEE_POLICY` | `ensureStripeConnectedForPaidTicketing` and `ensureFeePolicyResolvableForPaidTicketing` in `packages/core/src/use-cases/ticket-types/_shared/`, called by `upsertTicketType` and `updateTicketType` |
| Set a paid seat price on a seat a free `FIXED` tier sells | Linked, and a resolvable fee policy | same two codes | `ensurePaidOverrideGates` in `packages/core/src/use-cases/events/_shared/seat-price-override-rules.ts`, called by `setSeatPriceOverrides` |
| Make a free `FIXED` tier start selling a seat section that already stores a paid seat override: assign the tier to the section, create it on the section, or switch it from pay-what-you-want to `FIXED` | Linked, and a resolvable fee policy | same two codes | `ensureStoredOverridesGatedForTierWrites` in the same module, called by `assignTicketTypeSections`, `upsertTicketType` and `updateTicketType`. It reads the seats at most once, and only when the write makes a free tier start selling a section at a `FIXED` price |
| Publish an event with any ever-paid tier or paid seat override | Ready | `STRIPE_NOT_CONNECTED_OWNER` | `ensureStripeConnectedForPaidEvent` in `packages/core/src/use-cases/events/publish-event.ts`. Publish reads the seats only when every tier is free and one sells a seat section at a `FIXED` price (`storedSeatOverridesTakeMoney`) |
| Paid checkout, by card or paid in full with platform credit | Ready, with a Connect account id | `STRIPE_NOT_CONNECTED` | `ensureStripeConnectedForPaidCheckout` in `packages/core/src/use-cases/orders/create-checkout.ts` |

The authoring gate asks only "is there a Connect account at all?" on purpose: an organizer can build paid tiers while Stripe verifies them, on an event they cannot publish yet. Capability is checked at publish, the last gate before the event is buyable. The authoring gate's idea of "paid" is also narrower (`ticketTypeRequiresStripe`): a pay-what-you-want tier with no minimum can be authored without a linked account, but publish counts it as ever-paid and requires Ready.

A stored paid seat override is gated when it is written and again when a write makes a free tier start selling it. Without the second gate, an override set with the gates passed could be taken off sale (unassign the tier), the event published as free, and the tier assigned back with nothing checked. Taking a section off sale is never refused: an unassign, a tier delete and a switch to pay-what-you-want skip the gate, and so does a tier that is itself paid, which passed the same gates when it was priced. The refusal carries `meta` (`error.data.meta` on the wire): `{ cause, seatSectionIds, invalidSeatSectionIds }`, where `cause` is `stored_seat_price`, or `seat_price_override_invalid` when a corrupt value is the only reason.

That gate has known gaps, accepted and listed in the spec (`docs/specs/2026-08-12/seat-price-overrides.spec.yaml`, `as_built` entry "tier write gate (7e)"). It reads without a lock, so two concurrent writes can leave a free tier selling a paid seat with no gate run: a mode switch and an assign of the same tier, or an override write and an assign on a section a paid tier already sells. A paid tier edited to $0 on its section is not re-gated either. And the gate asks for Linked, not Ready, so a published free event can gain a paid seat that fails at checkout with `STRIPE_NOT_CONNECTED`, the same as a paid tier added after publish. In every one of these checkout still needs a Ready account, and refuses the buyer with `STRIPE_NOT_CONNECTED` without one. That holds for an order paid in full with platform credit too (owner ruling, 2026-10-11): no card is charged, but the organizer is owed the tickets' face value, so the gate runs before any credit is spent. Only a free order needs no payee (see Free tickets).

Publish and checkout also refuse an organizer who has never accepted any version of the chargeback terms (code `chargeback_terms_required`, `packages/core/src/lib/payments/chargeback-terms.ts`). Connect onboarding requires the current version. At publish this backstop, the Ready gate and the fee-policy gate (`FEE_POLICY_NOT_FOUND` when no policy resolves at any scope) all ask the same question: an ever-paid tier, or a paid seat override.

## Free tickets

An order whose total after discounts is $0 never reaches Stripe. `createCheckout` hands it to `claimFreeTickets`: no PaymentIntent, no card, no platform fee. A promo that brings a paid cart to $0 takes the same route and waives the platform fee too.

A $0 ticket in a paid cart pays no platform fee either (owner rulings, 2026-10-10). That covers a ticket whose price is $0 (a free tier, a seat overridden to $0, pay-what-you-want set to $0; `computePlatformFeePerTicketCents`) and a ticket a promo code or membership benefit discounts to $0 (`packages/core/src/lib/orders/discounted-to-zero.ts` defines which tickets those are; `computeOrderAmounts({ discounts })` takes the fee off). Such a ticket takes no share of the processing fee and adds nothing to a tax base that includes fees, so the paid tickets beside it cost what they cost alone. A ticket discounted to any amount above $0 still pays the fee on its list price. The checkout page does no fee arithmetic of its own for a held cart: `promos.preview` states the fee the charge will take (`heldCartFees`, computed in `packages/core/src/use-cases/orders/_shared/held-cart-fees.ts`), and before the hold it gives the amount that comes off the public-rate estimate (`platformFeeReductionCents`). The embed checkout reads neither yet.

Refunding a $0 ticket returns $0 (owner ruling, 2026-10-11). A ticket a promo code or membership benefit discounted to $0 weighs nothing when a refund is split over the order's tickets (`packages/core/src/lib/orders/refund-weight.ts`), so it takes no share of the ticket price, the tax, the processing fee or the organizer's credit; the paid tickets beside it carry the whole charge, and refunding every ticket still returns the charge less the processing fee. The refund itself still happens (the ticket is marked refunded and its seat goes back on sale), but with no refund call to Stripe, which rejects a refund of amount 0. A ticket priced at $0 (a free tier or a seat overridden to $0) inside a paid order refunds $0 the same way. The buyer is told the ticket was returned and that there is no money to refund for it; the notice never says money is on its way. Cancelling an event returns such a ticket too: when the only tickets left to refund on a paid order cost $0, the cancellation marks them refunded and closes the order without a Stripe refund, and the buyer gets the plain cancellation notice. If the organizer was already paid out for a ticket whose refund comes to $0, that transfer is still reversed. A ticket discounted to an amount above $0 is refunded as before, by its share of what the buyer was charged.

## Paid money flow

Charges are separate charges and transfers: the PaymentIntent is created on the platform account, and the organizer's account id rides in its metadata only. The nightly `settlements.run-batch` pays organizers by Connect transfer; see `docs/runbooks/stripe-platform-payout-settings.md`. Every new sale is priced fees-on-top (`SALE_FEE_MODE` = `PASS_THROUGH`, `packages/core/src/lib/pricing/compute-ticket-price-for-agreement.ts`; `docs/decisions/absorb-removed.md`). A cash door sale carries no platform fee and no processing fee (`zeroFeesForCashSale`, `packages/core/src/use-cases/orders/_shared/price-cart.ts`).

## Tax

- Tax is independent of Stripe. Stripe Tax is not used. US rates come from ZipTax through `TaxRateLookupPort` (`packages/ports/src/tax-rate-lookup.ts`); Canadian rates come from a static table (`packages/core/src/lib/tax/canada-rates.ts`).
- The rate is cached on the venue (`Place.admissionTaxRateBps`, `SavedLocation.admissionTaxRateBps`) and stamped onto `Event.admissionTaxRateBps` at publish.
- Checkout charges the stamp. When the event was never stamped, checkout looks the rate up itself, before its transaction opens (`prepareCheckoutTax` in `packages/core/src/use-cases/orders/_shared/resolve-checkout-tax-rate.ts`). A failed lookup is retried within an 8-second budget, then the sale is refused with `TAX_RATE_UNAVAILABLE`; a failure never charges 0%. A hand-entered stamp is looked up once more at each sale.
- The jurisdiction also decides what the rate applies to. `packages/core/src/lib/pricing/taxable-base.ts` holds the table (TN and MN tax the buyer total; everywhere else taxes the ticket face), `tax-impositions.ts` beside it adds local taxes, and `solve-tax-and-processor-fee.ts` solves the tax and the processing fee together. What an order was charged is stored per line as `OrderTaxLine`.
- The platform collects as marketplace facilitator. Threshold watching is in `docs/runbooks/tax-nexus-threshold-watch.md`.

## UX

Keep "Publish" and "Sell tickets" separate in the organizer's head: anyone can publish; selling paid tickets needs payouts set up. When an event has paid tiers and the organizer is not Ready, the builder shows "Connect Stripe to publish paid tickets" with a "Set up payouts" action (`ebStripeConnectBannerTitle`, `ebStripeConnectBannerAction` in `apps/web/src/i18n/messages/en.ts`). The builder's banner reads tiers only: an event that is free except for a paid seat override gets no banner, so the organizer learns of it from the publish refusal.

## Places + trust (related)

Ticketing doesn’t require a verified place, but higher-trust events *tend* to:

- **Pop-up events**: can use freeform lat/lng.
- **Venue events**: often attach to a verified Place.

Keep the product flexible:

- Don’t block creation on Places verification.
- Use Places verification to improve trust/discovery/ops flows.

## Open questions

- Should free tickets ever need Stripe if a platform fee on free events is added later (unlikely)?
