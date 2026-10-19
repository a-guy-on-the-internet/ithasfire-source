# Listings never call floor-0 pay-what-you-want "Free"

Status: accepted (owner ruling 2026-10-06, F2 and F3).

## Decision

A pay-what-you-want (ADJUSTABLE) tier with no minimum reads **"Pay what you
want"** on every listing: site cards, search rows, the category list, the
embed grid and the embed calendar. The event page and checkout already said so
(`apps/web/src/components/events/pay-what-you-want-copy.ts`); listings said
"Free" because the pricing rollup counted a $0 floor as a free tier.

The rule lives in one place, `resolveListingPrice` in
`packages/types/src/money.ts`:

| Tiers on sale | Label |
| --- | --- |
| floor-0 PWYW, alone or beside free and/or paid tiers | Pay what you want |
| free only | Free |
| free + paid | Free+ |
| paid, all-in known | the all-in figure ("$28.62"; "From $28.62" on the calendar for several tiers) |
| paid, all-in unknown, or nothing on sale | no price ("See details" on cards and rows, nothing on the calendar) |

A PWYW tier with a floor above 0 is unchanged: a paid tier quoted at its floor,
all-in.

**Floor-0 PWYW plus paid tiers reads "Pay what you want", not "Pay what you
want+" and not the paid minimum.** "Free+" claimed "you can get in for nothing,
and there are paid options". The closest claim without the word Free is "Pay
what you want": the least a buyer pays is still whatever they choose, and the
phrase already says the amount goes up from there, so a "+" adds nothing.
Quoting the paid tier's all-in figure would overstate the least a buyer pays,
which a listing price must never do.

## Data

- `PricingSummary` (`summarizePricing`) gains `hasPayWhatYouWantTier`: an
  on-sale floor-0 PWYW tier. It no longer sets `hasFreeTier`, which now means
  genuinely free tiers only.
- `SearchDocument.has_pay_what_you_want_tier` (migration
  `20261006150000_search_document_has_pay_what_you_want_tier`, additive,
  default false). `lowest_price_cents` stays 0 for such an event, so price
  filters are unchanged.
- The flag is carried through the search port, both search adapters, unified
  search, discover, the embed payload and the calendar.

## Language (F3)

The shared rule returns data (`ListingPrice`), and the web words it in the
viewer's language at the rendering edge (`useListingPriceWords` in `@th/ui`):
"Gratis", "Gratis+", "Paga lo que quieras", "Desde $X", "Ver detalles". The
amount itself is formatted the same in every language, so it matches the event
page and checkout. `EventSummaryDto.listingPrice` and the calendar's
`listingPrice` carry the data beside the English `priceLabel`, which native
apps still print as is.

## On deploy

1. **Migrate** through the normal deploy (`migrate_db`).
2. **The migration `20261007140000_mark_pay_what_you_want_events_search_reindex`
   marks the affected events.** It inserts a `SearchReindexPending` row for
   every event with an ACTIVE ADJUSTABLE tier whose floor is 0, and the next
   `search.drain-reindex-pending` run rewrites their documents. Until a
   document is rewritten, its new column reads false and its `has_free_tier`
   is still true, so search results, index-backed cards and embed grids keep
   saying "Free" for it. DB-backed listings and the embed calendar compute the
   rollup live and are right as soon as the code ships.
3. **Run `search.full-reindex` after the migration as the backstop.** As in
   `absorb-removed.md`, a drain that reads a row during the deploy can clear
   it before the new code is live. The nightly `search.full-reindex` (03:00
   UTC) would fix that within a day, but do not wait for it.
