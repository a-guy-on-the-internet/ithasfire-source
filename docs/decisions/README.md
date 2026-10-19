# Architecture Decision Records

Notable decisions that affect the project's structure, tooling, or conventions.

## Contents

| Doc | Decision |
| --- | --- |
| `place-layout-rename.md` | Renaming seatmap entities to place-layout across the codebase. |
| `prisma-multi-file-schema.md` | Adopting Prisma multi-file schema layout. |
| `buyer-refunds-stop-at-payout.md` | Buyer-initiated refunds refuse paid-out items; organiser/staff/cancel-event refunds may reverse the transfer. |
| `absorb-refund-returns-platform-fee.md` | A refunded order gives the platform fee back in both fee modes; the organiser is never docked more than they were credited, and the returned fee is stamped per item. |
| `fee-mode-switch-dropped.md` | No per-event Fee Handling switch: every new event adds fees on top, and the buyer's order lines come from `computeBuyerChargeBreakdown`. Its legacy-ABSORB parts are superseded by `absorb-removed.md`. |
| `absorb-removed.md` | ABSORB is removed: existing ABSORB terms and fee policies are migrated to PASS_THROUGH, every new sale prices fees-on-top (`SALE_FEE_MODE`), and past ABSORB orders keep their math. |
| `platform-fee-charged-once.md` | The platform fee is taken once: the buyer pays it on top and the organiser is credited the full ticket price. Each order records its rule in `feePolicySnapshot.organiserCredit`; orders sold before 2026-10-11's change keep price minus fee. Supersedes the two-unit passages of the two ABSORB records. |
| `cancellation-refunds-gifted-tickets-to-the-payer.md` | On event cancellation a gifted ticket is refunded to the paying order; resale transfers keep their own unwind. |
| `events-have-parties-not-one-owner.md` | An event has three sides — organizer, act, place — each a role-based permission scope that adds its own members; one organiser per event is the party tickets are sold on behalf of and the quota home. |
| `create-checkout-payment-intent-outside-tx.md` | `createCheckout` calls Stripe with no transaction open: main transaction, then the PaymentIntent, then a CAS link transaction, with an unwind on failure. |
| `listing-pay-what-you-want-never-free.md` | A floor-0 pay-what-you-want tier reads "Pay what you want" on every listing, never "Free"; listing prices are worded in the viewer's language. Needs `search.full-reindex` after deploy. |
| `cancellation-refunds-withhold-processing-fee.md` | A cancellation refund returns ticket price, platform fee and tax and withholds the processing fee, the same rule as every other refund path. |
| `postgres-search.md` | Unified multi-index search runs on Postgres (one `SearchDocument` table, full-text, trigram and geo); implemented, and `SEARCH_BACKEND` now defaults to `postgres`. |
| `scanner-distribution-native-internal-tracks.md` | The web scanner has shipped; the native scanner ships through TestFlight Internal and Play Internal (owner, 2026-10-08), with the 2026-08-04 analysis behind it. |
