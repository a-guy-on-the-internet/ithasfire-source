# Waiver Clause Library

**Date:** 2026-04-19 (updated from research)
**Status:** complete
**Priority:** P2 (Competitive differentiator)
**Depends on:** `WaiverTemplate` model (`packages/db/prisma/waiver.prisma`), `WaiverAcceptance` model, event creation flow
**Research:** `docs/records/2026-04-18-house-show-legal.md`, deep research on waiver enforceability (2026-04-19)

---

## Problem

Organizers need event-specific waivers but aren't lawyers. The current system gives them a blank text field or a single platform default. This means waivers are either too generic to hold up in court (a vague "I assume all risks" gets challenged under Tennessee's Copeland test for lack of specificity) or they're skipped entirely. No competing platform offers a dynamic waiver builder — Eventbrite has no waiver system, DICE doesn't offer organizer-facing waivers, Posh doesn't, Ticket Tailor doesn't.

---

## Goal

Build a clause library where Ithas Fire maintains legally-grounded risk paragraphs. Organizers toggle applicable risks on/off. The waiver assembles itself. The attendee sees one checkbox at RSVP. The database stores the exact assembled text, version, and hash. Nobody writes legal language. Nobody skips the waiver because it's too hard.

---

## Legal Framework

Tennessee waivers are governed by **Copeland v. HealthSouth, 565 S.W.3d 260 (Tenn. 2018)**. Three factors:

1. **Relative bargaining power** — voluntary recreational events between equal parties favor enforceability
2. **Clarity of exculpatory language** — must be "clear, unambiguous, and unmistakable about what the party is giving up"
3. **Public policy** — recreational waivers generally enforceable; essential services (medical, utilities) are not

Tennessee is one of the most waiver-friendly states. Key rules from research:

- **"Negligence" is not a magic word in TN** — *Empress Health & Beauty Spa v. Turner*, 503 S.W.2d 188 (Tenn. 1973) held it doesn't need to appear. But some states (California, Texas) require it. **Use it anyway for multistate safety.**
- **Gross negligence carve-out is mandatory** — *Adams v. Roark*, 686 S.W.2d 73 (Tenn. 1985). An overbroad clause that attempts to waive gross negligence can void the ENTIRE waiver (see Wisconsin *Atkins v. Swimwest*, 2005 WI 4).
- **Express assumption of risk survives as complete bar** — *Perez v. McConkey*, 872 S.W.2d 897 (Tenn. 1994) abolished implied assumption of risk but preserved express.
- **Parents cannot waive minor's tort claims** — *Childress v. Madison County*, 777 S.W.2d 1 (Tenn. Ct. App. 1989), reaffirmed by *Blackwell v. Sky High Sports Nashville*, 523 S.W.3d 624 (Tenn. Ct. App. 2017).
- **Clickwrap required** — *Nguyen v. Barnes & Noble*, 763 F.3d 1171 (9th Cir. 2014) killed browsewrap. *Meyer v. Uber*, 868 F.3d 66 (2d Cir. 2017) upheld sign-in-wrap. For personal injury waivers, use hybrid scrollwrap + clickwrap (dedicated step, unchecked checkbox, full text viewable).
- **Terminology stack** — Use "release, waive, discharge, and covenant not to sue" together. "Hold harmless" and "indemnify" are synonymous in TN (*Long v. McAllister-Long*, 221 S.W.3d 1 (Tenn. Ct. App. 2006)) and shift third-party claim costs.

---

## Critical Architecture Principle: Three-Layer Assembly

Research revealed that modular waivers must be **opinionated, not open-ended.** Three layers:

### Layer 1: Structural (mandatory, non-toggleable, invisible to organizer)
These clauses appear in every assembled waiver. The organizer cannot remove them. They are the bones that make the document legally valid.

