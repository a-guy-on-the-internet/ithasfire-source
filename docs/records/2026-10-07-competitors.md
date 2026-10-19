# Competitors, October 2026

**Date:** 2026-10-07
**Updates:** [2026-04-18-market-viability.md](2026-04-18-market-viability.md) (fee table, funding list)
**Method:** web research on vendor pages, trade press (Pollstar, TicketNews, Music Week) and review sites, plus a read of our own committed code on `main`. Vendor claims are marked as claims. Fees are computed from published rates, not from test purchases.

## What changed since April

| Who | Move | Why it matters to us |
|---|---|---|
| **Opendate + Tixel** | June 2026: face-value-capped fan-to-fan resale built into Opendate. Barcode voided, new ticket issued, venue keeps the data and a share. Opendate sponsored NIVA Con '26 in Minneapolis (First Avenue, Hook & Ladder). | Closest rival. Free venue software with booking, settlements, box office and now fair resale, aimed at our venues in our city. |
| **Ticket Fairy 3.0** | March 2026: "AI operating system" for independent promoters. Agents for admin, ops, fan support and settlements; embedded banking; up to $3M in advances. | Competes for mid-size promoters and festivals. Weak at the small-room end (see below). |
| **TickPick** | Bought Fanimal (2025) to sell primary ticketing; markets hard to organizers leaving Eventbrite. 5% + processing, no buyer fees, browse price = checkout price. | Owns the "no junk fees" message and brings a buyer marketplace we don't have. |
| **Eventbrite** | Bending Spoons closed the ~$500M purchase in March 2026 (announced Dec 2025). Layoffs, thinner support, Flex plan retired, email marketing behind paid tiers. Ticket fees unchanged so far. | Organizers are shopping. Everyone above is publishing "leaving Eventbrite?" guides. |
| **DICE** | One year under Fever; feeds Fever's discovery (~300M people). New US indie signings (Saint Vitus, Public Records, Sound). | Strong fan discovery and a face-value waitlist. Organizers complain about app lock-in and limited access to their own customer data. |
| **Seatfun** | Launched March 2026, Nashville/Cincinnati, invite-only, 100+ organizers, multi-million funding. | The one new entrant in one of our two markets. Fees not published. |
| **SeatGeek** | Took the Minnesota Wild, Grand Casino Arena, RiverCentre and Roy Wilkins (July 2026) and CMA Fest. | Arena tier, not us, but both our markets are in play for incumbents. |
| **Luma, Partiful** | Luma: 5% free tier, 0% on $59/mo Plus. Partiful added paid tickets. | Default tools for community events and meetups, the same space as our community listings and RSVPs. |
| **NIVA, DoStuff** | NIVA launched a Fan Action Center against exploitative resale. DoStuff shows a "NIVA-Certified Live Independent" badge across 20 city sites. | Allies and distribution, not competitors. |

## Fees on a ticket, from published rates

What the buyer pays on top of face value, in dollars. Tax excluded everywhere.

| Face | **Ithas Fire** | Ticket Tailor | TickPick | Luma (free) | DICE* | Humanitix | Ticket Fairy | Posh* | Eventbrite |
|---|---|---|---|---|---|---|---|---|---|
| $5 | **0.63** | 1.29 | 0.70 | 0.70 | ~0.50 | 1.54 | 2.00 | 1.49 | 2.12 |
| $10 | **0.95** | 1.44 | 1.09 | 1.09 | ~1.00 | 1.79 | 2.00 | 1.99 | 2.45 |
| $25 | **1.57** | 1.88 | 2.28 | 2.28 | ~2.50 | 2.54 | 2.50 | 3.49 | 3.44 |
| $40 | **2.02** | 2.31 | 3.46 | 3.46 | ~4.00 | 3.29 | 4.00 | 4.99 | 4.43 |

