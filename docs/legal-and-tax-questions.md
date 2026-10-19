# Legal and Tax Questions

The open questions for a lawyer, a tax professional or an accountant, in one place. A build that meets one of these goes ahead on a stated default, and the question waits here until someone qualified answers it.

Owner, 2026-10-12: "We need a laywer... We need to keep track of accounting and legal tax questions like this"

**How to use this page.** When work turns up a legal, tax or accounting question nobody can answer from the code, add it here in the same session: the question, what depends on it, the default in use until it is answered, where it came from, and the date. When it is answered, move it to [Answered](#answered) with who answered and when, and update whatever depended on it.

The first list was gathered on 2026-10-12 by reading the records, specs and session notes named in each entry. Entries marked *status unclear* may already be settled somewhere not found; check before paying for an answer.

## Legal

| # | Question | What depends on it | Default meanwhile | Source | Raised |
| --- | --- | --- | --- | --- | --- |
| L1 | Review of the merchant-of-record documents: Terms §5 refunds, §13 disclaimers, §14 limitation of liability, §15 indemnity, the Acceptable Use Policy, governing law and effective-date placeholders. | Real-money launch; the Terms text is live as drafted. | Drafted text stands. | `docs/records/2026-07-08-merchant-of-record-legal-review.md`; `docs/records/2026-05-14-web-launch-checklist.md` | 2026-07-08 |
| L2 | Chargeback and payout-hold terms: is setoff strong enough, is anti-circumvention enforceable, is a later admin bound by the first admin's acceptance, do the fee, notice and cure timings and cross-account recovery match the code, does the buyer Terms need a dispute-evidence disclosure, does arbitration hold everywhere? | Paid events, checkout and payouts. `chargeback-terms.ts` says "NOT LAWYER-REVIEWED". | Current text. | `docs/records/2026-09-02-chargeback-terms-counsel-brief.md` | 2026-05-14 |
| L3 | Is a required organiser share of every resale lawful? No source found either way. | Resale share; resale stays off in production until answered. | Built behind the resale gate, off. | `docs/specs/2026-10-12/organiser-resale-share.spec.yaml` | 2026-10-12 |
| L4 | Money transmission: does holding third parties' funds in the platform balance need a licence? Includes the pot that holds tax and reserves, and unclaimed balances (escheatment). | The settlement design, live. | Stripe Connect platform balance. | `docs/records/2026-07-08-merchant-of-record-legal-review.md`; `docs/records/2026-09-06-money-mechanism.md` | 2026-07-08 |
| L5 | Is a card price higher than a bank-account price a surcharge or a discount? CT, MA and ME bans, Visa and Mastercard rules, the FTC fee rule. | Method-aware processing fee. | Card price is the standard price; a cheaper method lowers it. | session plan `session_method_aware_processing_fee` | 2026-10-10 |
| L6 | Do we need a standalone organiser agreement, a refund policy page, a data processing agreement and privacy review, a published prohibited-business list? Does the Acceptable Use Policy match Stripe's restricted list? | Launch documents. | None of them separate. | `docs/records/2026-07-08-merchant-of-record-legal-review.md` | 2026-07-08 |
| L7 | Consumer ticketing law: all-in price at checkout (FTC), postponement refunds by state, BOTS Act, speculative tickets, anti-scalping. *Status unclear.* | Checkout, resale. | All-in pricing work shipped; not reviewed by counsel. | `docs/records/2026-07-08-merchant-of-record-legal-review.md` | 2026-07-08 |
| L8 | A mission lock in the operating agreement; legal form for staged profit sharing. | Pro-social commitments; profit-sharing direction. | Proposed only. | `docs/pro-social.md` | 2026-10-11 |
| L9 | Entertainment-lawyer review of the deal-terms transparency contribution flow and its copy. | That surface (not built). | Not shipped. | `docs/specs/2026-07-13/deal-terms-transparency-map.spec.yaml` | 2026-07-13 |
| L10 | Gift balance as stored value: licensing, CARD Act, escheatment, breakage. | Venue gift balance, phase 2. | Phase 0 gate holds it. | `docs/specs/2026-05-29/venue-gift-balance.spec.md` | 2026-05-29 |
| L11 | Tennessee attorney review of the waiver clause library, house-show alcohol and donation guidance, and the host-attestation alcohol wording. *Status unclear.* | Paid events with waivers; house shows. | Shipped text. | `docs/specs/2026-04-19/completed/waiver-clause-library.spec.md`; `docs/records/2026-04-18-house-show-legal.md`; `docs/specs/2026-05-14/completed/host-attestation.spec.md` | 2026-04-18 |
| L12 | Does a subject-access request need a hard response deadline (GDPR, CCPA)? Lawyer-drafted payout agreement and arbitration clause (overlaps L2). *Status unclear.* | Data export; legal documents. | No hard deadline. | `docs/specs/2026-07-07/subject-access-request-export.spec.yaml`; `docs/specs/2026-04-13/completed/legal-documents.spec.yaml` | 2026-04-13 |
| L13 | Terms §5 says "the Ithas Fire platform fee remains non-refundable" when an event is cancelled, but the refund code, the help center and the snapshotted refund policy (`CURRENT_REFUND_POLICY_TEXT`) all refund it. Which text is binding, and should the Terms change? | Terms; refunds; dispute evidence. | Code refunds the platform fee. | `apps/web/src/app/terms/page.tsx:163`, `packages/core/src/lib/payments/refund-policy.ts:9` | 2026-10-14 |
| L15 | Arrival areas (parking, drop-off, load-in) are drawn by place owners, organisers and moderators over our basemap, which renders OpenStreetMap parking lots. If someone traces an OSM lot by eye and we store the outline, does that make our arrival-area table a derivative database under the ODbL (share-alike, attribution)? Would copying outlines with one tap (Overpass) change the answer? | Arrival areas (scoping). | Not built. v1 plan: OSM lots shown only as part of the map, nothing copied in code. | `docs/specs/2026-10-16/arrival-areas.spec.yaml` | 2026-10-16 |
| L16 | The web theme preference cookie (`th-theme-pref`: `light` or `dark`, set only when the person picks one, one year, never used for anything else). We treat it as user-requested functionality that needs no consent banner under ePrivacy/GDPR. Is that right? | Theme follows the system (scoping). | Not built; the old `th-theme` cookie works the same way today. | `docs/specs/2026-10-17/theme-follows-system.spec.yaml`, `apps/web/src/app/cookie-policy/page.tsx` | 2026-10-17 |
| L17 | Legal text says "place" (the location) and "the place's owners and operators" or "Place owners" (the party) where it used to say "venue": the volunteer waiver release and clauses 1 and 6, the waiver clause library, Terms (role definition, admission, §17 disclaimer), the house-shows page. Does naming owners and operators cover the right parties in a Tennessee release, and should Terms define "Place owner" more tightly (landlord vs tenant who runs the room)? The waiver clause library heading "GOVERNING LAW AND VENUE" (venue in the court sense) now reads "GOVERNING LAW AND FORUM": same meaning? The host attestation label "responsible for the place's rules" names the location as the rule-setter: reword? | Volunteer waiver v2 (re-signed at the next shift sign-up), Terms. | Owners-and-operators wording, from the deploy after 2026-10-17. | Owner ruling 2026-10-17; `packages/core/src/use-cases/waivers/constants.ts`; `apps/web/src/app/terms/page.tsx` | 2026-10-17 |
| L18 | A volunteer who ticks "text me shift reminders" agrees to reminders about their shifts. Does that consent also cover a text telling them the event was cancelled and they don't need to come? It is transactional and about the same shift, but it is not a reminder. | Volunteer cancellation notices. | We text opted-in volunteers when their event is cancelled (owner, 2026-10-18); SMS is off in prod until registration completes. | `docs/specs/2026-10-18/notify-volunteers-on-cancel.spec.yaml`; `packages/db/prisma/volunteer.prisma` (`smsOptIn`) | 2026-10-18 |

## Tax

| # | Question | What depends on it | Default meanwhile | Source | Raised |
| --- | --- | --- | --- | --- | --- |
| T1 | Canada: does GST registration apply from the first sale for admission events (Alberta, 5%)? | Edmonton events already collect GST. | Collect, hold. | `docs/runbooks/tax-nexus-threshold-watch.md` | 2026-09 |
| T2 | Marketplace facilitator: are we the facilitator of record in each state, what is the admissions treatment, who remits? No code remits tax today. | Tax compliance; the held tax pot. | Collect and hold. | `docs/records/2026-07-08-merchant-of-record-legal-review.md`; `docs/runbooks/tax-nexus-threshold-watch.md` | 2026-07-08 |
| T3 | Nexus thresholds measured on gross or net sales? The spec contradicts itself. | Threshold watch. | Net. | `docs/runbooks/tax-nexus-threshold-watch.md` | 2026-09-08 |
| T4 | Minneapolis 3% entertainment tax: is it inside the Minnesota sales tax base? Does it apply on resale? | MN tax work. | No tax on tax; not charged on resale (owner: "Assume not. We will seek counsel later."). | session plan `session_minneapolis_entertainment_tax` | 2026-10-05 |
| T5 | Jurisdictional tax base: Texas unconfirmed; Florida excludes a separately stated fee, right only while we itemise. | Tax base table. | As built. | memory `project_tax_base_is_jurisdictional` | 2026-09-22 |
| T6 | Is a buyer-paid resale share part of the taxable ticket price? | Resale share. | Taxed as part of the ticket price (owner: "we'll deal with that as we go"). | `docs/specs/2026-10-12/organiser-resale-share.spec.yaml` | 2026-10-12 |
| T7 | Tennessee sales-tax account: registered now that taxable sales started? Lower filing frequency? *Status unclear.* | TN filing. | Unknown. | memory `project_tn_registration_deferral` | 2026-07-11 |
| T8 | Terms wording on tax: the facilitator's remittance versus the organiser's income tax and 1099-K. | Terms. | Current text. | `docs/records/2026-07-08-merchant-of-record-legal-review.md` | 2026-07-08 |
| T9 | Tennessee franchise and excise return and annual report (spring 2027); Delaware franchise tax. | Company filings. | Calendar reminder only. | memory `project_tn_registration_deferral` | 2026-09-07 |

## Accounting

| # | Question | What depends on it | Default meanwhile | Source | Raised |
| --- | --- | --- | --- | --- | --- |
| A1 | Platform solvency: total owed is never computed or compared with the platform balance. Should held funds be treated as trust or segregated money? | Settlement; open books. | Not computed. | `docs/records/2026-09-06-money-mechanism.md` | 2026-09-06 |
| A2 | How to book losses the platform absorbs with no ledger entry: the fee refunded on every refund, dispute fees, carried debt, absorbed Stripe fees. | Books; open books. | Not booked. | `docs/records/2026-09-06-money-mechanism.md` | 2026-09-06 |
| A3 | Revenue recognition and breakage for gift balances. | Venue gift balance. | Not built. | `docs/specs/2026-05-29/venue-gift-balance.spec.md` | 2026-05-29 |
| A4 | Publishing what the company account spent: what an accountant needs to see first, and in what form. | Open books (owner ruling 2026-10-11). | No page built. | `docs/pro-social.md` | 2026-10-11 |

## Answered

| Question | Answer | Who, when |
| --- | --- | --- |
| L14: should Terms §12 and the privacy SMS text stay, or be cut while SMS is off? | Neither: rewritten to be accurate and to pass carrier review (optional opt-in, frequency, rates, STOP/HELP, no sharing of numbers or consent for marketing). See `docs/runbooks/sms-registration.md`. A lawyer review of the new wording is still welcome. | Owner, 2026-10-15 ("yes to changing"); text rewritten 2026-10-16 |
| Delaware LLC registered in Tennessee? | Foreign qualification done. | 2026-09-07 (memory `project_tn_registration_deferral`) |
| Do payees need a 1099 or W-9 from us? | Stripe issues the 1099-K; rentals and venue deals touch no tax form. | Specs `2026-08-26/completed/room-rental-payment-link`, `2026-05-25/completed/human-stripe-connect` |
| Re-accept chargeback terms after a revision? | Not needed. | Owner, 2026-09-04 |