1. **Released Parties definition block** — defines who is protected once, referenced by all clauses
2. **Core release of liability** — with explicit gross-negligence carve-out
3. **Core assumption of risk** — express, voluntary, with "including but not limited to" catch-all
4. **Gross-negligence carve-out footer** — universal override at bottom of every waiver
5. **Severability** — with express reformation direction
6. **Governing law** — auto-detected from event location

### Layer 2: Risk-specific (toggleable, auto-selected based on event settings)
Organizer sees these as checkboxes grouped by category. Auto-selected based on event properties. Can be toggled on/off.

### Layer 3: Custom (optional, organizer-written)
One freeform clause, max 500 characters, appended after library clauses but before the structural footer.

**Assembly order:** Definitions → Release → Assumption of Risk → Risk-specific clauses (sorted) → Custom clause → Footer (gross-negligence carve-out + severability + governing law)

---

## Data Model

### New Model: `WaiverClause`

```prisma
model WaiverClause {
  id           String   @id @default(uuid())
  slug         String   @unique
  title        String
  body         String   @db.Text
  category     WaiverClauseCategory
  layer        WaiverClauseLayer      // STRUCTURAL, RISK_SPECIFIC, or CUSTOM
  isRequired   Boolean  @default(false)
  isDefault    Boolean  @default(false)
  sortOrder    Int      @default(0)
  version      Int      @default(1)
  active       Boolean  @default(true)
  
  // Jurisdiction restrictions
  voidInStates    String[]  @default([])  // States where this clause is void (e.g., ["LA", "VA"])
  requiredInStates String[] @default([])  // States where this clause must be injected (e.g., ["MT"])
  
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  autoSelectRules WaiverClauseAutoRule[]

  @@index([category, active, sortOrder])
  @@index([layer, active])
}

model WaiverClauseAutoRule {
  id           String   @id @default(uuid())
  clauseId     String
  field        String
  operator     String   // "eq", "in", "exists"
  value        String
  createdAt    DateTime @default(now())

  clause       WaiverClause @relation(fields: [clauseId], references: [id], onDelete: Cascade)

  @@index([clauseId])
}
```

### New Enums

```prisma
enum WaiverClauseCategory {
  STRUCTURAL  // Non-toggleable foundation clauses
  VENUE       // Property type, premises risks
  ACTIVITY    // What happens at the event
  SUBSTANCE   // Alcohol, smoke, etc.
  LEGAL       // Governing law, severability (structural but categorized for DB)
  GENERAL     // Medical, photo/media, minors
}

enum WaiverClauseLayer {
  STRUCTURAL    // Always included, not toggleable
  RISK_SPECIFIC // Toggleable by organizer
}

enum WaiverTemplateSource {
  FREEFORM     // Organizer wrote manually (legacy)
  ASSEMBLED    // Built from clause library
  PLATFORM     // Platform-provided default
}
```

### Changes to `WaiverTemplate`

Add fields:

```prisma
  assembledFromClauses  Json?    // [{ clauseId, clauseVersion }]
  source                WaiverTemplateSource  @default(FREEFORM)
  jurisdictionState     String?  // US state code, drives clause selection
```

---

## Clause Library — Seed Data

### STRUCTURAL CLAUSES (Layer 1 — always included, never toggleable)

#### `released-parties-definition` [STRUCTURAL, REQUIRED]

> **DEFINITIONS.** As used in this Waiver, "**Released Parties**" means the event organizer(s), the property owner(s), and their respective parents, subsidiaries, affiliates, successors and assigns, and each of their respective officers, directors, employees, agents, volunteers, members, sponsors, independent contractors, vendors, insurers, and property and premises lessors. "**Event**" means [Event Name] occurring on [Event Date] at [Event Location].

#### `core-release` [STRUCTURAL, REQUIRED]

> **RELEASE AND WAIVER OF LIABILITY.** In consideration of being permitted to attend or participate in the Event, I, for myself, my heirs, next of kin, spouse, personal representatives, assigns, and estate, to the fullest extent permitted by law, HEREBY RELEASE, WAIVE, DISCHARGE, AND COVENANT NOT TO SUE the Released Parties from any and all claims, demands, causes of action, or liabilities of any kind, including those arising from the ordinary negligence of any of the Released Parties, for any personal injury, illness, death, property loss, or other damages arising out of my attendance at or participation in the Event.