Ours: 3.33% of face capped at 50¢, plus Stripe 2.9% + 30¢ grossed up (`packages/core/src/lib/pricing/platform-fee-policy.ts`). Ticket Tailor at pay-as-you-go 85¢ plus Stripe; its bulk credits go lower. Luma Plus is Stripe only, for $59/mo. Ticket Fairy's fee includes processing; its floor is $2 on any paid ticket. \*DICE (~10%, unconfirmed) and Posh (10% + 99¢) exclude processing, so they understate.

Among platforms with no subscription, we are the cheapest at every price in the table, and the gap is widest on cheap tickets: a $5 open mic costs the buyer 63¢ with us and $2 with Ticket Fairy.

The flip side: our platform take on a $25 ticket is 50¢, or 2%. The April viability model assumed an 8% take. At our current rates, the same volume earns about a quarter of what that model projects.

## Ticket Fairy in detail

**What they sell.** Ticket Fairy (YC S15, founded 2011, about $300M in lifetime ticket sales by its own count) relaunched in March 2026 as an operating system for independent festivals, venues and promoters:

- **"Fai" agents** for inbox and contract analysis, vendor coordination, fan support over messaging, and settlements in 30+ currencies. They claim 1,000+ hours saved per event cycle. Nobody independent has checked.
- **TF Vault:** multi-currency business accounts and expense cards.
- **TF Capital:** advances up to $3M (US), funded by an unnamed UK credit fund, available months before on-sale. Fees and repayment terms are not published.
- **Referral rewards in checkout:** buyers get a link and cash back, and the organizer sets the reward. They claim 20% more tickets on average.
- **The usual kit:** official resale with organizer-set caps ("at face value" on the homepage), Stripe Terminal POS, a scanning app that needs a connection, a REST API with React SDKs, email/SMS, abandoned cart, ad pixels, and Klarna/Afterpay/Affirm.

**Pricing.** Buyer-paid, processing included: $2 flat under $20, then 10%, 9% and 8% as the ticket gets more expensive. No organizer fee, daily payouts on Stripe.

**Where they're weak.**
- **Cheap tickets.** The $2 floor is 40% on a $5 show and 20% on a $10 one. Open mics, house shows and small clubs are exactly where we're strongest.
- **Accountability when an organizer fails.** Trustpilot is about 3.5 stars, split between 73% five-star and 23% one-star. The one-star theme: an event is cancelled, the organizer already has the money, and Ticket Fairy answers that it's "just the technology platform." One reviewer: "Lost $470 due to cancelled timeless summer tour." Ticket Fairy doesn't respond to negative reviews.
- **Fee display.** A May 2026 review says the booking fee "wasn't shown on the website when I bought the tickets." That's one anecdote, but it fits a fee-on-top model.
- **No venue booking, calendar or act management.** We found nothing on their site.
- **Scanning needs internet.** Ours validates offline against a signed manifest.

**Where they beat us.** Capital, marketing tools (SMS, pixels, abandoned cart, referral), buy-now-pay-later, multi-currency, a real public API with SDKs, and a decade of festival operations. A promoter who needs $200K for artist deposits in March won't pick us, and we shouldn't try to compete on that.

**What it means.** Ticket Fairy is fighting for the mid-size promoter who wants money and marketing. We overlap with it in small clubs, and there our price and door tools win clearly. Its referral numbers are the part worth taking seriously (see "Bring a friend" below).

## What each one means for us

**Opendate:** the real threat. It gives venues the booking and settlement tools we're building, for free, plus face-value resale, and it's already working the Minneapolis independent scene. Its gap is the act side: it is software for the venue's staff only. We have the two-sided version: acts apply to open calls and see the other applicants, booking requests run both ways, and agreements pin the fee version. That two-sidedness is the pitch against Opendate. We don't know its buyer fees yet (see "Open questions").

**TickPick:** cheaper than Eventbrite and all-in, but we're cheaper than TickPick at every price (3.33% capped vs 5%). What it has that we lack is demand, a marketplace of millions of buyers. On price alone we win.

**DICE:** discovery and face-value waitlists, at the cost of the app requirement and organizers' access to their data. Our principle "connections outlive the transaction" and our web-first checkout answer the lock-in complaint directly.

