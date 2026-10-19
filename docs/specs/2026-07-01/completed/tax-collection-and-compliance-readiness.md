# Tax Collection & Compliance Readiness — Marketplace Facilitator Sales Tax / GST

**Date:** 2026-07-01
**Status:** draft (Tier 1 implementation-ready; Tier 0 legal items gate the rest)
**Priority:** P1 (facilitator liability + a live under-collection gap on Canadian events)
**Owner:** finance / payments
**Supersedes:** the earlier `kintsugi-tax-integration.md` draft (this is a full rewrite — the conclusion is that this is *not* a Kintsugi-centric build; vendor choice is deferred and Numeral currently leads for our footprint).
**Companion to:** `docs/ticketing-and-stripe.md` (tax), `docs/hot-paths.md` (checkout money path), `../2026-06-29/` (ZipTax coverage fix), engineering-standards §6/§7.

---

## 1. TL;DR / decision context (read this first)

We are the **marketplace facilitator** — the platform, not the organiser, is liable to collect and
remit admission sales tax (US) and GST/HST (Canada). We already **hold** collected tax on the
platform balance, excluded from splits (`computeAgreementBasis = amountGrossCents − feesPlatformCents`,
verified in `finalize-from-payment-intent.ts:655-659`). **That money model does not change here.**

After scoping against our **actual footprint** (three venues — Fort Myers FL, Nashville TN, Edmonton
AB), the obligation is **small and threshold-gated**, not a 50-state compliance machine. So this spec:

- **Builds a small Tier 1 now** (no vendor, no new failure modes): a Canadian GST rate branch (fixes
  a live $0-collection gap), a point-in-time tax-situs snapshot on the Order, and a threshold-watch
  rollup so we know when a jurisdiction crosses.
- **Parks the compliance machine behind explicit triggers** (Tier 2/3): the jurisdiction ledger,
  vendor filing/remittance, and any move to a live tax engine at checkout. Designed, documented,
  *not built*, so future-us knows exactly what to build and when — without over-building today.

Key reversals from the first draft, with rationale preserved in §7–§9:
- **No `TaxLiabilityEntry` ledger in Tier 1.** "How much did we collect, where" is a query over
  existing data; a normalized liability table earns its place only when we report/remit (Tier 2).
- **No Kintsugi (or any vendor) in the checkout path.** ZipTax stays the cached calc engine; vendors
  are for *filing/remittance*, threshold-gated and pay-per-use.

## 2. Current state (verified 2026-07-01)

- **US rate:** frozen flat rate stamped at publish (`event.admissionTaxRateBps ?? 0`), applied to the
  post-discount subtotal (`create-checkout.ts:444-448`). Defaults to 0.
- **Canada: $0 collected today.** The ZipTax adapter is US-only by construction — it returns `null`
  for any non-US country and rejects non-5-digit postal codes
  (`ziptax-adapter.ts:40-49`). Every Edmonton event therefore resolves to **0 tax**. This is a
  **live under-collection exposure**, not a future one.
- **Money model:** tax held on the platform balance, excluded from splits/settlement (verified).
- **Persistence:** `Order.taxAmountCents` is stored. The **tax situs** (the venue jurisdiction that
  actually determines the tax) is **not** snapshotted on the order — only the buyer's billing address
  is. So historical tax attribution currently depends on the event's *mutable* venue.
- **Legacy:** `Order.stripeTaxCalculationId` always null (no Stripe Tax). Leave it null.

## 3. The actual footprint (grounding — this is what shrinks the problem)

Threshold = **gross facilitated sales into the jurisdiction (GMV / "dispersed")**, measured over a
rolling 12 months — **not** our platform fee. As facilitator we count the aggregate value of all
tickets we sell into that jurisdiction. We cross on the *big* number and earn the *small* one, but
the compliance cost ($150 registration + ~$75/filing) is trivial against the revenue at that scale.

| Venue | Regime | Threshold | Admissions | Notes |
|---|---|---|---|---|
| **Fort Myers, FL** | US sales tax | **$100k, no transaction count** | Taxable | FL excludes facilitated sales from the *seller's* threshold (organisers not double-hit). ZipTax combined rate ≈ correct. |
| **Nashville, TN** | US sales tax | **$100k, no transaction count** | Taxable (~9.25%) | ZipTax combined rate ≈ correct. |
| **Edmonton, AB** | **Canada GST** | CRA platform rules, **CAD $30k** — but admission-event businesses may owe **immediately** | 5% GST, no PST | Separate regime; ZipTax irrelevant; **live gap today**. Alberta is the simplest province (flat 5%, no local variation). |