Void-in-states: `["LA", "VA"]` — in those states, this clause is replaced with an acknowledgment-of-risk alternative (see Jurisdiction Gating below).

#### `core-assumption-of-risk` [STRUCTURAL, REQUIRED]

> **VOLUNTARY ASSUMPTION OF RISK.** I acknowledge that attending this Event involves inherent risks that may result in personal injury, illness, death, or property damage. These risks include but are not limited to: the actions and conduct of other attendees, performers, vendors, and staff; environmental conditions; equipment failure; and hazards of the venue. I understand these risks and voluntarily assume full responsibility for any injuries, damages, or losses that may occur as a result of my attendance, whether or not caused by the ordinary negligence of the Released Parties.

#### `gross-negligence-footer` [STRUCTURAL, REQUIRED]

> **SCOPE AND LIMITATIONS.** This Waiver applies only to claims arising from ordinary negligence. Nothing in this Waiver releases, waives, or limits liability for gross negligence, recklessness, willful or wanton misconduct, intentional wrongdoing, fraud, or any statutory violation that cannot be waived under applicable law.

#### `severability-reformation` [STRUCTURAL, REQUIRED]

> **SEVERABILITY.** If any provision of this Waiver is found to be unenforceable, invalid, or void under applicable law, that provision shall be modified, narrowed, and blue-penciled to the minimum extent necessary to make it valid and enforceable. The remaining provisions shall continue in full force and effect. The parties intend that the ordinary-negligence release and assumption of risk constitute the minimum enforceable protection of this Waiver.

#### `governing-law-tn` [STRUCTURAL, auto-selected for Tennessee events]

> **GOVERNING LAW AND VENUE.** This Waiver shall be governed by and construed in accordance with the laws of the State of Tennessee. Any disputes arising from this Waiver or my attendance at the Event shall be resolved exclusively in the state or federal courts located in Davidson County, Tennessee.

Other state variants added as Ithas Fire expands.

#### `platform-disclaimer-footer` [STRUCTURAL, REQUIRED]

> This document was assembled by [Organizer Name] using the Ithas Fire platform. Ithas Fire, Inc. is a software provider and did not draft this specific document. Ithas Fire does not provide legal advice and makes no representation regarding the enforceability of this Waiver in any jurisdiction. Use of the Ithas Fire waiver tool does not create an attorney-client relationship. Organizers are responsible for ensuring compliance with applicable laws in their jurisdiction.

---

### RISK-SPECIFIC CLAUSES (Layer 2 — toggleable)

#### `private-residential` — Private Residential Property [VENUE]

> **PRIVATE RESIDENTIAL PROPERTY.** I understand that this Event takes place at a private residential property that is not a licensed commercial venue. The property has not been inspected or approved for public assembly by any government authority. I accept the property in its current condition, including any hazards related to: stairs, porches, and decks without code-compliant handrails; uneven floors and thresholds; limited or residential-only lighting; residential electrical systems; absence of commercial fire suppression, sprinklers, or fire alarms; limited egress points and exits; household pets; and general conditions of a private home not designed for public gatherings.

Auto-select: `locationMode eq HIDDEN` OR `visibility eq PRIVATE`

#### `outdoor-event` — Outdoor Event Risks [VENUE]

> **OUTDOOR EVENT.** I understand that this Event takes place partially or entirely outdoors. I accept the risks associated with outdoor conditions, including but not limited to: uneven, unpaved, or natural terrain; exposure to weather including heat, cold, rain, wind, lightning, and sun; insects, ticks, and wildlife; limited or no shelter; natural obstacles; and reduced visibility after dark. I am responsible for wearing appropriate clothing and footwear, monitoring weather conditions, and removing myself from unsafe conditions.

#### `non-traditional-venue` — Non-Traditional Venue [VENUE]

