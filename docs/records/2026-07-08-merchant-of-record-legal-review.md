# Merchant-of-Record: legal-document impact review

**Date:** 2026-07-08
**Status:** Research / to-do list for counsel. **Not legal advice** — every item below needs a payments/fintech attorney to redline before it carries weight.
**Trigger:** We confirmed Ithas Fire is the **merchant of record (MoR)**: with Stripe Connect *separate charges and transfers*, buyer payments land in Hearthfire's platform balance and we transfer the organiser's net share afterward. The live Terms previously said the opposite ("technology marketplace… not the merchant of record"). That's now corrected in a draft, and this memo catalogues everything else the MoR position touches.

---

## 0. The one distinction to keep straight

Two things get conflated and counsel will care about the difference:

- **Merchant of record** is a *card-network* concept — who the buyer's transaction is "with," who appears on the statement, who owns disputes/refunds/chargebacks. Under separate charges and transfers, **that's us.**
- **Possession/control of funds** is a *money-transmission* concept. Standard Stripe Connect is engineered so the platform normally stays *out of* possession of seller funds (Stripe is the licensed money transmitter). But because we **hold funds in the platform balance and gate payout on event completion**, we lean into the "platform holds funds" pattern Stripe explicitly calls out. Being MoR does not by itself create a money-transmitter problem, but the fund-holding is a separate axis worth a specific legal read.