Consequences that de-risk everything:
- **The "200 transactions = forced compliance on ~$100 of revenue" trap does not exist here.** Both
  US states are dollar-volume-only. We register in FL/TN **only after $100k of sales** in that state —
  real money.
- **Situs is trivial for us.** Origin-based admission situs = the venue address, which we already
  capture and already use for the ZipTax stamp. (The "situs problem" only bites *passive third-party
  ingestion* that sees the buyer's billing address; it's a non-issue when we attribute ourselves.)
- **Canada is the one live obligation**, and it's a single flat-rate GST registration — bounded.

## 4. Scope tiers

| Tier | What | Build? |
|---|---|---|
| **0** | Legal/ops gate: tax-pro nexus opinion + CRA registration | Not code — §11 |
| **1** | Canada rate branch · situs snapshot on Order · threshold-watch rollup | **Build now** — §5 |
| **2** | Jurisdiction ledger · vendor filing/remittance · breakdown reclaim · remittance funding · refund tax reversals · exemptions · zero-returns | Parked, trigger-gated — §6 |
| **3** | Live tax engine at checkout (Kintsugi-calc) via port seam | Conditional, likely never for FL/TN — §7 |

## 5. Tier 1 — build now (small, no vendor, no new failure modes)

### 5.1 Canadian GST rate branch

Canada needs no rate *API* — the whole country is ~a dozen **province-level** rates, and Alberta is a
flat **5% GST**. Add a static branch, not a ZipTax upgrade.

- New constant `packages/core/src/lib/tax/canada-rates.ts`:
  ```ts
  // GST/HST by province in basis points. GST-only provinces here; PST/QST provinces
  // (BC, SK, MB, QC) require GST + a separate PST calc and are OUT OF SCOPE until we
  // operate there (see §11). Alberta is flat 5% GST, no PST, no local variation.
  export const CANADA_GST_HST_BPS: Record<string, number> = {
    AB: 500, // GST only
    // ON: 1300, NS/NB/NL/PE: 1500, ... (HST provinces — add when we operate there)
  };
  export const CANADA_TAX_RATE_SOURCE = "ca_gst_hst";
  ```
- Wire into the event-tax-rate resolution (`events/_shared/resolve-event-tax-rate.ts` + the checkout
  self-heal in `resolve-checkout-tax-rate.ts`): when `countryCode === "CA"`, resolve the rate from
  `CANADA_GST_HST_BPS[event.region]` (province code we already store), stamp
  `admissionTaxRateBps` + `taxRateSource = "ca_gst_hst"`. No external call. Unknown province →
  0 + a loud log (so an unsupported province surfaces rather than silently under-collecting).
- ZipTax's US-only guard stays; this is a parallel branch, not a ZipTax change.
- **Effect:** Edmonton events collect 5% GST instead of $0. The held-tax model already carries it
  onto the platform balance, same as US tax — no money-flow change.

### 5.2 Point-in-time tax-situs snapshot on the Order

This is the durable core, and it replaces the Tier-1 ledger. The tax *amount* is already frozen on
the order; freeze the *situs* next to it so historical rollups stay correct even if a venue is later
edited.

- New nullable Order columns (`packages/db/prisma/order.prisma`):
  ```prisma
  taxSitusCountry  String?  @db.VarChar(2)  // "US" | "CA"
  taxSitusState    String?                  // state / province code
  taxSitusPostal   String?
  taxRateSource    String?                  // "ziptax" | "ca_gst_hst" | "none"
  ```
- Stamp them in `create-checkout.ts` at order-create time, from the resolved venue jurisdiction +
  the rate source used — a small addition to the existing tax block (`create-checkout.ts:430-448`),
  no behavior change to the tax *amount*. (Also stamp on the inline credit-covered path and, for
  completeness, at finalize if null.)
- No new table, no breakdown JSON, no `remittedAt` — those are Tier 2.

### 5.3 Threshold-watch rollup

Free, self-hosted nexus monitoring — we don't need a vendor's paid tier to sum our own sales.
Operations: see the [threshold-watch runbook](../../../runbooks/tax-nexus-threshold-watch.md) for how staff
read the `platform.taxNexusRollup` output and what to do when a jurisdiction nears its threshold.

- Repo/query: sum **net facilitated sales** (`amountGrossCents` minus refunds/cancellations) grouped
  by `taxSitusCountry` + `taxSitusState`, over a **rolling 12 months**, keyed on the *snapshotted*
  situs (so it's stable). Also expose collected-tax per jurisdiction (for the eventual remittance
  picture).
