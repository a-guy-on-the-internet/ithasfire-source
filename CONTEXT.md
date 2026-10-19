# Ithas Fire

The canonical glossary for this codebase. One bounded context, one file. It grows lazily — a term lands here when it has been argued about and settled, not before. Honour the `_Avoid_` lists in code, copy, and delegation prompts.

Seeded 2026-09-05 with the booking vocabulary, which had drifted far enough to produce two competing ways to create the same show.

## Principles

**Pro-social**:
The product's tiebreaker: when design options are close, favour the one that gets people into rooms together and connects them, while protecting whoever has less power. The seven principles live in `docs/pro-social.md`.
_Avoid_: Engagement, social (as in "social features")

## The booking arc

A booking travels **Request → Terms → Booked night → Event**. Holds run alongside the first two legs as the venue's shortlist of nights. Each step has one button with one name; no button in a booking says "Confirm".

**Booking request**:
An act asking a venue for a night, or an organiser asking an act to play one. Carries preferred dates, a pitch, and a sender who may be an owned act or an anonymous inquiry from an embed.
_Avoid_: Booking (a request is not yet a booking), inquiry (that is the anonymous sub-case only), application

**Sender**:
Whoever sent a booking request — a person or an organisation. A promoter who sends a request for a night they won't play is still just the sender; they are not the event's organiser. A request lives in the admin of whoever sent it: a band's requests under the band, a person's under the person.
_Avoid_: Organiser (that is the event role), requester (fine only where the intent is a rental or use)

**Bill**:
The ordered acts a request to play proposes for the night, each with its role. It belongs to the sender, who can change it until the night is booked; then it becomes the event's lineup. A request may have no bill at all. Acts on a bill can be people or groups.
_Avoid_: Lineup (until the event exists), roster, line (a line is holds on a date), slot (acts have a position and a role, not a billing slot)

**Open call**:
An event's public invitation for acts to apply to play it: an application form whose purpose is to fill the lineup rather than to let people in. Anyone making an event can post one; an act applies with or without an account, as a person or as a group. The event's dates are the dates applicants choose from.
_Avoid_: Posting, gig listing, audition, job post, call for submissions