> **NON-TRADITIONAL VENUE.** I understand that this Event takes place at a non-traditional venue that may not meet the standards of a licensed commercial event space. The venue may have limited accessibility, non-standard restroom facilities, absence of ADA-compliant features, non-commercial electrical and plumbing systems, and conditions that differ from a professional event environment. I accept these conditions and assume the associated risks.

#### `amplified-sound` — Amplified Sound and Hearing Risk [ACTIVITY]

> **AMPLIFIED SOUND.** I understand that this Event involves amplified sound, live music, or recorded music at sound-pressure levels that routinely exceed 85 decibels at live-music events and may cause temporary or permanent hearing damage, tinnitus, or other auditory injury. I am solely responsible for protecting my own hearing, including the use of earplugs or other hearing protection devices. The Released Parties recommend but do not require the use of hearing protection.

Auto-select: Event category in `["music", "comedy", "dj"]`

#### `physical-activity` — Physical Activity [ACTIVITY]

> **PHYSICAL ACTIVITY.** I understand that this Event involves physical activity, which may include but is not limited to: dancing, standing for extended periods, movement in crowded or confined spaces, participation in interactive or immersive performances, and navigating stairs or uneven surfaces. I accept the risk of physical exertion, fatigue, contact with other attendees, slips, trips, and falls.

#### `fire-pyrotechnics` — Fire, Candles, or Pyrotechnic Elements [ACTIVITY]

> **FIRE AND PYROTECHNICS.** I understand that this Event may involve open flames, candles, fire performance, fireworks, sparklers, or other pyrotechnic elements. I accept the risks of burns, smoke inhalation, sparks, and fire-related injury. I will maintain a safe distance from all fire elements, follow all safety instructions provided by the organizer and any certified pyrotechnic operators, and immediately comply with any evacuation instruction.

#### `crowding` — Crowded Conditions [ACTIVITY]

> **CROWDED CONDITIONS.** I understand that this Event may involve crowded conditions with limited personal space. I accept the risks associated with close proximity to other attendees, including but not limited to: physical contact, compression, limited mobility, difficulty exiting, elevated temperatures, and crowd movement or surges. I will immediately comply with any evacuation, shelter, or move-back instruction from event staff.

#### `byob-alcohol` — Alcohol Present (BYOB) [SUBSTANCE]

> **ALCOHOL.** I understand that alcoholic beverages may be present at this Event on a bring-your-own basis. No alcohol is sold, served, or provided by the event organizer or the Released Parties. I accept full responsibility for my own alcohol consumption and resulting behavior. I represent that I am at least 21 years of age if I choose to consume alcohol. I will not provide alcohol to any person under the legal drinking age. I will arrange safe transportation from the Event if I consume alcohol and will not operate a motor vehicle while impaired. I agree to indemnify and hold harmless the Released Parties from any claim, demand, or liability arising from my alcohol consumption or from my providing alcohol to any other person at the Event.

Auto-select: Event has BYOB toggle enabled

#### `smoke-fog` — Smoke or Fog Effects [SUBSTANCE]

> **SMOKE AND FOG.** I understand that this Event may involve theatrical smoke, fog machines, haze, incense, or similar atmospheric effects. These may aggravate respiratory conditions including asthma and COPD. I accept this risk and will remove myself from the affected area if I experience discomfort or respiratory difficulty.

#### `medical-acknowledgment` — Medical Acknowledgment [GENERAL]

> **MEDICAL.** I certify that I am physically able to attend this Event and have not been advised against participation by a medical professional. I agree to be financially responsible for any medical costs incurred as a result of injury or illness during the Event. If I am unable to provide consent at the time of need, I authorize the Released Parties to summon emergency medical services on my behalf. The Released Parties may but are not obligated to provide first-aid personnel or equipment at the Event. The presence of any medical personnel does not guarantee any particular standard or speed of response. Attendees remain responsible for their own medical decisions.

