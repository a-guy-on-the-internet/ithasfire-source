import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { ensurePlaceActive } from "../../events/_shared/place-access";
import {
  planAgreementMint,
  type AgreementMintPlan,
  type PlanAgreementMintArgs,
} from "./agreement-mint-plan";

// ─────────────────────────────────────────────────────────────────────────────
// THE BOOKING PRE-FLIGHT (booking-the-night, review rounds 4–6).
//
// STANDING PRINCIPLE: every deterministic refusal the post-commit mint can
// raise is checked read-only BEFORE the line moves, on every path that takes
// a line. Taking a line releases every competitor with `lost_date`, which
// cannot be undone; a booking that was always going to fail must fail first.
//
// The refusals are not listed here: they are the MINT'S OWN plan
// (`planAgreementMint`, agreement-mint-plan.ts), which the mint itself calls
// and then executes. This wrapper adds the one rule that is about the NIGHT
// rather than the event — a suspended or retired place books no night,
// whether or not a mint follows (PLACE_NOT_ACTIVE; on the sender's side
// PLACE_NOT_TAKING_BOOKINGS, no meta) — and the side the codes are for.
//
// Called by every path that takes a line:
//   - "Agree & book"            respond-to-booking-agreement → agreeAndBook
//                               (side "sender", mode "night", no actor: the
//                               mint runs after commit as a stand-in, and its
//                               actor / quota failures are reported and
//                               retried through "Create event");
//   - book without terms        book-night-without-terms (side "venue", mode
//                               "hold", the booking venue human);
//   - the manual "Create event" create-event-from-agreement →
//                               bookManualMintNight (side "venue", mode
//                               "manual"), which is also how
//                               confirmVenueEvent's request variant books.
//
// Any refusal that can still arrive after the commit (a race with these
// reads) is reported through a guarded `reportError`
// (`reportPostCommitRefusal`).
// ─────────────────────────────────────────────────────────────────────────────

export async function assertBookingPreflight(
  repos: Parameters<typeof planAgreementMint>[0] & Pick<Repos, "events">,
  args: PlanAgreementMintArgs,
): Promise<AgreementMintPlan> {
  if (args.place && args.place.status !== "ACTIVE") {
    if (args.side === "sender") throw fail("PLACE_NOT_TAKING_BOOKINGS");
    ensurePlaceActive(args.place);
  }
  return planAgreementMint(repos, args);
}
