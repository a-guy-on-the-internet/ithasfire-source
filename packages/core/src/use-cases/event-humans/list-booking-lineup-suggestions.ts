import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { parseInput } from "../../lib/io";
import { ensureOwnerOrCommunityModerator } from "../events/_shared/ensure-owner-or-community-moderator";
import {
  billIdentityOf,
  bookingRequestActRoleSchema,
  resolveBillIdentities,
} from "../booking-requests/_shared/bill-items";
import {
  findBillRequestForEvent,
  lineupRowIsAct,
} from "../booking-requests/_shared/bill-event";

// ─────────────────────────────────────────────────────────────────────────────
// listBookingLineupSuggestions (lineup-booking-requests v2, FR-006) — the
// "suggested from the booking" rows on an event's lineup step.
//
// The mint (`createEventFromAgreement`) attaches only the acts that said yes.
// A tagged artist who has not answered yet (PENDING) is NOT attached —
// consent carries through — but the editor should still see that the booking
// named them, so they surface here to attach by hand once they are sure. A
// CONFIRMED act that is not on the lineup (the editor took them off, or they
// were not attached for another reason) shows here too. DECLINED acts never
// do: they said no. A tagged act may be a person or (v3 L17/L18) a group;
// acts already on the lineup (same humanId, or same orgId for a group) are
// skipped. Sender-removed acts are off the bill and never suggested.
//
// THE LINK: event → Agreement (`findByLinkedEventId` — the finalized link
// first, then the pre-finalize draft anchor the mint stamps) → the booking
// request whose `agreementId` is that agreement (`findByAgreementId`). There
// is no `Event.agreementId`. An event that did not come out of a booking has
// no suggestions.
//
// AUTHZ: exactly the lineup editor's bar (`ensureOwnerOrCommunityModerator`,
// the gate `attachEventHuman` applies) — whoever may attach a suggestion may
// see it.
// ─────────────────────────────────────────────────────────────────────────────

export const listBookingLineupSuggestionsInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
  })
  .strict();

const bookingLineupSuggestionSchema = z
  .object({
    actId: z.uuid(),
    /** A person act: attach with `{ humanId }`. Null for a group. */
    humanId: z.uuid().nullable(),
    /** A group act (v3 L18): attach with `{ orgId }`. Null for a person. */
    orgId: z.uuid().nullable(),
    /** Null only when the act no longer resolves to a name. */
    displayName: z.string().nullable(),
    /** `/humans/{slug}` / `/orgs/{slug}` for a PUBLIC page, else null. */
    href: z.string().nullable(),
    /** PENDING = invited, has not answered — never render as joined. */
    confirmation: z.enum(["PENDING", "CONFIRMED"]),
    role: bookingRequestActRoleSchema,
    /** Label beside role OTHER (v3 L13) — attach passes it through. */
    customRoleLabel: z.string().nullable(),
    /**
     * The act's place on the bill AS THE VENUE SIDE SEES IT (0 = headliner):
     * dense over the live bill with passed acts dropped — the event's editor
     * is the venue side, so a raw stored position's gap would tell them an
     * act passed (v3 FR-004 / NFR-002), and a sender-removed act leaves one
     * too.
     */
    sortOrder: z.number().int().nonnegative(),
  })
  .strict();

export const listBookingLineupSuggestionsOutputSchema = z
  .object({
    /** The originating booking request; null when the event has none. */
    bookingRequestId: z.uuid().nullable(),
    suggestions: z.array(bookingLineupSuggestionSchema),
  })
  .strict();

export type ListBookingLineupSuggestionsInput = z.infer<
  typeof listBookingLineupSuggestionsInputSchema
>;
export type ListBookingLineupSuggestionsOutput = z.infer<
  typeof listBookingLineupSuggestionsOutputSchema
>;

export type ListBookingLineupSuggestionsDeps = {
  repos: Pick<
    Repos,
    | "events"
    | "eventHumans"
    | "agreements"
    | "bookingRequests"
    | "humans"
    | "organizations"
    | "entityPages"
    | "authz"
  >;
  /** Community-moderator arm of the lineup gate — required, as on attach. */
  authz: Pick<AuthZPort, "hasStaffRole">;
  logger?: LoggerPort;
};

export async function listBookingLineupSuggestions(
  deps: ListBookingLineupSuggestionsDeps,
  rawInput: unknown,
): Promise<ListBookingLineupSuggestionsOutput> {
  const input = parseInput(listBookingLineupSuggestionsInputSchema, rawInput);

  const event = await deps.repos.events.getById(input.eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }
  await ensureOwnerOrCommunityModerator(
    { repos: deps.repos, authz: deps.authz },
    event,
    input.actorHumanId,
  );

  const none = listBookingLineupSuggestionsOutputSchema.parse({
    bookingRequestId: null,
    suggestions: [],
  });

  // Only TO_VENUE requests carry a bill (NFR-004).
  const request = await findBillRequestForEvent(deps.repos, event.id);
  if (!request) return none;

  const [bill, lineup] = await Promise.all([
    deps.repos.bookingRequests.listActsForRequests([request.id]),
    deps.repos.eventHumans.listByEvent(event.id),
  ]);
  const candidates = bill.filter(
    (act) =>
      act.source === "TAGGED" &&
      act.actOwnerType !== null &&
      act.actOwnerId !== null &&
      (act.confirmation === "PENDING" || act.confirmation === "CONFIRMED") &&
      !lineup.some((row) =>
        lineupRowIsAct(row, {
          ownerType: act.actOwnerType as "human" | "organization",
          ownerId: act.actOwnerId as string,
        }),
      ),
  );
  const identities = await resolveBillIdentities(deps.repos, candidates);
  // Positions over the venue-facing bill: live (the port's default) and not
  // passed, in the port's order, numbered without gaps.
  const venuePosition = new Map(
    bill
      .filter((act) => act.confirmation !== "DECLINED")
      .map((act, index) => [act.id, index] as const),
  );

  return listBookingLineupSuggestionsOutputSchema.parse({
    bookingRequestId: request.id,
    suggestions: candidates.map((act) => {
      const identity = billIdentityOf(act, identities);
      const isGroup = act.actOwnerType === "organization";
      return {
        actId: act.id,
        humanId: isGroup ? null : act.actOwnerId,
        orgId: isGroup ? act.actOwnerId : null,
        displayName: identity.displayName,
        href: identity.href,
        confirmation: act.confirmation,
        role: act.role,
        customRoleLabel:
          act.role === "OTHER" ? (act.customRoleLabel ?? null) : null,
        sortOrder: venuePosition.get(act.id) ?? 0,
      };
    }),
  });
}
