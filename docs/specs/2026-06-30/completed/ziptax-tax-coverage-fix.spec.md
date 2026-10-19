# Fix: ZipTax sales-tax coverage gap

**Status:** IMPLEMENTED 2026-06-30 (both halves reviewed APPROVED). Committed locally as `6298edc4` on `main`, **not pushed**. Remaining before live: push → deploy runs migration `20260630000000_place_tax_rate_cache` → run `backfill-tax-rates.ts` (`--dry-run` first). Save-time-stamp clobber-guard covered by `save-event-tax-stamp.test.ts` (6 cases). Open NIT (non-blocking): cached rows with null `taxRateSource` resolve as `source: "unknown"`.
**Authored:** 2026-06-30
**Severity:** High — under-collection of sales tax on the most common event-creation path.
**Related:** [event-builder-manual-qa.spec.md §2.3](../../../records/2026-06-30-event-builder-manual-qa.md), [[project_tax_provider]]

---

## Problem

ZipTax sales-tax lookup only runs on **one** of three location modes. Events created at a registered venue (Place) — the dominant organizer path — collect **$0 admission tax**.

### Evidence (verified on dev, 2026-06-30)

- The **ZipTax adapter is correct** — live-API matrix passed (TX 8.25 %, NYC 8.88 %, LA 9.75 %, Chicago 10.25 %; OR/NH/AK = 0; non-US / invalid / zip+4 / case all handled).
- Of all events on dev, **only 2** carry a real `tax_rate_source = 'ziptax'` stamp — both `saved-location` mode.
- **7/7 place-based events** show a non-null `admission_tax_rate_bps` **only because the seed hardcodes it** (`apps/api/src/scripts/seed/events.ts:167` and `:410` write `admissionTaxRateBps` from a region map; `tax_rate_source` left blank). No runtime path stamps tax on a place event.
- ⚠️ **The seed masks the bug** — dev UI testing of seeded events shows correct tax and falsely passes. Only `source='ziptax'` rows reflect the real code path.

### Root cause (code path)

1. `normalizeLocation` (`packages/core/src/use-cases/events/_shared/save-event-shared.ts:265`) → three modes: `place` / `saved-location` / `freeform`.
2. Tax lookup runs **only** inside `if (params.location.kind === "freeform")` on **new** SavedLocation creation (`save-event-shared.ts:629–715`). The reuse branch (`:648`) just bumps a usage counter.
3. `resolveTaxRateForEvent` (`packages/core/src/use-cases/events/publish-event.ts:651`) returns null unless `event.savedLocationId` is set **and** that SavedLocation already has a cached rate.
4. Checkout: `const taxRateBps = event.admissionTaxRateBps ?? 0` (`create-checkout.ts:420`, `update-order-items.ts:168`) → null ⇒ no tax line.
5. `Place` has `address` / `region` / `country` but **no postal code and no tax columns** — nothing to look up from, nowhere to cache.

### Coverage matrix (today)

| Location mode | Lookup runs? | Tax at checkout |
| --- | --- | --- |
| Freeform, new address | ✅ yes | ✅ correct |
| Freeform, reused address (rate already cached) | ⚠️ uses stale cache | ✅ if cached |
| Saved-location, picked from "My Places" | ❌ no | ❌ $0 unless previously cached |
| **Place / venue** | ❌ no | ❌ **always $0** |

---

## Proposed fix

**Primary mechanism — look up tax at _location save_ time, gated on address-new-or-changed**, and cache the rate on the location row (Place or SavedLocation). This mirrors how freeform SavedLocations already work and keeps the cache fresh exactly when the address changes. `Place` already has an `addressHash` column — a changed hash is the natural trigger. A **publish-time resolver remains as a safety net** that resolves the rate from whichever location the event uses and does a last-chance lookup if the cache is still empty.

> Verified on dev 2026-06-30: `Place` **already stores the postal code** (DB column `postcode`, Prisma field `postalCode`, persisted by `upsert-place.ts`) plus `addrLine1/2`, `city`, `region`, `country`, `addressHash`, `lat`, `lng`. It only lacks the **tax-cache columns**. So no postal-code source work and no reverse-geocoding are needed — a big simplification from the first draft.