Note: Tennessee Good Samaritan Law (T.C.A. § 63-6-218) protects good-faith emergency aid at events with or without admission charges. This clause is drafted to avoid creating a voluntary-undertaking duty per Restatement § 324A — uses "may but is not obligated to" language deliberately.

#### `photo-media` — Photo and Media Release [GENERAL]

> **PHOTO AND MEDIA.** I consent to being photographed, filmed, or recorded (including audio and video capture of my voice and likeness) during this Event. I grant the event organizer a non-exclusive, royalty-free, perpetual right to use my likeness and voice in event documentation, promotion, and social media, excluding AI-generated synthetic reproductions of my likeness or voice. I understand I may decline by notifying the organizer in writing before the Event begins, and that "photo-free" accommodations may be available upon request.

Note: Tennessee ELVIS Act (Tenn. Pub. Ch. 588, eff. July 1, 2024) adds "voice" to statutory right of publicity and creates secondary liability for AI deepfakes. This clause explicitly covers voice and excludes AI synthetic use.

#### `minor-notice` — Notice Regarding Minors [GENERAL]

> **MINORS.** This Waiver applies to adult attendees age 18 and older. If I am the parent or legal guardian of a minor attending this Event, I acknowledge that I am responsible for their safety and supervision throughout the Event. I understand that under the laws of Tennessee and most US states, a parent or guardian cannot waive a minor child's right to pursue legal claims for personal injury. This Waiver does not purport to waive any such claims on behalf of any minor. I personally assume the risks described herein with respect to my own attendance, and I agree to indemnify the Released Parties for claims arising from my minor child's conduct that causes injury or damage to third parties.

Note: *Childress v. Madison County* (Tenn. 1989) and *Blackwell v. Sky High Sports Nashville* (Tenn. 2017) — parental pre-injury waivers of minor's claims unenforceable in TN. This clause is drafted to acknowledge that limit rather than attempt to circumvent it.

---

## Jurisdiction Gating

### Tier 1 — Waiver categorically void (degrade to acknowledgment-of-risk only)

**Louisiana** (La. Civ. Code art. 2004) and **Virginia** (*Johnson's Adm'x v. R&D R.R.*, 86 Va. 975 (1890)):

- Strip the `core-release` clause entirely
- Replace with acknowledgment-only language: "I acknowledge the risks described herein. I understand that this document serves as an acknowledgment of risk and does not constitute a waiver of my legal rights under [State] law."
- Show organizer warning: "Liability waivers for personal injury are categorically unenforceable in [State]. This document will serve as an acknowledgment of risk only. We strongly recommend purchasing event liability insurance."

### Tier 2 — Waiver restricted for paid recreational events

**New York** (GOL § 5-326): Void for fee-charging amusement/recreational facilities. Show warning: "New York law restricts waiver enforceability for paid recreational events. Your waiver may not be enforceable. Consult a New York attorney."

**Connecticut** (*Hanks v. Powder Ridge*, 2005): Near-categorical void for recreation. Same warning pattern.

**Vermont** (*Dalury v. S-K-I*, 1995), **Oregon** (*Bagley v. Mt. Bachelor*, 2014): Void for broad-public recreation. Same warning pattern.

### Tier 3 — Waiver requires mandatory state-specific insert

**Montana** (Mont. Code Ann. § 27-1-753): Must include specific bold-type statutory warning about inherent risks of recreational activities. Auto-inject when event state is MT.

### Tier 4 — Waiver has special rules but is generally enforceable

**Wisconsin** (*Atkins v. Swimwest*, 2005 WI 4): Overbroad or dual-purpose documents voided entirely. Ensure standalone waiver document, avoid combining with registration terms.

**Hawaii** (*Courbat v. Dahana Ranch*, 2006): Must disclose waiver requirement at registration, not at check-in/door.

**Washington**, **West Virginia**: Workable with strict drafting but heightened scrutiny.

### Implementation

