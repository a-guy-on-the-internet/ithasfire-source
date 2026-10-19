# Tax Nexus Threshold Watch — Operations Runbook

**Date:** 2026-07-01
**Type:** operational runbook (internal; not a user-facing help article)
**Companion to:** [tax-collection-and-compliance-readiness.md](../specs/2026-07-01/completed/tax-collection-and-compliance-readiness.md) (the spec — Tier 1 §5.3 shipped this surface)
**Audience:** platform finance / staff (roles `ADMIN` · `REVIEWER` · `SUPPORT` · `DEVELOPER`)

---

## 1. What this is

We are the **marketplace facilitator**: the platform is liable to collect and remit sales tax (US)
and GST/HST (Canada) on tickets we sell for organisers. Liability in a jurisdiction only begins once
we cross that jurisdiction's **economic-nexus threshold**. This runbook explains how to watch those
thresholds using the shipped tooling, and what to do when one is approached.

It does **not** cover how tax is *calculated* or *held* — see the companion spec §2–§5 for that. Tax
is collected at checkout and held on the platform balance, excluded from organiser payouts.

## 2. The tool: `platform.taxNexusRollup`

A staff-only tRPC query (`packages/transport/trpc/src/routers/platform.ts`) backed by
`getTaxNexusRollup` (`packages/core/src/use-cases/tax/get-tax-nexus-rollup.ts`).

