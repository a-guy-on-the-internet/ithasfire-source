# Pro-social

Ithas Fire exists to get people into rooms together. Processing the transactions between them is the means, not the point. This page is the tiebreaker for product and design choices: when two options are close, pick the one these principles favour, and say which principle decided it.

Owner ruling, 2026-10-04: "This is supposed to be more of a pro social app."

**Honesty is the floor.** No option wins the tiebreak by hiding something: no hidden fees, no lock-in, and every rule and fee visible to the person it applies to. The principles below choose between options that already clear this floor. The checkable form of the floor for UX (no fake urgency, scarcity or social-proof counters) is `docs/specs/2026-07-05/completed/calm-honest-ux.spec.yaml`.

**No enshittification, ever.** *Ruled, owner, 2026-10-12: "IF WE BUILD ANYTHING TOWARDS ENSHITTIFICATION I WILL BURN THIS PROJECT DOWN".* This one is a veto, not a tiebreaker. An option that works toward it is dropped, however close the call or large the revenue. Enshittification is the platform taking back value from people once they depend on it: getting worse for buyers, acts, organizers or places so the company can take more. In this codebase that looks like:
- a fee, cut or limit raised on people who are already locked in, or a free capability moved behind a charge;
- paid placement, ads, or ranking for sale in discovery or search;
- a person's data, audience, history or tickets made harder to export, or held back to keep them from leaving;
- friction added to cancelling, refunding, unsubscribing or leaving, or nudges that serve our numbers over the person's choice;
- selling or sharing a person's information beyond what they said yes to.

When a change might be on this list, stop and ask the owner before building it. *The list is a draft reading of the ruling, not the owner's words; the ruling itself is the quote.*

**Mission** (from the former `mission.md`): make event commerce honest, programmable and accessible. Any person or organization can create, sell and manage live events without hidden fees, lock-in or predatory intermediaries. Payment, logistics and communication sit behind one API and UI that anyone can embed or extend, and organizers and attendees keep control, from a small community meetup to a large venue.

**Consent is the root** (owner, 2026-10-11: "It's consent based."; 2026-10-16: "Assume people want to share"). Nothing happens to a person's money without their yes, and nothing about them leaves its context without their yes. Inside the context, sharing is the default and opting out is one tap (principle 2). Honesty is what makes each yes, and each choice not to opt out, an informed one. *The sentences after the quotes are a draft reading of them, not the owner's words.*

**Where this is going** (owner, 2026-10-11): "Help building community spaces and organizers. Create more venues. Be the bridge between many different performances and creation of human connection." The aim is that more places and more organizers exist, across every kind of performance, and that the platform is the bridge between them. Serving the places and organizers who already exist is the means. *Proposed measure:* a first night at a place that had never hosted one, and a first-time organizer who runs a second.

## The principles

1. **The room is the point.** Success is people meeting offline: a bill filled, a night that happened, an act who got a second booking. Time spent in the app is a cost to the person, not a win for us.

2. **Visible in context.** Share information with the people who are in the same situation: other applicants to a call, other acts on a bill, the parties to an event. Widening that circle, up to the whole internet, takes the person's yes. Sharing within the context is the default, and opting out is one obvious tap.

3. **Nobody gets silence.** Every reach-out ends in an answer: a pass gets a reply, even an automatic one, and a withdrawn offer tells the people it affected. Silence costs the person with less power the most.

4. **Protect the weaker side.** When interests pull apart, design for the party with less power: the unknown act over the established promoter, the applicant over the poster, the buyer over the seller. Private notes, rejections, contact details and money stay private to the person they concern.

5. **Trust comes from traces.** Reputation is built from things that happened and are expensive to fake: a scanned door, a settled payout, a shared bill, a call that answered everyone. It runs both ways, so organisers earn it by how they treat acts, just as acts earn it by showing up. It is never bought and never a follower count.

6. **Spread attention.** Discovery favours near, new and relevant over already-popular. No ranking compounds fame, and a newcomer can be found on their first day.

7. **Connections outlive the transaction.** People keep what they built here (the acts they've worked with, the bills they've been on, their history), and they can take it with them if they leave.

## Where the principles pull against each other

- *Visible in context* versus *Protect the weaker side*: visibility stops where it would expose someone who can't easily say no. Example: applicants see each other, but nobody sees who was passed over.
- *Spread attention* versus *Trust comes from traces*: traces qualify people, and they don't rank them. A board can filter on "has played a bill here", but it can't sort by how many shows someone has played.

## How we hold ourselves to it

Good intent drifts. Nobody chose to take the platform fee twice, and it was taken twice on every paid ticket for months after the absorb option was removed, until someone added up one order. So each commitment here is written as something a person outside the company can check.

Each one carries a status. **Ruled** is the owner's decision and binds product and design choices. **Proposed** is a draft the owner has not ruled on: treat it as a lean when two options are close, and never cite it as a rule.

- **One fee, taken once, and the sums add up.** *Ruled, owner, 2026-10-11.* The buyer pays the platform fee on top of the ticket price, and the organizer is credited the full ticket price. Every settlement shows price, fee and credit, so the organizer can check it with a calculator. *Proposed:* a test asserts that what the platform keeps on a sale equals the stated fee, so drift fails a build.

- **Open books.** *Ruled, owner, 2026-10-11: "I do think I want to expose how much our shit costs us including what I've been spending on the company account. FULL TRANSPARENCY".* We publish what the platform took in, what it costs to run, and what the company account spent. *Proposed boundary, from consent:* a figure that identifies another person (a contractor's pay, an organizer's payout, a buyer's order) is published with that person's yes, and is otherwise shown as part of a total. Credentials and account numbers are never part of a cost.

- **A ceiling on our own take.** *Owner's lean, 2026-10-11: "I do like just making a small ratio"; the numbers wait until the company pays anyone ("I feel like I can put off this particular concept till I actually get paid?").* The highest pay in the company is a small, published multiple of the lowest. *Proposed, for when pay starts:* the multiple itself, the most the fee can be, a reserve target, and where surplus above that goes. The profit-sharing research (2026-10-11) is the starting material.

- **Notice, and a say, before a money rule changes.** *Proposed.* A change to a fee, a payout schedule or a refund rule is published with its reason before it takes effect, and the people it applies to can respond first.

- **A mission lock while it is cheap.** *Proposed; needs a lawyer.* The operating agreement says the company cannot be sold away from its purpose. Stronger forms (a purpose trust, an exit to the community) come later.

- **We report rooms, not reach.** *Proposed.* Beside the money we publish the counts principle 1 names: nights that happened, acts that got a second booking, reach-outs that got an answer.

Principle 7 is the check on all of these: a person who can leave with everything they built here is a person whose staying means something.

_Avoid_: engagement, growth loops, virality, follower counts as trust. These measure time spent in the app, not real-world connection.
