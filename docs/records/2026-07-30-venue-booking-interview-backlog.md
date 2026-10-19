# Drkmttr Booking Workflow — Observed Notes

**Source:** ONE room (Drkmttr), 2026-07-27. Observed Spencer (a booker) training an intern — not an interview, not a customer.
**Status:** raw synthesis — nothing spec'd, nothing decided, nothing validated.
**Weight this correctly:** N=1, and a **future** target rather than a current or prospective customer. Drkmttr is an Opendate room, so some of this is shaped by what they already have. Nothing here is demand evidence.

**Why the source is still good:** watching someone teach the job to a newcomer beats an interview — no interviewer to please, nothing being sold, and what a booker chooses to teach *is* the job. Treat it as a credible picture of **one room's workflow**, and as hypotheses to test elsewhere. Not as a roadmap.

---

## Headline read (hypothesis, not finding)

Payouts were asked about directly and got one sentence; the other ~44 notes are booking-calendar workflow — holds, calendars, request intake, event creation.

**Unresolved caveat:** bookers often aren't the settlement people. If Spencer doesn't run settlement, the one-line answer means "not my job," not "not hard," and this says nothing about payouts at all. That question was never answered, so **do not cite this as evidence that payout tooling doesn't matter.**

---

## A. Holds & confirmation — the most concretely described need

| Note | Read |
|---|---|
| "Bands need a confirmation/hold" | core ask |
| "A hold is selecting for / A challenge of a hold" | challenge mechanic |
| "Multiple bookers for a single date and time need a priority system for one slot and needs a confirmation" | stacking + priority |
| "Booking request a hold is made then a confirmation is needed to finalize" | request → hold → confirm |
| "Holds don't have a time specified yet" | holds are date-level, not time-level |
| "Once a confirmation happens the other holds get deleted" | confirm clears siblings |
| "Point of a hold is to give optionality for dates and determine who gets priority and is likely to confirm" | purpose, in their words |
| "Need ideas of confirmed and not confirmed dates" | calendar must distinguish |

**Cross-ref:** `docs/specs/2026-08-18/completed/venue-hierarchy-and-holds.spec.yaml` — holds are **already spec'd in detail and user-locked deferred** ("round 3"). Decided shape: a hold IS an Event in tentative status; stacking in venue-controlled order; artists never create or reorder holds.

**Gaps to check against that spec:** the *challenge* mechanic, and whether holds being date-level (no time) matches the tentative-Event shape.

**Decision:** un-defer? This is the strongest signal in the notes.

---

## B. Calendars, availability & categories

| Note | Read |
|---|---|
| "Different internal venues… one for social club? They just want different calendars for the same venue for different specific streams" | named Calendars per stream |
| "Different availability windows for specific categories" | availability scoped by category |
| "Different type of categories for social club events and venues" | category taxonomy |
| "My events/calendar" | personal calendar view |
| "Admin page needs to expand to full width on the calendar view" | UI bug, cheap |
| "Calendar view really needs to expand fully and on the same date" | same |

**Cross-ref:** venue-hierarchy plan (rooms + named Calendars) covers most of this. Full-width calendar is a standalone quick fix.

---

## C. Booking request intake

| Note | Read |
|---|---|
| "Booking policy and — need to support replying of files" | file attachments on thread |
| "Proposed order for ticket price, promo photos, attach this to booking request" | structured request payload |
| "Bands need a stage plot for audio layout setup and positioning" | stage plot upload |
| "Responses based on options" | templated responses |
| "Booking requests need arbitrary tags" | tagging |
| "Booking requests need to forward to an email" | email forwarding |
| "Booking request standards need to exist and a template needs to exist" | request template |
| "Touring date requests" | multi-date / routing request |
| "Challenging dates/booking requests need a clean interface on the platform" | UI for challenge |
| "There was a mixture of information for booking and being an artist to request" | current UX confusion |
| "Training an AI or just processes that make it easier to handle booking requests when you hate it" | **volunteered unprompted** — validates the Haiku triage idea |
| "Chrome extension for booking to link to the app to verify if it's available" | availability check outside the app |
| "When requesting, book 2-4 months out for a venue" | lead-time norm |
| "Drkmttr confirms at least a month in advance by the 15th" | confirmation cadence |

**Cross-ref:** booking-conversation-and-event-step spec (thread half, deferred).

---

## D. Event creation & media

| Note | Read |
|---|---|
| "Event creation when clicking a calendar day cell" | cell-create |
| "Our event creation likely needs more of a wizard" | flow redesign |
| "Gotta have simple image editing tools/crop posters. Posters are 2:1" | crop tool; 2:1 ratio |
| "Allow creation of arbitrary multiple dates for the singular event" | multi-date event |
| "Template start time" | event template defaults |
| "A template for events for notes on the event creation for the door" | door notes template |
| "Notes should have its own set of additional notes and templates with a basic title and text editor" | notes model |
| "Show details need info on load time. People need to know when there is an early load in" | load-in time field |
| "Adding an artist should link to Spotify and autofill" | Spotify enrichment |
| "Who creates the Event needs to be attached" | creator attribution |

