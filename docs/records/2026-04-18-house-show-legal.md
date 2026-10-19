# House Show Legal Compliance — Platform Field Guide

**Date:** 2026-04-18
**Disclaimer:** Legal research for informational purposes, not legal advice. Consult Tennessee-licensed counsel before launch.
**Source:** IRS Rev. Rul. 67-246, T.C.A. § 67-6-212, Metro Nashville Code, ConcertsInYourHome.org, case law, industry analysis

---

## Core Legal Distinction: Donation vs Ticket

A "suggested donation" protects against some regulators and not others:

| Regime | Does "donation" framing protect? | Notes |
|---|---|---|
| **Federal income tax (IRS)** | NO | Rev. Rul. 67-246: payment for event access = income under IRC § 61 regardless of label. Host is not 501(c)(3), so never deductible to payer. |
| **Tennessee amusement tax** | NO | T.C.A. § 67-6-212(a)(2) explicitly taxes "voluntary contributions" to places of amusement. 9.25% in Davidson County. |
| **Zoning** | YES | "Private gathering with suggested donation" vs "commercial entertainment venue." Herndon VA "Crib" case: ZBA overturned citation after pivoting from "tickets" to "donations." |
| **PRO licensing (ASCAP/BMI)** | YES | Truly private events (curated list, friends-of-friends) fall outside 17 U.S.C. § 101 "public performance" definition. No reported case of PRO suing a house concert host. |
| **Homeowner insurance** | YES | "Business pursuits" exclusion voids coverage for recurring paid events. Donation framing preserves "social gathering" classification. |

### The Critical Test

A fixed "$10 suggested donation" on a public ticketing page with RSVP enforcement = a ticket in substance.

A sliding scale, no-one-turned-away, invitation-only, cash-at-door = donation for zoning/PRO/insurance purposes (but still taxable income).

**Ithas Fire's approach:** Frame as "contribution" with genuine $0 option. Reveal location to ALL RSVPs regardless of payment. This removes the gate that converts a donation into a ticket.

## Zoning & Fire Code

- No US jurisdiction has a statutory safe harbor for house concerts
- Enforcement is complaint-driven (neighbors calling)
- Nashville Metro Code § 17.16.250.D: home-based businesses capped at 6 customer visits/day, 8am-7pm Mon-Sat, no Sunday
- **IBC Group A assembly classification triggers at 50 occupants** — residential structures (Group R-3) lack required sprinklers, exits, panic hardware
- **Ghost Ship fire (2016):** 36 killed, master tenant pled guilty to 36 counts involuntary manslaughter, Oakland settled $32.7M
- Post-Ghost Ship: Nashville's Drkmttr, Glass Menage, and other DIY spaces shut down by fire marshal
- **Ithas Fire default capacity: 40** (safely under IBC 50-person threshold)

## Nashville Specifics

- **Noise:** Metro Code § 9.20.010 — "plainly audible" standard, explicitly captures bass reverberation
- **Outdoor amplified music:** § 9.20.030 — within 50 feet of residence, 7am-11pm only, must be "totally enclosed"
- **Home business:** 6 customer visits/day max, no Sunday operations, sound must not leave premises
- **Amusement tax:** 9.25% applies to ALL admission charges AND voluntary contributions (T.C.A. § 67-6-212)
- **Shaw v. Metro Nashville (2019-2022):** Metro can shutter home businesses "servicing clients on-site"
- **Special Event Permits:** § 2.62.040, $330 application — applies to public property only, not private residential

## Alcohol — The Biggest Legal Trap

Charging admission converts a social host into an unlicensed commercial seller in several states:

- **Ennabe v. Manosa (Cal. 2014):** $3-$5 admission = "sale" of alcohol. Social-host immunity stripped.
- **Biscan v. Brown (Tenn. 2005):** Host civilly liable for knowingly permitting minors to drink, even without furnishing alcohol.
- **Tennessee dram shop (T.C.A. §§ 57-10-101 to -102):** Liability attaches to "sellers" only, but admission charge can reclassify host as seller.
- **BYOB at a genuinely private gathering:** Unregulated.
- **BYOB at a ticketed/advertised event:** Arguably an unlicensed sale.

**Ithas Fire approach:** No alcohol toggle on house shows. Default to "BYOB — no alcohol sold or provided by host." Never include alcohol in contribution flow.

## Insurance

- Standard HO-3 homeowner policies include **business pursuits exclusion** — recurring paid events void coverage
- ISO HO 2000 carve-back only covers businesses earning under $2,000/year
- Paying attendees are **"business invitees"** under Restatement § 332 — highest duty of care
- **Single-event liability insurance:** $66-$130/event (The Event Helper, Thimble, GatherGuard, Markel, K&K)
- $1M/$2M limits typical, host liquor liability included when alcohol served but not sold
- **Airbnb AirCover model:** $1M host liability + $3M damage protection, bundled free — the gold standard