**Posh:** nightlife and promoter culture, with a social feed, contact import and promoter kickbacks, at 10% + 99¢. A different segment; low overlap.

**Luma and Partiful:** the default for community events. They overlap with our community listings and RSVPs. Their strength is UX and habit. Ours is that a community listing connects to real venues, acts and a door. A meetup organizer who never needs a venue has no reason to switch.

**Eventbrite:** a source of organizers rather than a competitor to beat. Fees haven't moved yet. If Bending Spoons follows its Meetup playbook (about +60%), the window opens wider.

**Humanitix, Ticket Tailor:** cheap and well liked, white-label tools for charities, schools and small theatres. Ticket Tailor's bulk credits beat us on expensive tickets. Neither has resale, booking or discovery.

**Seatfun:** watch it in Nashville. Invite-only and funded; we don't know its pricing.

## What we do well

These are from committed code, not plans.

- **Cheapest per ticket without a subscription,** most of all on the cheap tickets that small rooms sell.
- **All-in price from the first view,** including search results, which index the fee-inclusive price. Only TickPick and Luma clearly do the same. Sales tax is added once we know the billing address.
- **A two-sided booking stack nobody here has:** booking requests, holds with challenges, agreements, enforced booking standards, and open calls where applicants see each other but nobody sees who was passed over. Opendate covers the venue half only.
- **The door:** one app does offline-first scanning plus card-reader, Tap to Pay and cash POS. Ticket Fairy's scanner needs a connection.
- **House shows and DIY:** addresses withheld until a scheduled reveal, gated and private events, and house-show legal research. The research turned up no competitor serving this segment.
- **Tax:** per-order tax lines and a model built for local impositions such as the Minneapolis entertainment tax (in progress, rates not live). No competitor says much about tax.
- **Resale with a claims desk,** with seller payouts held until a release date.
- **Spanish** as a full locale, with parity tests.

## Where we're behind

- **Resale fairness, as marketed.** Opendate/Tixel, DICE and Ticket Fairy all lead with "face value." Our cap is a dollar amount the organizer picks, and markup above face is allowed by design, split between seller and venue. Ours is the more flexible design, but theirs is the simpler promise, and NIVA is now campaigning on exactly this.
- **Demand.** TickPick, DICE/Fever, Posh and Luma bring buyers. Our fan app is basic (discover, buy, tickets) and has no audience yet.
- **Bring-a-friend.** Ticket Fairy's referral rewards and Posh's contact import address it. We have no "friends going" and no referral.
- **Marketing tools.** We have audiences and announcements. We lack SMS, abandoned cart, ad pixels and waitlists.
- **Public API.** We have API keys and embeds, but no documented REST surface or SDKs.
- **Revenue per ticket** (see the fee section).

## Recommendations

Each one names the [pro-social](../pro-social.md) principle that decided it.

1. **Make face value the default resale cap, with above-face as a deliberate organizer opt-in.** *Protect the weaker side* (buyer over seller). It also lets us make the same simple promise our competitors make. This is the owner's call: it changes the venue's share of resale markup.
2. **Answer referral without cash kickbacks.** Show "people you know are going" inside the event's context, with the person's yes, and let a buyer send a friend a ticket link. Cash-back referral is a growth loop, which our principles avoid. *Visible in context*; *the room is the point*.
3. **Pitch against Opendate on the act side.** Lead with venues that book local acts (open calls, open mics, small clubs), where Opendate's staff-only tool has nothing for the act. *Connections outlive the transaction*.
4. **Lead public positioning with the small-room price and the all-in number.** A public fee comparison like the table above, with sources, fits the honesty half of the mission ([pro-social.md](../pro-social.md)).
5. **Revisit the revenue model.** Either the 50¢ cap stays, and the business case needs volume or a venue software tier, or the cap rises. This should be decided on purpose, not discovered later.
6. **Leave capital and AI agents to Ticket Fairy.** Neither serves small rooms.

## Open questions