```typescript
// Jurisdiction detection at event creation/publish
function getJurisdictionTier(stateCode: string): JurisdictionTier {
  const VOID_STATES = ['LA', 'VA'];
  const RESTRICTED_RECREATION = ['NY', 'CT', 'VT', 'OR'];
  const MANDATORY_INSERT = ['MT'];
  const SPECIAL_RULES = ['WI', 'HI', 'WA', 'WV'];
  
  if (VOID_STATES.includes(stateCode)) return 'VOID';
  if (RESTRICTED_RECREATION.includes(stateCode)) return 'RESTRICTED';
  if (MANDATORY_INSERT.includes(stateCode)) return 'MANDATORY_INSERT';
  if (SPECIAL_RULES.includes(stateCode)) return 'SPECIAL';
  return 'STANDARD'; // Full waiver enforceable
}
```

---

## Assembly Logic

1. Detect event state → determine jurisdiction tier
2. If VOID tier: assemble acknowledgment-of-risk document (no release language), show organizer warning
3. If STANDARD/SPECIAL/RESTRICTED: assemble full waiver
4. Auto-select Layer 1 structural clauses (all required, non-toggleable)
5. Auto-select Layer 2 risk clauses based on `WaiverClauseAutoRule` matches
6. Show organizer the toggleable clauses grouped by category
7. Organizer toggles optional clauses on/off, adds optional custom clause
8. Assemble in order: Definitions → Release → Assumption of Risk → Risk clauses (sorted) → Custom → Footer (gross-negligence carve-out + severability + governing law + platform disclaimer)
9. If MANDATORY_INSERT tier: inject state-specific statutory language at required position
10. Hash assembled body (SHA-256), assign version, store as WaiverTemplate with `source: ASSEMBLED`

---

## UI

### Event Builder — Waiver Section

Collapsed by default under "The boring but important stuff."