- Surface: an admin rollup view and/or a scheduled job that **alerts at ~80% of threshold**
  ($100k US; the CAD figure for Canada) so registration is proactive, never late.
- This is the trigger source for Tier 2: when a jurisdiction approaches its threshold, we register +
  turn on filing there.

### 5.4 Money model — untouched

Tax stays held on the platform balance, excluded from splits/settlement/transfers, exactly as today.
No change to `computeAgreementBasis`, settlement, or payout logic.

## 6. Tier 2 — parked compliance machine (designed, trigger-gated, NOT built)

Build these **when the first jurisdiction crosses its threshold / we register** (trigger from §5.3):

1. **`TaxLiabilityEntry` ledger** — normalized per-jurisdiction / per-seller record written at
   finalize, carrying the jurisdiction breakdown, `rateSource`, currency/country, `remittedAt`. This
   is where the *reconciliation surface* (collected vs remitted vs held) lives. Backfillable from the
   situs-snapshotted orders (§5.2), so deferring it loses nothing. **Trigger:** first registration.
2. **`TaxReportingPort` + vendor adapter** — report committed sales to the filing vendor. **Numeral**
   is the current front-runner for our shape (§9): pay-per-filing, no order caps, no monthly base,
   Canada coverage on Pro. Kept behind a capability port so the vendor is swappable. **Trigger:**
   first registration.
3. **ZipTax jurisdiction breakdown reclaim** — the ZipTax response already contains
   state/county/city/district detail we currently discard (`ziptax-adapter.ts:75-84`); surface it
   (extend `TaxRateLookupResult`, cache alongside the rate) to give ledger rows real local
   attribution. **Trigger:** when local (sub-state) filing detail is needed.
4. **Remittance funding + reconciliation** — the money-movement seam between "we hold the tax on the
   platform balance" and "the state/CRA got paid": fund each remittance from the held balance, mark
   `remittedAt`, reconcile the held-tax bucket. **Trigger:** first filing.
5. **Refund/chargeback tax reversals** — a refunded order reduces liability; report the negative to
   the vendor + ledger so returns net out. (Our refund flow withholds only the processing fee —
   the tax portion reverses.) **Trigger:** first filing.
6. **Exemptions + zero-returns + state notices** — exemption certificates, mandatory $0 returns once
   registered, inbound correspondence handling. **Trigger:** first filing.

## 7. Tier 3 — live tax engine at checkout (conditional, likely never for FL/TN)

Only if **admission-taxability drift** ever proves material would we move calculation off ZipTax onto
a live engine (e.g. Kintsugi). For FL/TN it won't — both plainly tax admissions at the general rate,
and Alberta is a flat 5%. If it ever does:

- Introduce `TaxCalculationPort` (`calculateOrderTax → { taxAmountCents, jurisdictions[], rateSource,
  providerRef }`); checkout depends on it and persists the reported `rateSource`.
- Compose `createFallbackTaxCalculator([vendor, ziptax], { timeoutMs })` — vendor primary, ZipTax
  cached fallback, timeout in one tested adapter so the hot path stays a single call with no
  branching. One vendor adapter can implement both `TaxCalculationPort` + `TaxReportingPort`.

This is why §5.2 already stores `taxRateSource`: the seam is reserved, not built.

## 8. Rationale — why ZipTax calculates and vendors only file (preserve this)

- **Filing vendors file what you report you collected.** So ZipTax computes tax → we collect → we
  report that amount → the vendor files it: **collect = remit by construction**. The vendor does not
  need to be the one doing the multiply for the numbers to agree.