### Required changes

1. **Schema — add a tax cache to `Place`** (Prisma migration, `packages/db/prisma/schema.prisma`):
   - Add `admissionTaxRateBps Int?`, `taxRateSource String?`, `taxRateFetchedAt DateTime?` to `Place` (mirror `SavedLocation`; match the existing snake_case `@map` convention — e.g. `@map("admission_tax_rate_bps")`).
2. **Place save — lookup-on-change** (`packages/core/src/use-cases/places/upsert-place.ts`):
   - `postalCode` is already captured (input schema line 46, persisted line 400) and `addressHash` already computed.
   - When the place is created **or its `addressHash` changes**, call `deps.taxRateLookup.lookupByPostalCode({ postalCode, countryCode })` and cache `admissionTaxRateBps` + `taxRateSource` + `taxRateFetchedAt` on the `Place`. Non-fatal on failure (leave null; checkout falls back to zero, same as today).
   - Factor the freeform-SavedLocation lookup (`save-event-shared.ts:685–715`) into a shared helper so both call sites behave identically. Thread `taxRateLookup` into the upsert-place deps (it's already constructed in `dep.ts`).
3. **Resolver — `resolveTaxRateForEvent` becomes location-agnostic** (`publish-event.ts`):
   - Resolve postal/country + cached rate from `placeId` → else `savedLocationId` → else event's inline address.
   - Use the cached rate if present; if null (place created before this fix, or lookup previously failed), do a last-chance lookup at publish and cache it back. Thread `deps.taxRateLookup` into `publishEvent` (already available in `dep.ts`).
4. **Staleness TTL (optional, lower priority)** — since the rate refreshes on address change, staleness only matters when a jurisdiction's rate moves under a fixed address. Treat a cached rate as stale when `tax_rate_fetched_at` older than N days (propose 90) and refresh at publish.
5. **Saved-location-mode lookup** — selecting an existing SavedLocation with a null rate now stamps via the publish-time safety net (#3).
6. **Backfill** — one-off script: for existing `Place` rows (which already have `postcode`), run the lookup and cache; for PUBLISHED US events with `source` ≠ `'ziptax'` (seed/legacy/null) and no issued tickets, re-resolve and stamp a real rate. Events with issued tickets: leave (tax already charged).
7. **Seed honesty** — set `tax_rate_source = 'seed'` on seeded events so they're distinguishable from real stamps and stop masking the bug in QA.

### Explicitly out of scope / open questions

- **Origin- vs destination-based sourcing** is a *policy* question, not this fix. Today's model is origin-based (event location). Keep it; flag separately if the tax team wants destination sourcing. See [[project_tax_provider]].
- **Place postal-code population** — if Places lack lat/lng too, geocoding source must be chosen (Google Places already used in the builder autocomplete).
- Non-US events remain untaxed by design (adapter returns null).

---

## Build plan (layer-ordered)

1. `infra`/`coder`: Prisma migration — `Place` postal + tax columns.
2. `coder`: extend `resolveTaxRateForEvent` to be location-agnostic + do publish-time lookup-and-cache; thread `taxRateLookup` into `publishEvent`; TTL helper. Unit tests: place-mode stamps, saved-location-mode stamps, stale refresh, lookup-failure non-fatal.
3. `coder`: populate `Place.postalCode` on place create/verify; backfill script for existing places.
4. `coder`: backfill script for mis-stamped events; seed `source='seed'` change.
5. `reviewer`: money-math + idempotency review (re-stamp safety, no double-tax).
6. Manual: re-run [§2.3](../../../records/2026-06-30-event-builder-manual-qa.md) against a **non-seeded** place-based event end-to-end through checkout.

---

## Acceptance

- [ ] A newly-created **place-based** US event, published, has `admission_tax_rate_bps` set with `source='ziptax'`.
- [ ] A **"My Places" saved-location** US event likewise stamps a real rate at publish.
- [ ] Checkout on each charges the correct tax line (verified against the ZipTax rate for that zip).
- [ ] Stale cache (> TTL) refreshes at publish.
- [ ] Lookup failure still publishes (null rate, no crash).
- [ ] Seeded events carry `source='seed'`; backfill stamps real rates on legacy events without issued tickets.