**Ithas Fire approach (now):** Link to insurance providers in house show creation flow. Not bundled.
**Ithas Fire approach (future, at scale):** Negotiate bundled coverage like AirCover.

## Waivers

- Enforceable in ~47 states for ordinary negligence
- **NOT enforceable:** Louisiana, Virginia, Montana (categorically), and nowhere for gross negligence/intentional misconduct
- **Tennessee:** Copeland v. HealthSouth (2018) — totality-of-circumstances test, favorable for conspicuous recreational waivers
- **Must be clickwrap** (checkbox + affirmative assent), NOT browsewrap (Nguyen v. Barnes & Noble killed browsewrap)
- Parents cannot waive minors' claims (Hojnowski v. Vans Skate Park)
- Store timestamped screenshots of exact waiver text shown

**Ithas Fire approach:** WaiverTemplate + WaiverAcceptance models already built. Platform-provided default house show waiver. Checkbox at RSVP/checkout.

## PRO Licensing (ASCAP/BMI/SESAC/GMR)

- 17 U.S.C. § 106(4): copyright owners hold exclusive public performance right
- § 101: "public" = place open to public OR substantial number outside normal circle of family/social acquaintances
- § 110(4): nonprofit exemption — but only when performer receives NO fee (kills most house concerts)
- **Defense for house concerts:** truly private events are outside § 101 "public" definition entirely
- **No reported case of PRO suing a house concert host**
- Three factors that make a house concert "public": public promotion, sale to strangers, livestream/recording
- Cover songs materially increase risk; original compositions by non-PRO artists eliminate it

**Ithas Fire approach:** Private events default to invite-only (not public discovery). Future: PRO licensing flow for events with cover songs.

## Platform Liability (Section 230)

- 47 U.S.C. § 230 protects publisher functions (hosting listings, reviews)
- **HomeAway v. Santa Monica (9th Cir. 2019):** Section 230 does NOT shield booking-transaction conduct from regulation
- **Implications for Ithas Fire:**
  - Protected: user-generated venue reviews, event listings
  - NOT protected: failure to vet/warn, marketplace-facilitator tax obligations, negligence claims from real-world injury at facilitated events
- Position as "technology platform and ticketing agent" not event operator (avoid Sofar trap)

## Sofar Sounds Precedent — What NOT to Do

- $460,357.50 NYSDOL settlement (Jan 2020): 654 "ambassadors" were employees, not volunteers
- Corrales v. Sofar (S.D.N.Y. 2024): hidden $2 checkout fee violated NY all-in pricing law
- Lesson: never use unpaid platform-branded labor, always show all-in pricing

**Ithas Fire volunteer system is safe:** volunteers work for the organizer (EventVolunteerRole → Event → Organization), not the platform. Schema enforces this architecturally.

## Product Requirements Summary

### Build Now (P0-P1)
1. **Private event toggle** — house shows default invite-link-only, never in public discovery
2. **Contribution framing** — "contribution" not "ticket," sliding scale, genuine $0 option
3. **Location revealed to ALL RSVPs** regardless of payment
4. **Soft capacity cap** — default 40, tooltip about fire code at 50
5. **No alcohol toggle** — BYOB disclaimer, no alcohol in contribution flow
6. **Host attestation checkboxes** at event creation (legal right, noise, alcohol, taxes, FAQ)
7. **Clickwrap waiver at RSVP** — platform-provided default for house shows
8. **House show legal FAQ page** — educational content, not legal advice
9. **Insurance recommendation links** — The Event Helper, Thimble, GatherGuard

### Build Later (P2+)
- Bundled insurance product (needs underwriter + volume)
- Marketplace facilitator tax remittance (TN amusement tax)
- PRO licensing flow for cover songs
- State-specific legal FAQ variations

### Never Build
- Alcohol sales/management
- Venue licensing verification for residential events
- Platform-branded volunteer roles ("Ithas Fire Ambassador" = Sofar trap)

## Key Cases to Know

| Case | Holding | Relevance |
|---|---|---|
| Ghost Ship (2016) | 36 killed, involuntary manslaughter, $32.7M civil | Criminal exposure for unlicensed assembly |
| Ennabe v. Manosa (Cal. 2014) | Admission charge = alcohol "sale" | Dram shop liability for paid house parties |
| Biscan v. Brown (Tenn. 2005) | Host liable for permitting minors to drink | Tennessee alcohol liability |
| HomeAway v. Santa Monica (9th Cir. 2019) | § 230 doesn't shield booking conduct | Platform liability for transactions |
| Copeland v. HealthSouth (Tenn. 2018) | Totality test for waiver enforceability | Waivers work in TN if conspicuous |
| Sofar NYSDOL (2020) | Unpaid ambassadors = employees | Don't use free platform labor |
| Corrales v. Sofar (2024) | Hidden checkout fees illegal under NY law | All-in pricing required |
| Shaw v. Metro Nashville (2019-2022) | Metro can shutter home businesses | Nashville zoning enforcement |
