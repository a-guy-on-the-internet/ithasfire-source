# Decision Record: A booked event has sides, not one owner

**Status:** accepted 2026-09-30 ("this model is fine", owner), after an interview from 2026-09-22. On 2026-09-29 every part of the event builder and event pages was placed in a bucket and the owner accepted the placements and open calls D1–D11; capacity (D7) is a direction, not a ruling. Nothing is built yet.

An event today belongs to exactly one org or one person, and that single field decides who can edit it, whose admin it lives in, whose quota it counts against and whose money it is. Every hard ruling in the booking arc — who owns the show a place books, whose event a rental is, what a place owned by both an org and a person means — came from forcing that one field to answer a question with two right answers.

The model: an event has three **sides**. The organizer side runs it and answers for it, the act side is whoever has to agree to play it, and the place side holds the place. Whoever sends a request to a place is always on the act side. One organisation or person can sit on two sides: in a play-here booking the place is on the place and organizer sides; in a rental the sender is on the act and organizer sides. Each side adds organisations and people to itself without the other sides' permission, but only with rights the side already has. Which of an entity's own people act for it is decided as it is today, by an organisation's roles or a person's delegates. An event made directly has one side, its creator's, and works as it does today. Exactly one party is the **organiser**, the party tickets are sold on behalf of and the quota home, chosen by the booking's intent. Ithas Fire stays the merchant of record on every sale (owner, 2026-10-10). The bill is what appears on the event, not who holds it: an act with no account is on the bill by name and holds no side.

Settled in the interview:

- Every party sees the whole event; what it may change depends on its side, through five buckets: organizer only, place only, act only, needs the other side's yes, and any side. Placement belongs to the place side. Any side may cancel a booked event on its own.
- Who changes what follows the booking-flow canvas (https://claude.ai/artifact/QVdGnAjDwxNyTPa5L5LnMz): the sender's side edits the bill; the act supplies artwork through the place's asks; the place drafts the terms and the sender agrees them, and reopening them keeps the event; the organiser sets tickets and publishes.
- Negotiated terms live on the agreement. After booking, any side party to it may propose an amendment that the other accepts or declines. This retires the one-editor rule for booked events only.
- A shared event appears in every party's admin. Deleting the organiser cancels its events through the normal cancel path; deleting any other party removes it from the event.
- A booking grant makes its holder an **outside booker**: it skips the request entirely, creates events the place stands behind from the start, and sees the place's calendars.
- A delegate acts for the act that granted it — an artist's manager — including agreeing to terms.
- Place, not venue, in code and copy.
- Accepted (2026-09-29): the organizer owns title, description, category and tags; the organizer may swap the act's artwork and the act is told; moving a booked night needs the act side's yes and ticket holders are told; the place cannot move an outside booker's night; an empty side's rights go to the organizer; whoever makes an event first stays its organizer; only an event with no place side can become a series on its own; the organizer issues comps and the act's guest list is written into the terms; refunds reaching money already paid out are the organizer's call and the affected side is told; visibility follows the matrix on the Event Sides page (the organizer sees buyers and all money, the place sees names at the door, the act sees counts and its own payout line, only the organizer messages buyers).
- Capacity (direction, not final): a room's capacity is the fire-marshal limit and is there to inform. It is pulled from the room. How many tickets sell is set by the organizer and the place. A per-ticket-type capacity may not belong on tickets at all.

## Considered Options

- **Several full owners.** Rejected: money and quota need exactly one accountable home, and the ledger already carries the split between payees.
- **Three fixed roles, one entity each.** Rejected 2026-09-28: a promoter who sends a request for a band they won't play held no role on the event they negotiated, and an organisation act cannot sit on the bill.
- **Two sides, sender and place.** Superseded 2026-09-29: an organiser asking an act to play sends no request to a place, and the act still needs a side.

## Consequences

- The accept spec's mint point (`docs/specs/2026-09-05/completed/booking-accept-is-the-mint-point.spec.md`) was superseded on 2026-09-25 by `docs/specs/2026-09-25/booking-the-night.spec.yaml`. That spec builds single-owner now rather than waiting for sides; every booking made before sides exist gets its sides filled in afterwards from its request and agreement, so nothing is lost. Its event's single owner must be the organiser by intent, never the individual who sent the agreement for review.
- Organisation acts must be able to sit on the bill; the bill has no organisation column today, so an organisation act appears as free text.
- The three edit-permission checks that disagree today — one honours delegates and the others do not — must become one check, keyed on side and role.
- Holds that are not tied to a booking request were handed to their own spec on 2026-09-29. They collide with the 2026-09-25 rule that booking without terms is only allowed on a date the pitch asked for, since a hold with no request has no pitch.
