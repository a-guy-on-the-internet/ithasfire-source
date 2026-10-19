# Chargeback terms — brief for counsel

**Date:** 2026-09-02
**Status:** open — needs a redline before real-money launch
**Document under review:** `packages/core/src/lib/payments/chargeback-terms.ts` (`CURRENT_CHARGEBACK_TERMS_TEXT`, version `2026-05-17`), presented and accepted at Stripe Connect setup on `/admin/{slug}/payments`.
**Companion:** `docs/records/2026-07-08-merchant-of-record-legal-review.md` (ToS §3/§4/§6/§10 under the merchant-of-record posture).

## What the document does

Ithas Fire is the merchant of record. Buyer charges land on the platform's Stripe account; when a cardholder disputes a charge the card network debits Ithas Fire, not the organiser. Nothing in Stripe's Connected Account Agreement makes the organiser liable to Ithas Fire for that loss — the organiser's obligation exists only because this document creates it.

The terms therefore create three obligations that need affirmative assent:

1. **Repayment** of lost disputes.
2. **Setoff** — Ithas Fire may withhold or reduce future payouts to recover.
3. **Cross-account recovery** — outstanding balances may be applied across organisations and personal accounts the organiser owns or controls, and the organiser agrees not to use a new entity to evade debt.

## How assent is captured (as shipped)

- Presented in full, in a scrollable region, with a checkbox ("I understand and accept the chargeback and payout-hold terms.") and an explicit **Accept terms** action. Stripe setup cannot start until accepted.
- Recorded per natural person, not per organisation: `AcceptanceRecord` stores the human who clicked, the organisation scope, the verbatim text shown, version, timestamp, IP and user agent. Only an OWNER or ADMIN of the organisation can accept on its behalf.
- Accepting an already-accepted current version is a no-op — the original timestamp is never overwritten.
- Publishing a paid event and paid checkout require that *some* version was accepted; only Stripe setup requires the *current* version. A fully onboarded organiser is never re-prompted. **Consequence:** a substantive change to these terms will not re-bind existing organisers by itself; a re-acceptance sweep would be needed.

## What the code actually does — check the text against it

| Clause (paraphrased) | Code behaviour | Match? |
| --- | --- | --- |
| Disputed portion of payout may be held while under review | Hold placed on open, capped at what the organiser still holds from that order | Yes |
| Lost amount **and any related processor fees** recovered from future payouts | Lost amount: yes, from future payouts, never from the bank account. **Processor (dispute) fee: NOT recovered on ticket sales** — platform absorbs it. It *is* recovered on membership subscriptions. | **No — text overstates on ticketing** |
| Recovery capped at what was credited for the order; already-refunded orders → nothing further | Yes — enforced | Yes (text silent; consider stating it, it's organiser-favourable) |
| If debt exceeds pending payouts, future payouts may be skipped/reduced | Yes — negative balance carries forward, no payout until cleared | Yes |
| Suspension for risk review; notice within 24h; 14-day cure; 10-business-day response | **Not implemented as stated.** Ops notification exists (Discord); no organiser-facing notice with those timings, no cure-window mechanism. Numbers were placeholders. | **No — set numbers ops can meet, or remove** |
| No automatic rolling reserve at launch; manual reserve only after written notice | Membership payouts carry a *seasoning reserve* (10% → 5% → 0 over 180 days, restart on a lost membership chargeback) that is automatic and disclosed in the Help Center, not in these terms | **Partial — membership reserve should be disclosed here or cross-referenced** |
| Cross-account recovery / anti-circumvention | **Not implemented.** Recovery is per payee ledger; nothing applies one account's debt to another. | Text promises more than code does (defensible to keep for future, but say so) |
| Governing law / venue inherited from ToS | ToS placeholders still open per the July memo | Open |

## Questions for counsel

1. Is "risk owner" (organisation or human who published the event, plus affiliated entities they own or control) adequately defined, and is the anti-circumvention clause enforceable against a sole trader who opens a second personal account?
2. Given the fee sentence is wrong for ticketing: correct the text (organiser-favourable, safest), or keep the reservation of rights and add "we currently absorb this on ticket sales"?
3. Do the notice/cure timings need to exist at all, or can they be replaced with "we will notify you at the contact email on your account before withholding beyond a single dispute's amount"?
4. Because acceptance is per human on behalf of an organisation: is a later-joining ADMIN bound without personally accepting? (Current design: the organisation is bound by its first accepting admin; new admins are not re-prompted.)
5. Does the buyer-side ToS need a matching disclosure that disputes are handled by Ithas Fire as merchant of record, and that evidence submitted to the card network includes the buyer's name, email, IP, billing address and door-scan records? (It does today — see `assemble-dispute-evidence.ts`.)

## Things we will not change without counsel's view

- The version bump mechanics (a copy edit must not halt live sales; a substantive change needs a sweep).
- Fee treatment: platform-borne on ticketing, payee-borne on memberships.
- Recovery cap at credited amount.