Both point the same direction (we're MoR), but they carry different obligations. Don't let "we're MoR because we hold funds" collapse them.

---

## 1. Terms of Service — what changed and what still needs review

**Already changed (draft, uncommitted, banner added):**
- §3 retitled and rewritten to state we're MoR, collect into our own account, and carry refund/chargeback responsibility — while keeping the Organiser solely responsible for *producing* the event.
- §4 reframed: payment is with Ithas Fire as MoR; the event/admission is between buyer and Organiser.
- §6 payout language reframed as "collect as MoR → transfer net share," expanded withhold/reserve/**reverse** rights, organiser chargeback/refund responsibility + recovery authorisation.
- §10 now cross-links the standalone Acceptable Use Policy.

**Still needs counsel review because the old drafting assumed the marketplace/agent theory:**
- **§13 Disclaimers / §14 Limitation of liability / §15 Indemnity.** These were written to disclaim responsibility as a mere intermediary. As MoR we've taken on transactional exposure (we're the seller of record for payment). Counsel should confirm these still hold and that the "not responsible for the event itself" carve-out is clean vs. our new "responsible for the payment" position.
- **§5 Refund policy.** We now *are* the refunding party of record. The card networks require the MoR's refund path to be clear. Confirm §5 + the `/help/buying-tickets/refunds-and-cancellations` article present Ithas Fire (not the organiser) as who issues the refund. (Help copy already reads this way — good.)
- **Card-network MoR disclosure rule.** Stripe/Visa/MC require the customer-facing site, **payment flow, and ToS** to *clearly identify the MoR*, and that the transaction is with the MoR "and only with the MoR." §3/§4 now do this in the ToS; **checkout UI, order confirmation, receipt, and statement descriptor must match** (see §4 below).
- **Governing law / effective date** are still `[placeholder]` / "May 2026" — set on publication.

---

## 2. Acceptable Use Policy — status

The new `/acceptable-use` page is already written from the MoR posture ("we are the merchant of record on your sales"). It correctly frames the prohibited list as **payment-network/processor flowdown**, which is exactly the right basis now that *we* are the merchant the networks hold responsible. Counsel review items:
- Confirm the prohibited-business list matches the current **Stripe Restricted Businesses list** and card-network MCC rules (adult, cannabis/CBD, firearms, gambling/raffles, etc.). These lists change — this should be a periodic sweep, not a one-time check.
- The **automated content-moderation thresholds (hate/nudity)** language should be validated against what Stripe actually enforces so we don't over- or under-promise.
- Placeholders: `[TRUST_AND_SAFETY_EMAIL]`, `[EFFECTIVE DATE]`, `[GOVERNING LAW / JURISDICTION]`.

---

## 3. Sales tax — the biggest new obligation

Being MoR strongly implies we're also (or are treated as) a **marketplace facilitator** for sales/admissions tax in most states. These are *different* legal concepts (one is card-network, one is tax law) but they frequently coincide, and as the party collecting the money we're the natural collector.

- **All 46 sales-tax states + DC** have marketplace-facilitator laws requiring the facilitator to **collect and remit** tax on behalf of third-party sellers once nexus thresholds are met (commonly $100k sales or 200 transactions; several states — e.g. **Illinois from 2026-01-01** — are dropping the transaction test for a revenue-only test).
- We already have origin-based per-event sales tax via **ZipTax** and a *scoped-tiny* marketplace-facilitator tax spec (see memory: `project_tax_compliance_readiness`, `project_ziptax_coverage_gap`). The MoR confirmation **raises the stakes** on that spec — it's less "nice to have," more "the collector of record has to get this right." Loop the tax spec owner in.
- **Event admissions** are taxed differently from tangible goods and vary sharply by state (some don't tax admissions at all; some tax at special rates). Our current per-state admissions-vs-sales rate accuracy gap (already flagged) is now a MoR-level accuracy concern.
- **ToS tax language:** §4 says prices are all-in incl. "where applicable, sales tax," and §6 puts tax-reporting on the organiser. Counsel should reconcile: as facilitator *we* may be the remitter for sales/admissions tax, while the organiser still owns their income-tax/1099-K side. Those are different taxes; the doc should not blur them.

---

## 4. Non-legal-doc surfaces the MoR rule reaches (product + ops)

Card-network rules require **consistency across the whole buyer experience**, not just the ToS:

- **Statement descriptor** must identify Ithas Fire / Hearthfire (the MoR). Confirm the Stripe descriptor is set to us, not the connected account. (Help copy already tells buyers to whitelist "Ithas Fire" — consistent.)
- **Order confirmation + email receipt** should show Ithas Fire as MoR/seller of record.
- **Checkout** should not imply the buyer is transacting directly with the organiser's business.
- **Stripe onboarding acknowledgement:** Stripe asks the platform to *acknowledge MoR responsibilities* when onboarding as a marketplace — confirm we've accepted the correct posture on the Stripe account.
- **Dispute-rate monitoring:** as MoR, Visa/Mastercard monitor *our* aggregate dispute rate; exceeding thresholds → monitoring programs + fines. This makes the AUP enforcement powers and the chargeback-terms gate operationally important, not just legal boilerplate.

---

## 5. Documents we may be missing entirely

Given MoR + fund-holding + the DIY/edgy audience, counsel should assess whether we need:

1. **A dedicated Organiser / Seller Agreement** (distinct from the buyer-facing ToS). Right now organiser obligations live inside the general ToS §6 + the chargeback-terms gate + the AUP. Many MoR platforms split out a standalone seller agreement that bundles: payout terms, reserve/withhold/recovery rights, chargeback liability pass-through, tax cooperation, and the AUP. Worth considering for enforceability and clarity.
2. **Refund policy as a standalone, clearly-linked page** — the FTC junk-fee rule + proposed TICKET Act push toward *clear and conspicuous* refund disclosure. Ours currently lives in ToS §5 + a help article.
3. **Prohibited/Restricted Business list** — the AUP covers this narratively; a canonical list mirroring Stripe's may be cleaner to maintain and reference.
4. **Data Processing Addendum / privacy review** — we're already collecting buyer PII as the transacting party; confirm the Privacy Policy correctly describes Hearthfire as controller for payment data. (No MoR contradiction found in the current Privacy Policy, but it should be re-read through the MoR lens.)
5. **Unclaimed-property / escheatment posture** — because we hold funds before payout, un-transferred balances (dead Stripe accounts, deauthorised connections) could implicate state unclaimed-property law. Niche, but a fund-holding MoR should have an answer.

---

## 6. Ticketing-specific consumer law (independent of MoR, but we're now the responsible party)

As MoR we're the entity the FTC/state AGs look to for the buyer-facing obligations:

- **FTC "junk fees" / all-in pricing rule (in effect 2025-05-12):** total price incl. all mandatory fees must be shown *up front, clearly and most prominently*. ToS §4 already claims compliance — confirm the **checkout UI** actually leads with the all-in number. (Recent enforcement: StubHub $10M settlement, 2026-04.)
- **BOTS Act** + the 2025 executive order pushing FTC/state enforcement — relevant to our resale marketplace anti-bot posture.
- **Refund-on-cancellation / postponement** obligations (proposed TICKET Act, various state laws) — we auto-refund on organiser cancellation (good); confirm postponement handling matches state requirements.
- **Speculative-ticket disclosure** laws — mostly a resale concern; check our resale flow.
- **State ticket-resale / anti-scalping laws** — already referenced in ToS §8; keep price-cap enforcement aligned.

---

## 7. Recommended sequence

1. **Counsel redlines the ToS MoR revision + the new AUP together** (they're now interlocking). Set governing law + effective dates.
2. **Reconcile the chargeback-terms gate text** (`packages/core/src/lib/payments/chargeback-terms.ts` — already flagged "NOT LAWYER-REVIEWED") with the revised ToS §6 so the two documents describe identical payout/dispute behaviour.
3. **Elevate the marketplace-facilitator tax spec** from "scoped tiny" to a real pre-scale workstream; get a tax pro on admissions-vs-sales rates.
4. **Verify product surfaces** (statement descriptor, receipts, checkout all-in pricing, Stripe MoR acknowledgement) match the MoR position.
5. **Decide whether to split out a standalone Organiser/Seller Agreement + Refund Policy page.**

---

## Sources

- [Understand the merchant of record in a Connect integration — Stripe Docs](https://docs.stripe.com/connect/merchant-of-record)
- [Risk and liability management with Connect — Stripe Docs](https://docs.stripe.com/connect/risk-management)
- [Understand how charges work in a Connect integration — Stripe Docs](https://docs.stripe.com/connect/charges)
- [Disputes on Connect platforms — Stripe Docs](https://docs.stripe.com/connect/disputes)
- [What Is a Merchant of Record? — Stripe](https://stripe.com/resources/more/merchant-of-record)
- [Merchant of Record vs. Seller of Record — Stripe](https://stripe.com/resources/more/merchant-of-record-vs-seller-of-record)
- [A guide to the marketplace economy: tax compliance — Stripe](https://stripe.com/guides/a-guide-to-the-marketplace-economy-what-marketplace-sellers-and-operators-need-to-know-about-tax-compliance)
- [What is a money transmitter? — Stripe](https://stripe.com/resources/more/what-is-a-money-transmitter)
- [State-by-state guide to marketplace facilitator laws — Avalara](https://www.avalara.com/us/en/learn/guides/state-by-state-guide-to-marketplace-facilitator-laws.html)
- [Marketplace Facilitator Laws 101: State By State (2026) — Numeral](https://www.numeral.com/blog/marketplace-facilitator)
- [FTC: StubHub Refunding $10 Million After Deceptive Ticket Pricing (2026-04)](https://www.ftc.gov/news-events/news/press-releases/2026/04/stubhub-refunding-10-million-fees-consumers-after-deceptive-ticket-pricing)
- [S.281 — TICKET Act, 119th Congress — Congress.gov](https://www.congress.gov/bill/119th-congress/senate-bill/281/text)
- [Tickets for Live Entertainment Events (CRS R48179) — Congress.gov](https://www.congress.gov/crs-product/R48179)