**Cross-ref:** cell-create is in the venue-hierarchy spec. Spotify enrichment is built but unwired (`packages/core/src/use-cases/spotify/`). Poster focal-point crop is a known unbuilt item.

---

## E. Ticket types, pricing & fees

| Note | Read |
|---|---|
| "Support arbitrary fee. Drkmttr uses $2 additional to maintain fee" | venue-set per-ticket surcharge |
| "A specific fee can be tied to a particular organizer if possible" | per-organizer fee config |
| "Should show cost of a ticket vs cash and card on ticket type" | cash vs card price display |
| "Public on sale vs pre sale. We handle this via ticket types. However having it at the event level to fill in on ticket type is nice" | event-level onsale defaults |
| "Ticket type should have an end date of being able to be purchased" | sale end date |
| "Promo codes need to be event or org set" | promo scoping |

**Cross-ref:** `OrderItem.kind` already includes `"surcharge"` (`packages/core/src/lib/orders/order-item-kind.ts:18`) but it appears only in the kind enum, platform order listing, and a resale email branch — **no creation path**. Declared, not built.

**Caution:** platform fee is code-reconciled-on-deploy with the `/platform/fees` write path deleted. A venue-set arbitrary fee is a different mechanism from the platform fee — don't conflate them.

---

## F. Deal terms / payouts — the entire haul

> **"Door = Upfront cost 200 then 90% goes to artist."**

Fixed deduction off the top, then percentage of the remainder. Artist carries the downside.

- Not a guarantee (artist bears risk, not the venue)
- Not a four-wall rental
- This is **"percentage after expenses"** — the deal family deferred in `docs/specs/2026-07-27/completed/compounding-deal-terms-model.spec.md`
- Minimum viable shape is *one number off the top* plus percentages on the remainder — **not** an itemized expense ledger
- Not expressible today: `computeOrderSplits` applies percentages to the full basis with no off-the-top stage

**Still N=1.** Ask two or three more rooms whether $200-then-90% is Drkmttr-specific or the local norm.

---

## G. Tax & compliance

| Note | Read |
|---|---|
| "Collecting W9s at the day of the show" | current manual process |
| "Bands send W9. Is there a way to integrate that into the booking request? Is that something that's too much PPI to handle?" | their question, and it's the right one |
| "W8 are for international bands" | W-8BEN for non-US acts |

**Before designing intake, settle who the payer of record is.** If artists are paid via Stripe Connect, Stripe issues 1099s for connected accounts and we may never need to touch a W-9. If the venue pays the artist directly, it's the venue's W-9 and arguably shouldn't live in our database at all. W-9/W-8 carry SSN/EIN — high-sensitivity PII with real handling obligations.

---

## H. Auth, roles & permissions

| Note | Read |
|---|---|
| "OAUTH2 accounts shared. Easy onboarding" | shared account reality |
| "Need a booking permissions group/identity" | booking-scoped role |
| "Need the oauth2 setup streamlined" | onboarding friction |
| "Profile/user creation should assign a role upon creation" | role at creation |
| "We need to allow admins to create… user accounts?" | admin-provisioned accounts |

**Note:** "OAuth2 accounts shared" may mean venue staff share one login. If so, per-human attribution ("who created the Event needs to be attached") is unreliable until this is fixed — the two notes are connected.

---

## I. Notifications

- "Post and pre show email notifications"
- "Post event email notifications should be able to turn off"

**Cross-ref:** post-event prompts exist; there's a known deferred toggle question.

---

## J. Reviews, discovery & syndication

- "A review system for artists and venues definitely needs to exist" — two-sided reviews are partly built (blind-review rule already in the architecture constraints)
- "We will need to setup syndication of who is playing at locations. Integrates with bandcamp and spotify"
- "Do615 will advertise their tickets" — local listing partner
- "Pull star reference for ticketing data" — unclear, needs clarification

---

## K. Competitive & process

- **"Opendate has too many little buttons that are very important"** — current-Opendate-customer complaint. Density/UX is their weak flank.
- "Training an AI … when you hate it" — booking triage is felt as drudgery, not craft.

---

## Open questions for the next conversations

1. Is $200-then-90% typical, or Drkmttr's own structure?
2. When the door doesn't cover the $200, what actually happens?
3. Who does the arithmetic today, and on what? (Ask to *see* a settlement sheet.)
4. Do they want money routed through the platform at all, or do they settle in cash that night?
5. Does "challenge" mean a formal 24/48-hour notice, or an informal ask?
6. Is the shared OAuth login a convenience or a problem they'd pay to fix?