- What does Opendate charge buyers, and does it show the price all-in? A test purchase at a Minneapolis Opendate venue would answer both.
- What does Seatfun charge, and who are its Nashville organizers?
- Is our resale markup split being used by any organizer today? That tells us what a face-value default would cost.

## Sources

- Ticket Fairy: [launch release](https://www.ticketfairy.com/press/ticket-fairy-launches-aipowered-operating-system-for-live-events), [Pollstar Q&A with Ritesh Patel](https://news.pollstar.com/2026/03/16/theres-not-many-companies-providing-a-festival-with-5m-in-funding-today-qs-with-ritesh-patel-co-founder-ticket-fairy/), [pricing](https://www.ticketfairy.com/pricing), [features](https://www.ticketfairy.com/features), [Trustpilot](https://www.trustpilot.com/review/www.ticketfairy.com), [TicketNews](https://www.ticketnews.com/2026/03/ticket-fairy-ai-powered-system-festivals-venues/)
- Opendate/Tixel: [Pollstar](https://news.pollstar.com/2026/06/02/exclusive-tixel-partners-with-opendate-to-bring-verified-fan-to-fan-ticket-exchange-to-independent-us-venues/), [Opendate announcement](https://www.opendate.io/announcements/verified-resale-powered-by-tixel-is-live), [NIVA Con '26](https://www.opendate.io/post/built-by-people-whove-worked-the-room-niva-con-26)
- TickPick: [fees explained](https://www.tickpick.com/blog/organizer/ticketing-fees-explained), [Eventbrite alternatives](https://www.tickpick.com/blog/organizer/eventbrite-alternatives), [Axios on Fanimal](https://www.axios.com/pro/media-deals/2025/03/06/tickpick-fanimal-deal)
- Eventbrite: [Ticket Tailor on Bending Spoons](https://www.tickettailor.com/blog/bending-spoons-acquires-eventbrite-what-does-this-mean), [Eventcloud](https://www.eventcloud.io/blog/eventbrite-under-bending-spoons), [TickPick on 2026 fees](https://www.tickpick.com/blog/organizer/eventbrite-2026-fee-changes)
- DICE: [Fever newsroom](https://newsroom.feverup.com/en-US/267607-fever-and-dice-one-year-on/), [Music Week](https://www.musicweek.com/live/read/dice-announces-new-wave-of-partnerships-in-the-us/094779), [Ticket Tailor review summary](https://www.tickettailor.com/blog/dice-reviews-summary-pros-cons)
- Posh: [Posh on fees](https://posh.vip/university/post/eventbrite-fees-explained-2026), [Ventureburn](https://ventureburn.com/posh-bags-37m-series-b-to-scale-ticketing-services/), [TechCrunch 2024](https://techcrunch.com/2024/07/23/event-startup-posh-raises-22m-in-to-focus-on-personalisation-and-event-diversification)
- Luma: [creating a paid event](https://help.lu.ma/p/creating-a-paid-event), [Luma vs Posh](https://help.luma.com/p/luma-vs-posh)
- Humanitix: [booking fees](https://humanitix.com/blog/how-our-booking-fees-are-changing). Ticket Tailor: [pricing](https://www.tickettailor.com/pricing)
- Entrants: [Seatfun](https://musicrow.com/2026/03/seatfun-ticketing-platform-launches-new-app/), [SeatGeek and CMA Fest](https://www.ticketnews.com/2026/07/cma-fest-taps-seatgeek-primary-ticketing-partner/), [Wild to SeatGeek](https://www.fox9.com/sports/mn-wild-grand-casino-arena-drop-ticketmaster-switch-seatgeek)
- Allies: [NIVA Fan Action Center](https://news.pollstar.com/2026/06/08/niva-2026-kicks-off-in-minneapolis-announces-fan-action-center-to-combat-misleading-fraudulent-exploitative-ticket-resale/), [DoStuff + NIVA](https://dostuffmedia.com/blog/dostuff-niva-team-up-to-spotlight-independent-venues-nationwide)