- **Input:** `{ windowMonths?: number }` — an integer from 1 to 60, default `12` (the standard rolling nexus window).
- **Output:** `{ rows: [...], since, windowMonths }`, one row per jurisdiction:
  | field | meaning |
  |---|---|
  | `country` / `state` | the frozen tax **situs** (venue country + state/province code, e.g. `US`/`FL`, `CA`/`AB`) |
  | `netSalesCents` | facilitated sales, **net of partial refunds** — the number the threshold is measured against. See §3 and §7: this changed in Sep 2026 and it changed the direction of the error. |
  | `taxCollectedCents` | tax collected and **still held** for that jurisdiction — refunded tax is netted out |
  | `orderCount` | counted orders |
  | `taxByLine` | `taxCollectedCents` split per platform-collected tax line (`code`, `jurisdiction`, `collectedCents`), summing to it exactly. Tax that cannot be put on a real line (orders from before `OrderTaxLine` existed, lines that disagree with the order's tax, refunds on multi-line orders that cannot be split exactly) sits on the `UNATTRIBUTED` line. |
- **Counted orders:** `SUCCEEDED` + `PART_REFUNDED`, created within the window. Fully `REFUNDED`,
  `CANCELLED`, `PENDING`, `PROCESSING` and `DISPUTED` are excluded (nothing sets `DISPUTED`; see §7).
- **Grouping key** is the *frozen* situs snapshotted onto each Order at checkout, so historical
  numbers stay correct even if a venue is later edited.

## 3. Reading the numbers correctly

- **The threshold is on `netSalesCents` (ticket sales / "dispersed"), NOT our platform fee.**
  We cross on the big number and earn our cut of it; $100k of sales in a state ≈ real activity, and
  the ~$150 registration + ~$75/filing compliance cost is trivial against it.
- **`netSalesCents` is now NET of partial refunds, so it no longer over-counts — and that means it no
  longer errs on the safe side.** Several US states measure economic nexus on *gross* sales, returns
  included. Where that is true, this figure now reads LOWER than the number the state measures, and a
  jurisdiction can cross its threshold while this rollup still shows you under it. Put the question
  to the tax pro (§5 step 1 / §6): which basis does each live jurisdiction use? If any of them is
  gross, treat this column as a floor and add the refunded portion back by hand. To restore the old
  conservative behaviour, drop the `netSalesCents` CASE arm in `getTaxNexusRollup` — the tax leg is
  independent of it and should stay netted either way.
- **US thresholds:** most states are **$100,000 in sales over a rolling 12 months**. Our current
  US venues — **Fort Myers, FL** and **Nashville, TN** — are both **$100k-only, no transaction-count
  prong**, and both tax admissions at the general rate. So a state only matters once its
  `netSalesCents` approaches `10_000_000` (=$100k).
- **Canada:** a different regime. **Alberta (Edmonton)** is flat **5% GST** (no PST). CRA
  platform/facilitator rules have a low **CAD $30k** threshold, and **admission-event businesses may
  owe from the first sale** — treat Canada as a *live* obligation, not a someday one (see §5).
- **Rows with `country`/`state` = null** are orders with no frozen situs: events with no resolvable
  venue location, free orders, and orders created before the situs stamp shipped (§7). A paid order
  on an event with no location carries real sales here, so a non-zero null row is sales the rollup
  cannot place in any jurisdiction. Look at where it came from rather than skipping it.

## 4. Alerting policy (target)

Review the rollup on a regular cadence (or wire a scheduled alert — a deferred Tier-2 item, not yet
built). **Act when any jurisdiction reaches ~80% of its threshold** (US: `netSalesCents` ≥ ~$80k
rolling-12mo) so registration is proactive, never late.

## 5. What to do when a jurisdiction approaches / crosses

This is the trigger that activates the parked compliance work (spec §6, Tier 2):

1. **Confirm with a tax advisor** (spec Tier 0 / §11): are we actually over the threshold, are we the
   facilitator of record there, and what is the correct admission treatment?
2. **Register** as a marketplace facilitator in that state (or with CRA for Canada). This sets a
   collection start date + a state-assigned filing frequency.
3. **Turn on filing/remittance** via the chosen vendor (Numeral is the current front-runner —
   pay-per-filing, no order caps; spec §9). This is when the `TaxLiabilityEntry` ledger +
   `TaxReportingPort` (spec §6) get built.
4. **Fund remittance** from the held tax on the platform balance and reconcile (spec §6 item 4).
5. Once registered, you must file **every period even at $0** until you formally deregister.

## 6. Current standing action items (Tier 0 — do these first)

- **Get the tax-pro nexus opinion** on: are we under $100k in FL & TN today (almost certainly yes →
  nothing due in the US yet), and does Alberta's admission-event rule force immediate CRA GST
  registration?
- **Alberta is the one likely-live obligation.** Edmonton events now collect 5% GST (previously $0),
  and CRA registration + GST returns may already be required. Prioritise this.

## 7. Caveats / known limitations (v1)

- **`PART_REFUNDED` orders are now netted** (Sep 2026). Both legs changed, and they carry different
  confidence:
  - **Tax** is netted from `OrderItem.refundedTaxCents`, stamped at refund execution from the same
    expression that produced the refund
    (`packages/core/src/lib/orders/refund-tax-share.ts`). The column is **not backfilled**: refunds
    issued before it existed are NULL, and a NULL contributes nothing to the netting, so those orders
    still report their full original tax — the old over-count, confined to pre-Sep-2026 refunds.
  - **Gross** is netted by scaling `amountGrossCents` by the refunded fraction of ticket value, which
    needs no stamp and therefore applies to *all* history. This **reversed the conservative posture
    this runbook previously relied on** — see §3. Note the build spec asked for it: §5.3 of
    `docs/specs/2026-07-01/completed/tax-collection-and-compliance-readiness.md` specifies "net facilitated sales
    (`amountGrossCents` minus refunds/cancellations)", while that spec's own §3 defines the threshold
    as gross GMV — the spec is internally inconsistent, and this runbook's former gross posture was
    the deviation from §5.3, not the code. Whichever way it lands, reconcile spec §3 and §5.3. It is
    one `CASE` arm to undo.
  - Two known over-counts remain in the tax leg: a lost dispute never changes `Order.status`, and
    nothing tracks what has already been remitted to a jurisdiction.
- **No automated alert job or admin UI yet** — the query is callable but you read it on demand. Both
  are deferred Tier-2/UI follow-ups.
- **Only AB, NT, NU and YT collect Canadian tax** (flat 5% GST, `packages/core/src/lib/tax/canada-rates.ts`).
  The HST provinces (ON, NB, NL, NS, PE) are commented out of the table until we operate there, and the
  PST/QST provinces (BC, SK, MB, QC) are left out on purpose rather than under-collect the missing
  PST/QST. An event in any of them collects **no** tax. Each time its rate is resolved it logs
  `tax_rate_ca_province_unsupported` at `warn` and reports to Sentry (search the tags
  `useCase:resolveEventTaxRate reason:ca_province_unsupported`). Checkout, cart edits and door quotes
  report unthrottled, once per attempt. Don't sell into those provinces until their rates are added.
- Numbers are only as good as the situs stamp — orders created before this shipped have null situs
  (no backfill) and group under the null row.