**Pick / Not this time**:
The organizer side's answer to an application on an open call. A pick puts the act straight onto the event's lineup; "not this time" closes the application with a reply to the applicant. Code calls the second one rejected; screens say "Not this time".
_Avoid_: Pass (an act's answer to a bill), decline (an answer to a request or agreement), reject (on screens)

**Join / Pass**:
A tagged act's answer to being put on a bill. Joining lets the venue see them on it; passing takes them off everything the venue sees and is final for that request. An act that joined can leave until the night is booked, and leaving is final too.
_Avoid_: Confirm, accept, decline

**Standards**:
What a venue says every pitch must include, set per calendar with a venue-wide default. Each item is required (the request can't be sent without it) or suggested (a prompt). A venue's own free-text lines are always suggestions.
_Avoid_: Requirements (fine in copy for the required items only), criteria, rules

**Example pitch / Pitch outline / Pitch template**:
An example pitch is a finished pitch to learn from, written by the platform or the venue. A pitch outline is the shape of one — short bracketed prompts the sender writes over. A pitch template is the sender's own saved message that fills the form for them.
_Avoid_: using "template" for the platform's outline

**Hold**:
A place in line for one date on one calendar. Pencil, not pen — several acts can hold the same night at different positions, and a hold confers no claim on the date until the night is booked. A hold that has been booked stays visible as booked.
_Avoid_: Pencil, option, tentative booking, reservation (reservation belongs to ticketing)

**Line**:
Every hold on one calendar and one date, ordered by position. Position 1 is first refusal, shown as "1st hold".
_Avoid_: Queue, waitlist, stack

**Hold owner**:
Whoever a hold is for, and so whoever answers a challenge on it: the sender for a hold on a booking request, the outside booker for a hold it set, the place for a place hold. A hold with no request is owned by whoever set it, and it is resolved by an event existing: its owner answers a challenge by making the event or letting the hold go.
_Avoid_: Holder of record, assignee (that is the staff member handling a request)

**Place hold**:
A hold a place sets on its own line with no booking request, either unassigned or naming one person or organisation on the platform. A named party is told and can pass, which leaves the hold with the place.
_Avoid_: Internal hold, house hold, placeholder

**Challenge**:
A venue telling the act at 1st hold that another act is ready to book the night, and asking them to keep it or let it go by a deadline. Only allowed when another act on that night has terms ready. While a challenge is open the night cannot go to anyone else. The challenged act is never told who the other act is.
_Avoid_: Nudge, ultimatum, first-refusal notice

**Keep / Release**:
The two answers to a challenge. Keep is a commitment: it agrees the terms for that night (or, if none have been sent yet, asks for them and must agree them by a new deadline). Release gives the night up, and the next act in line moves to 1st hold.
_Avoid_: Confirm, accept, hold on

**Accept (a request)**:
The venue saying yes to talking terms. It opens draft terms; nothing is booked yet.
_Avoid_: Approve, confirm, book

**Withdraw / Close request**:
The ways out of a request before its night is booked. The sender withdraws it; the venue declines it (before accepting) or closes it (after accepting). Either way its holds are released and any draft terms are cancelled.
_Avoid_: Cancel (that is for a booked night), reject

**Ask**:
A venue's request, on a booking thread, for one specific thing the night needs — a poster, a rider, a set length. It stays open until the sender answers it, and the answer is kept and used: a poster becomes the event's image, a set length becomes the end time in the terms.
_Avoid_: Requirement (that is a standard, checked before sending), task, request (taken by the booking request itself)

**Agreement**:
The terms between a venue and a sender for a booking: the date, and the deal — who is paid what, and how. Terms can be as small as just a date. Shown to both sides as "the terms"; the money part is "the deal".
_Avoid_: Contract, deal memo, offer

**Send terms**:
The venue sending the terms to the sender to agree. One button whether or not the terms include money. Terms can't be sent for a night where another act is ahead in line.
_Avoid_: Send the night, send for review, propose, offer

**Agree & book**:
The sender agreeing the terms the venue sent — the act itself when an act pitched, the promoter when a promoter did. That one tap books the night, takes it off every competing hold, and creates the draft event. Declining sends the terms back to the venue as a draft, with a reason.
_Avoid_: Sign, confirm, accept (reserved for the venue's answer to a request), agree the night

**Book without terms**:
A venue booking a night straight from a hold, with no agreed terms, allowed only on a date the sender asked for. The event is created and terms can follow; until they do, ticket money goes to the event's organiser.
_Avoid_: Confirm the hold, quick book

**Booking**:
A request whose night has been booked — its terms, its booked hold, and its event, which live and die together.
_Avoid_: using it for a request whose night is not booked yet (an accepted request is still only talking terms), deal, gig

**Cancel booking**:
The one undo for a booked night. Either side can cancel, with a reason; the terms and the event are cancelled together and the night opens again.
_Avoid_: Unconfirm, release (that is for holds), withdraw (that is for requests)

**Reason**:
The short explanation given whenever a booking is declined, closed, cancelled, passed on or refused. Always one field; a venue can keep its own reusable reasons, starting from platform defaults it can change.
_Avoid_: Note (that is the shared scratchpad on a hold, event or request), comment

**Note**:
The one shared scratchpad on a hold, an event or a booking request. Everyone who can open that thing in full reads and edits the same note; there is no private per-party note.
_Avoid_: Comment (a note is not a thread), internal note, memo

**Venue confirmation**:
A venue's statement that it stands behind an event someone else built at its place, stamped on the event and withdrawable with a reason. It is not part of booking a request — a booked night needs no confirmation.
_Avoid_: verified (that is the platform's trust in the venue record), approved

**Confirm**:
Not a booking word. No button in the booking arc says "Confirm"; the product spends the word on order confirmation. A venue accepts a request and sends terms; a sender agrees and books.
_Avoid_: using it for anything a venue or sender does to a request, hold, or terms

**Run**:
Several nights booked with the same act off one request — a residency, a weekend, a two-night stand. A run is expressed as a series.
_Avoid_: Multi-date booking, block booking, residency (residency is one kind of run, not the category)

## Deals and settlement

**Deal**:
The money part of the terms: who is owed what for the night, and how it is worked out. Built from a preset (guarantee, door split, guarantee plus a percentage, versus, straight percentage, room rental) and adjusted clause by clause.
_Avoid_: Split (a split is one payee's percentage), contract

**Guarantee**:
A fixed amount an act is owed however many tickets sell. If the night doesn't cover it, the shortfall is still owed.
_Avoid_: Floor, minimum

**Door split**:
A percentage of the pool, paid after the costs come off the top.
_Avoid_: Door deal (fine in copy), backend

**Versus**:
A guarantee or a percentage of the pool, whichever is greater — decided after the show, once the real numbers are in.
_Avoid_: Vs deal (fine in copy), greater-of

**Off the top**:
Costs taken from ticket money before anyone's percentage is worked out — a room rental being recouped, sound, marketing, the house nut. Each is credited back to whoever paid it. Costs are only recouped from money that exists.
_Avoid_: Expenses (fine for the expense kind only), deductions (in copy)

**Deposit already paid**:
Money one side paid the other before the show — say, a promoter's deposit to the venue. It isn't a cost off the top and doesn't change anyone's share; it just lowers what that side still owes when the night is settled. Door cash and a bar share work the same way: they change who already holds money, not how the ticket money is split.
_Avoid_: Prepayment, advance

**Pool**:
What's left of the ticket money after the costs off the top. Percentages are worked out from the pool. It never goes below zero.
_Avoid_: Net, net pool (in copy), profit

**Shortfall**:
When the pool can't cover a guarantee. The difference is owed by whoever takes the remainder — usually the venue — directly to the act; Ithas Fire never covers it.
_Avoid_: Loss, deficit

**Payee**:
Anyone Ithas Fire can pay directly, with payouts set up. Ithas Fire can only pay a whole deal when everyone in it is a payee.
_Avoid_: Recipient (fine in copy), vendor

**Merchant of record**:
Ithas Fire, on every sale. The buyer pays Ithas Fire, which answers for the refund, the dispute and the tax, and pays the payees afterwards. A ticket is sold on behalf of the organiser, never by them.
_Avoid_: Calling the organiser, the venue or any payee the merchant of record

**Paid through Ithas Fire / Settle directly**:
The two halves of every deal today. Ithas Fire pays the percentage-of-ticket-money lines as tickets sell; everything else — guarantees, versus, costs — is worked out by the calculator and settled directly between the parties.
_Avoid_: Off-platform (in copy), manual payout

**Settlement sheet**:
The page after the show that works out the deal on the real numbers — ticket money, money Ithas Fire never saw (like door cash) typed in by whoever settles, costs, the pool, and who pays whom. Anything not typed in reads "Not entered", never $0.
_Avoid_: Settlement report, statement (a payout statement is a different thing), invoice

**Resale share**:
The clause in a deal that sends part of every resale to the people who put on the night: a percentage of the sale or a flat amount, at most 10% of the sale, taken from the seller unless the clause says the buyer pays it. A ticket keeps the share in force when it was first sold, on every resale after. Paid through Ithas Fire; Ithas Fire takes nothing on a resale. In copy: "to the people who put on the night".
_Avoid_: Royalty, markup share (the old rule it replaced), resale fee (Ithas Fire charges none)

**Original price**:
What the organiser charged for a ticket at its first sale. Shown on every resale listing, however many times the ticket has changed hands. Never the price the current seller paid.
_Avoid_: Face value (in copy; on a second-hand ticket it was read as the last resale price)

## Money in and out

**Payment**:
Money coming in from a buyer: tickets, memberships, anything sold. Organisers don't set up how buyers pay, so no organiser page is named after payments.
_Avoid_: Payout (that is money out)

**Payout**:
Money Ithas Fire sends from a payee's balance to their Stripe account, in the nightly run. Every payout is a row in the ledger. Stripe moving it on to the bank is a separate step on Stripe's own schedule.
_Avoid_: Settlement (in copy; a settlement sheet is a different thing), transfer (fine in code), disbursement

**Balance**:
What Ithas Fire owes a payee right now: everything earned, matured or not, minus everything already paid out. Only the matured, unblocked part is ready to pay out.
_Avoid_: Payable (that is the ready part), available balance, earnings

## Tickets and seats

**Ticket type**:
A kind of ticket an event sells, with its own name, price and capacity. The capacity is how many of its tickets can be out at once: a refunded or revoked ticket gives one back, and copy says that ticket "goes back on sale". A refunded resale order is the exception: its ticket returns to the seller, not to sale. Code also says tier.
_Avoid_: Tier (in copy), ticket class, price level; place or spot for one unit of capacity (a Place is where events happen)

**Pay what you want**:
A ticket type whose buyer names the amount, at or above a minimum the organiser sets. The other kind is fixed-price. "Sliding Scale" is a preset name an organiser can start such a ticket type from, not a second kind. Code says ADJUSTABLE and FIXED.
_Avoid_: Pay what you can, sliding scale (as the name of the kind), adjustable (in copy)

**Section**:
A named group of seats at an event, sold through one or more ticket types.
_Avoid_: Zone, area, tier

**Seat**:
One sellable place in a section, named by its row and number.
_Avoid_: Spot, chair

**Section price**:
What a seat costs when it has no custom price: the price of the ticket type the buyer picks in that section.
_Avoid_: Base price, default price

**Custom price**:
A price set on one seat that replaces the section price for that seat, under whichever ticket type sells it. Code says price override.
_Avoid_: Override (in copy), special price, seat tier

## Dates and occurrences

Two different occurrence concepts exist and they are not interchangeable.

**Event**:
One show, on one date, at one place. The unit that is ticketed, scanned, and settled. Everything sellable hangs off an Event.
_Avoid_: Gig, show (fine in copy, not in code), listing

**Series**:
A named group of Events that share a schedule and a shape. Each of its occurrences materialises into a full, independent Event with its own tickets, capacity, and settlement.
_Avoid_: Recurring event, repeat event

**Occurrence**:
One date within a series, before or after it becomes an Event. Detaching an occurrence severs the series' claim on it and leaves the Event standing on its own.
_Avoid_: Instance, repetition

**Event date**:
A date within a free community listing that people RSVP to. Not ticketed, not scanned, not settled — a lightweight repeat for listings that never sell anything. When a paid run needs several nights, that is a series, never event dates.
_Avoid_: using it as a general word for "a date an event happens on"

## Places

**Place**:
A physical location where events happen.
_Avoid_: Venue — in code and in copy (owner ruling 2026-09-28), location

**Calendar**:
A programming filter within a place — a strand of bookings a venue thinks about together, such as a room's Thursdays or a promoter's nights. Holds and lines belong to calendars.
_Avoid_: Schedule, track

**Space**:
A physical subdivision of a place — a room, a stage, a patio. Distinct from a calendar: a calendar is how a venue programmes, a space is where the show physically happens.
_Avoid_: Room (except in user-facing copy), venue, area

**Arrival area**:
A shape drawn on the map near a place or an event that tells people where to arrive: parking (a lot or a stretch of street), accessible drop-off, or load-in for acts. Users see these under "Getting there"; an event shows its place's arrival areas plus any of its own.
_Avoid_: Parking area (parking is only one kind), parking zone, lot, container, area (alone)

## People and access

**Human**:
A person in the domain. Distinct from the authentication account that signs them in.
_Avoid_: User, account (both are ambiguous between the person and their login)

**Act**:
The performing side of a booking — a solo human or an organisation. Used when the booking side matters more than the entity type.
_Avoid_: Artist (narrower than the domain covers), talent, band

**Organisation**:
A business entity that owns places, sits on a side of events, and has members with roles. It does not own an event outright — see Side.
_Avoid_: Company, team (team is the members, not the entity), account

**Delegate**:
Someone granted access to act on another **person's** personal account — the team concept for people who have no organisation. Scoped to the principal, not to any one place or event. An artist's manager is a delegate: they act for the act on its side of a booking, including agreeing to terms, because the act granted it.
_Avoid_: Assistant, manager, proxy

**Booking grant**:
The right to make events at a place, handed by the place to an outside booker: events the place stands behind from the start, with holding nights and seeing the place's calendars coming with it. Given only by the place's owners and admins, it counts once the outside booker accepts it. Scoped to the place or one of its calendars, revocable, and expiring. Not an organisation role and not a delegation.
_Avoid_: Booker role, venue staff, permission

**Outside booker**:
The organisation or person a booking grant is handed to. Skips the booking request entirely and books the place for its own events. Not staff of the place.
_Avoid_: Agent (retired 2026-09-29: an outside booker books for itself, it does not work the place's bookings on the place's behalf), talent buyer, rep

**Hub**:
A person's own admin view, which spans every subject they can act for — their own entities plus the organisations and venues they have access to — rather than scoping to one tenant. "Everything waiting on me, in one list." An organisation's admin view is the opposite: a strict tenant.
_Avoid_: Dashboard, personal workspace

**API key**:
A credential a script or app uses to act for one human, limited to one key scope and one access level (read, or read and write). It never does more than its holder could do signed in, and exists only after someone else approves a key request.
_Avoid_: Token, secret, access token

**Key request**:
A human's ask for an API key: what it covers, the access level, a label, the purpose and an expiry. Someone other than the requester approves or denies it; an approved request becomes a key when the holder collects it.
_Avoid_: Key application, API access request

**Key scope**:
What an API key covers: one organisation the holder runs, the holder's own account, staff tools, or public listings across the whole platform.
_Avoid_: Scope (bare), permission, role

**Platform owner**:
The one human who owns Ithas Fire, named in code rather than granted. The only person who may approve their own key request, for a staff key.
_Avoid_: Superadmin, root, owner (bare)

## Parties on an event

**Side**:
One of an event's three sides: the **organizer side**, which runs the event and answers for it; the **act side**, whoever has to agree to play it; and the **place side**, which holds the place it happens at. Whoever sends a request to a place is always on the act side. One organisation or person can sit on more than one side: in a play-here booking the place is on both the place side and the organizer side, and in a rental the sender is on both the act side and the organizer side. A side holds organisations and people, and which of their own people act for them is decided as it always is, by an organisation's roles or a person's delegates. A member can add others to its side, but only with rights the side already has. An event made directly has one side, its creator's, and works as it always has.
_Avoid_: Team, party list, co-host

**Party**:
Any organisation or person on a side of an event. Every party sees the whole event; what it may change depends on which side it is on. Being on the bill is not being a party: an act with no account is on the bill by name and holds no side.
_Avoid_: Owner (an event has an organiser, not an owner), collaborator, member

**Organiser**:
The one party an event is accountable to: the party its tickets are sold on behalf of, whose quota it counts against, and whose name it is presented under. Ithas Fire, not the organiser, is the merchant of record. Exactly one per event, chosen by the booking's intent — the place for a play-here booking, the sender for a rental or use — and overridable when the terms are agreed. Spelled *organizer* in code and copy.
_Avoid_: Owner, host, promoter (a promoter is one kind of organiser, not the role)