- **ZipTax is cached and zero-latency** — the rate is stamped on the venue at publish; checkout is a
  pure multiply. Putting a vendor in checkout adds an external call to the money path (checkout does
  already call Stripe, so it's not sacred — but it buys nothing here) and a Premium-tier dependency.
- **The one real risk of ZipTax-calc is admission taxability** (it gives a combined *sales* rate, not
  an admission ruling). For our footprint that risk is null (FL/TN tax admissions; AB is flat GST),
  and the eventual vendor-liability-vs-collected drift check (Tier 2) is the ongoing guardrail.

## 9. Vendor landscape (parked decision — documented so we don't re-research)

Cost is driven by **jurisdictions × filing cadence**, not order volume or vendor. ~$75/filing is the
market rate. What differs:

| Vendor | Model | Fit |
|---|---|---|
| **Numeral** | $75/filing + $150/registration, **no monthly base, no order caps**, Canada on Pro (API access) | **Front-runner** for our footprint (high order volume, few jurisdictions). |
| **TaxCloud** | SST CSP — **free calc+filing in 24 SST states**; paid tiers order-capped | Big lever *later* if we expand into many SST states; order caps make its cheap tiers a trap for ticketing. FL is an SST member; TN is not. |
| **Kintsugi** | ~$500/mo Premium for API | Overkill for 3 jurisdictions; positioned for SaaS nexus cleanup. |
| **Anrok** | $399/mo | Wrong fit (SaaS/digital). |

API access is Premium/custom on both Numeral (Pro) and Kintsugi — so any *programmatic* reporting
(Tier 2) needs the paid tier; confirm pricing for our jurisdiction count on the same call as §11.

## 10. Non-goals / do NOT touch

- Split basis, settlement amounts, transfers, payout scheduling, platform-holds-funds. Tax stays
  excluded from payee transfers.
- Stripe Tax (`stripeTaxCalculationId` stays null).
- The `TaxLiabilityEntry` ledger, vendor integration, live checkout calc — all deferred (§6/§7).
- Non-Alberta Canadian provinces with PST/QST (BC/SK/MB/QC) — out of scope until we operate there.
- Resale tax attribution — separate follow-up.
- No buyer-facing tax UI change. No backfill of historical orders.

## 11. Open questions — Tier 0 legal/ops gate (highest priority)

1. **Are we under $100k in FL and TN?** (Almost certainly yes → **nothing due in the US yet**.) A
   short tax-pro nexus opinion confirms it and shrinks the near-term obligation to Canada only.
2. **Does Alberta's admission-event rule force immediate CRA GST registration** despite the CAD $30k
   small-supplier threshold? If yes, CRA GST registration is the one live to-do.
3. **Are we the marketplace facilitator of record in each jurisdiction** (vs. the organiser)? Standard
   post-Wayfair / Canadian platform rules say yes where we process payment, but confirm.
4. **Vendor + API pricing** for our jurisdiction count (Numeral Pro) — same call as §9.
5. **Remittance funding mechanics** (Tier 2): how held platform-balance tax funds each state/CRA
   remittance, and reconciliation to `remittedAt`.
6. If we ever go Kintsugi (Tier 3): disconnect the existing Kintsugi↔Stripe plug-and-play app before
   cutover to avoid double-ingestion.

## 12. Tests (Tier 1 only)

- **Canada rate branch:** an Alberta event resolves to 500 bps / `ca_gst_hst`; a US event still uses
  ZipTax; an unknown CA province resolves to 0 with a warning; the buyer charge includes the GST.
- **Situs snapshot:** a checkout stamps `taxSitusCountry/State/Postal` + `taxRateSource` from the
  venue jurisdiction (not billing); editing the event venue afterward does **not** change the
  stamped order values.
- **Threshold rollup:** net-sales-by-situs over a rolling 12 months is correct; refunds reduce it;
  the alert fires at the configured fraction of threshold.
- **No money-flow regression:** splits, settlement, and transfers unchanged; `computeAgreementBasis`
  untouched; the buyer tax *amount* for US events is byte-for-byte the same as before.

## 13. Migration / rollout

**Migration** (`pnpm db:migrate:dev --name add_tax_situs_snapshot`): additive only — four nullable
`Order` columns (§5.2). No backfill (accrues forward; historical orders can be backfilled from
event venue if ever needed). No new table, no enum.

**Sequence:**
1. Canada rate branch (§5.1) — fixes the live Edmonton gap first; smallest, highest-value slice.
2. Situs snapshot columns + checkout stamping (§5.2).
3. Threshold-watch rollup + alert (§5.3).
4. Tier 0 legal consult (§11) — in parallel; gates whether any Tier 2 work starts.
5. Tier 2/3 remain parked until a jurisdiction crosses (trigger from §5.3) or counsel says otherwise.

No feature flag needed for Tier 1 (Canada branch + situs stamping + a read-only rollup are inert to
existing US behavior). The tax *amount* on US orders is unchanged; only Canadian orders start
collecting correctly and every order gains a frozen situs.

## 14. Acceptance criteria (Tier 1)

- An Edmonton event collects 5% GST (was $0); the amount lands on the platform balance like US tax.
- Every new paid order carries a frozen `taxSitus*` + `taxRateSource`, sourced from the venue
  jurisdiction, unaffected by later venue edits.
- The threshold rollup reports net facilitated sales per US state / CA province over a rolling 12
  months and alerts before $100k.
- US buyer tax amounts, splits, settlement, and transfers are byte-for-byte unchanged; no new
  external call on the checkout path.
- No `TaxLiabilityEntry` table, no vendor integration, no checkout tax-engine call ship in Tier 1.