**Organizer sees:**
- Jurisdiction notice (if applicable): "[State] restricts waiver enforceability. [Details]"
- Risk clause toggles grouped by category (required structural clauses NOT shown as toggles — they're invisible infrastructure)
- Preview button → shows full assembled waiver in modal
- Custom clause text field (optional, 500 char max)

**Organizer does NOT see:**
- The structural clauses (Released Parties definition, core release, assumption of risk, gross-negligence footer, severability, governing law, platform disclaimer)
- These are always included and never toggleable
- The preview shows them, but the organizer can't remove them

### RSVP / Checkout — Attendee View

Dedicated step in checkout flow (not buried in ToS):

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ [Scrollable waiver text - full assembled document]      │   │
│  │                                                         │   │
│  │ ...                                                     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  [ ] I have read and agree to the Event Liability Waiver        │
│      & Release, including the assumption of risk and            │
│      release of liability.                                      │
│                                                                 │
│  [Complete RSVP]  ← disabled until checkbox checked             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

- Checkbox must be **unchecked by default** (no pre-checked boxes — violates CCPA dark-pattern rules and GDPR Art. 4(11))
- "Complete RSVP" / "Complete Purchase" button disabled until checked
- One-line summary on event page before checkout: "This is a private gathering at a residential property. A waiver is required to attend."

### What Gets Logged (per WaiverAcceptance)

All existing fields plus ensure:
- `waiverBodyHash`: SHA-256 of exact HTML rendered to attendee
- `waiverVersion`: version number of assembled template
- `ipAddress`: attendee IP at time of acceptance
- `acceptedAt`: UTC timestamp with millisecond precision
- `userAgent`: browser user-agent string (add to schema if not present)

Retain for: **6 years** (TN contract statute of limitations, T.C.A. § 28-3-109). For minor attendees: retain until age of majority (18) plus limitations period.

---

## Platform Liability Protection

### UPL (Unauthorized Practice of Law) Defense

Ithas Fire provides **informational templates and software tools**, not legal advice. This is the "self-help" end of the spectrum per *Dacey v. N.Y. County Lawyers' Ass'n* (1967). To stay on the right side:

- Never answer case-specific legal questions from organizers
- Never state that assembled waivers are "legally compliant" or "court-tested"
- Market as "informational templates" not "legal documents"
- Annual Tennessee attorney review of clause library ($1-2K)
- Future: optional paid attorney-review tier (like Rocket Lawyer's RLPS model)

### Platform Disclaimer (in ToS)

- Ithas Fire is not a law firm
- No attorney-client relationship created
- Waiver templates provided as-is, no warranty of enforceability
- Organizer is the drafter for contra proferentem purposes
- Organizer responsible for jurisdiction-specific compliance
- Ithas Fire liability capped at $100 (following DICE model)
- Organizer indemnifies Ithas Fire for claims arising from waiver inadequacy

### Comparable Competitor Disclaimers (validated by research)

- **Smartwaiver:** "MAKES NO REPRESENTATIONS THAT THE SERVICE IS APPROPRIATE, ENFORCEABLE OR AVAILABLE FOR USE IN YOUR JURISDICTION"
- **WaiverForever:** "not a provider of legal services or legal advice"
- **Jotform:** "not providing legal, financial, or other advice"
- **DocuSign:** "neither Docusign nor Docusign eSignature is providing Customer with legal advice"

---

## Acceptance Criteria

### MVP (P2 — ship within 90 days)

- [ ] `WaiverClause` model with `layer` field (STRUCTURAL vs RISK_SPECIFIC)
- [ ] `WaiverClauseAutoRule` model
- [ ] New enums: `WaiverClauseCategory`, `WaiverClauseLayer`, `WaiverTemplateSource`
- [ ] `WaiverTemplate` gains `assembledFromClauses`, `source`, `jurisdictionState`
- [ ] Seed data: 6 structural clauses + 12 risk-specific clauses (18 total)
- [ ] Structural clauses always included, not shown as toggles
- [ ] Risk clauses shown as toggles grouped by category
- [ ] Auto-select rules fire based on event properties
- [ ] Custom clause field (500 char max)
- [ ] Preview modal shows full assembled text
- [ ] Governing law clause: Tennessee only (add states later)
- [ ] SHA-256 hash + version stored per WaiverAcceptance
- [ ] Clickwrap: unchecked checkbox on dedicated checkout step
- [ ] Platform disclaimer footer on every assembled waiver
- [ ] `userAgent` field added to WaiverAcceptance if not present
- [ ] Jurisdiction warning for LA and VA events (degrade to acknowledgment)

### Post-MVP (P3)

- [ ] Full 11-state jurisdiction gating with tier system
- [ ] Montana statutory language auto-injection
- [ ] New York GOL § 5-326 detection for paid recreational events
- [ ] Per-state governing law clause variants
- [ ] Wisconsin standalone-document enforcement
- [ ] Hawaii registration-time disclosure requirement
- [ ] Clause versioning notifications to organizers
- [ ] Optional paid attorney-review tier
- [ ] International: GDPR consent for photo/media clause
- [ ] International: BIPA compliance for Illinois events with photo clause

---

## Open Questions

- **Attorney review timing:** $1-2K for Tennessee attorney to review all 18 clauses. Do this before first paid event with waivers, not before development starts. Development can proceed with draft language.

- **Organizer freeform override:** Organizers can switch to `source: FREEFORM` and paste their own waiver. Clause builder is recommended, not mandatory. Show warning: "Custom waivers bypass Ithas Fire's clause library. We recommend consulting an attorney."

- **Multiple waivers per event:** Current schema: one per event via `Event.waiverTemplateId`. Performers use `Agreement` model separately. MVP: one waiver per event.

- **Waiver for free events:** Should free events (no payment, no Stripe) still show a waiver? Yes for house shows and private events. The waiver checkbox appears at RSVP regardless of payment.

- **Retention of assembled HTML:** Should we store the exact HTML rendered (not just the hash)? Yes — the hash proves integrity, but a court may want to see exactly what the attendee saw. Store rendered HTML alongside hash in WaiverAcceptance or a linked record.
