import { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";

import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";

import { parseInput } from "../../lib/io";
import {
  actAnswerBlockedReasonSchema,
  judgeActAnswer,
  type ActAnswerBlockedReason,
} from "./answer-booking-request-act";
import { taggedActsActorAnswersFor } from "./_shared/act-answerers";
import { findBookingEventForBill, lineupRowIsAct } from "./_shared/bill-event";
import {
  billIdentityOf,
  bookingRequestActConfirmationSchema,
  bookingRequestActRoleSchema,
  bookingRequestActSourceSchema,
  resolveBillIdentities,
} from "./_shared/bill-items";
import { bookingRequestStatusSchema } from "./list-booking-requests";

// ─────────────────────────────────────────────────────────────────────────────
// getBookingRequestActInvite — what the one-tap confirm / decline landing
// (`/bookings/acts/{requestId}`, lineup-booking-requests v2 FR-003) shows a
// TAGGED artist about the bill they were put on.
//
// WHO: whoever answers for a TAGGED act on the live bill, in ANY
// confirmation state (an act that passed can still open the link and see
// that it passed): the tagged person themselves, and — v3 L17 — any member
// with an org edit role of a tagged GROUP, who answers "as" it
// (`_shared/act-answerers.ts`). A viewer who answers for several acts on one
// request (themselves and a group, or two groups) gets ALL of them, each
// saying which identity it is (`identities`). Everyone else — and a missing
// / non-TO_VENUE request — gets the same `BOOKING_REQUEST_NOT_FOUND`, no
// meta (no enumeration of requests or of who is on them).
//
// WHAT: enough to decide — venue, who is asking, the nights, their own spot
// — and the OTHER acts only where they have said yes (CONFIRMED rows: joined,
// and by-name which always are). An invited or passed act's name is theirs
// to reveal, not the sender's: the viewer never learns who else was asked or
// who said no. Free-text acts are plain names (never a link). Names and
// links follow the bill's rules (`_shared/bill-items.ts`: PUBLIC pages only).
//
// POSITIONS (v3 FR-013): every `sortOrder` here is the act's place among the
// acts THIS VIEWER can see (the others listed + their own rows), renumbered
// 0..n-1 without gaps — never the stored column, and no total is returned:
// either would tell the viewer how many invited acts are hidden. There is no
// sent-at time either.
//
// `canConfirm` / `canDecline` and the matching `…BlockedReason` come from
// the same rule the mutations enforce (`judgeActAnswer`), so the page never
// offers a button the server refuses — and can say why when it does not.
// ─────────────────────────────────────────────────────────────────────────────

export const getBookingRequestActInviteInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
  })
  .strict();

const inviteOtherActSchema = z
  .object({
    source: bookingRequestActSourceSchema,
    /** Null only when a platform act's name no longer resolves. */
    displayName: z.string().nullable(),
    /** PUBLIC page link (`/humans/…`, `/orgs/…`); ALWAYS null for EXTERNAL. */
    href: z.string().nullable(),
    role: bookingRequestActRoleSchema,
    /** Label beside role OTHER (v3 L13); null otherwise. */
    customRoleLabel: z.string().nullable(),
    /** Dense position among what this viewer sees (module header). */
    sortOrder: z.number().int().nonnegative(),
  })
  .strict();

const inviteMyActSchema = z
  .object({
    id: z.uuid(),
    confirmation: bookingRequestActConfirmationSchema,
    role: bookingRequestActRoleSchema,
    customRoleLabel: z.string().nullable(),
    /** Dense position among what this viewer sees (module header). */
    sortOrder: z.number().int().nonnegative(),
    respondedAt: z.date().nullable(),
  })
  .strict();

/** Which identity a spot belongs to: the viewer, or a group they answer for. */
const inviteAnsweringAsSchema = z
  .object({
    ownerType: z.enum(["human", "organization"]),
    ownerId: z.uuid(),
    /** The identity's bill name (PUBLIC page name, else its own name). */
    displayName: z.string().nullable(),
    href: z.string().nullable(),
  })
  .strict();

/** One spot the viewer answers for, with the answers open to it. */
const inviteIdentitySchema = z
  .object({
    answeringAs: inviteAnsweringAsSchema,
    myAct: inviteMyActSchema,
    canConfirm: z.boolean(),
    canDecline: z.boolean(),
    confirmBlockedReason: actAnswerBlockedReasonSchema.nullable(),
    declineBlockedReason: actAnswerBlockedReasonSchema.nullable(),
  })
  .strict();

export const getBookingRequestActInviteOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    status: bookingRequestStatusSchema,
    intent: z.enum(["PERFORM", "RENT", "USE"]),
    venue: z
      .object({
        placeId: z.uuid(),
        name: z.string().nullable(),
        /**
         * The place's PUBLIC EntityPage slug (`/p/{slug}`), null when it has
         * none. Never `Place.slug` — that is a directory key, not a URL.
         */
        pageSlug: z.string().nullable(),
      })
      .strict(),
    /** The sender (organizer of the ask) — the human or org who tagged you. */
    sender: z
      .object({
        displayName: z.string().nullable(),
        /** Their PUBLIC page (`/humans/…` / `/orgs/…`), else null. */
        href: z.string().nullable(),
      })
      .strict(),
    preferredDates: z.array(z.string()),
    /**
     * The PRIMARY spot — `identities[0]` (the viewer's own person row when
     * they are tagged themselves, else the first group they answer for).
     * `myAct`, `answeringAs` and the four answer fields below mirror it, so
     * a single-identity page reads them directly.
     */
    answeringAs: inviteAnsweringAsSchema,
    myAct: inviteMyActSchema,
    /**
     * EVERY spot the viewer answers for on this request (v3 L17), primary
     * first, then in bill order. Answer one with `joinAct` / `passAct`,
     * passing `asOrgId` for a group.
     */
    identities: z.array(inviteIdentitySchema).min(1),
    /**
     * Other acts that have JOINED (SELF / EXTERNAL always count), in bill
     * order — never the viewer's own spots (those are `identities`).
     */
    otherActs: z.array(inviteOtherActSchema),
    /**
     * An event has been minted from this request. Its lineup is the editor's:
     * a confirmation now attaches nothing (the editor sees a suggestion).
     */
    eventMinted: z.boolean(),
    canConfirm: z.boolean(),
    canDecline: z.boolean(),
    /**
     * Why confirm is refused, null when it is allowed OR is already the
     * answer (a repeat is an idempotent no-op, not a refusal).
     */
    confirmBlockedReason: actAnswerBlockedReasonSchema.nullable(),
    /** Same, for decline (`on_lineup` once a CONFIRMED act is on the event). */
    declineBlockedReason: actAnswerBlockedReasonSchema.nullable(),
  })
  .strict();

export type GetBookingRequestActInviteInput = z.infer<
  typeof getBookingRequestActInviteInputSchema
>;
export type GetBookingRequestActInviteOutput = z.infer<
  typeof getBookingRequestActInviteOutputSchema
>;

export type GetBookingRequestActInviteDeps = {
  repos: Pick<
    Repos,
    | "bookingRequests"
    | "humans"
    | "organizations"
    | "entityPages"
    | "agreements"
    | "events"
    // A withdrawal is refused only when the artist is on the minted lineup.
    | "eventHumans"
    // Which tagged GROUPS the viewer answers for (org edit role, v3 L17).
    | "authz"
  >;
  logger?: LoggerPort;
};

export async function getBookingRequestActInvite(
  deps: GetBookingRequestActInviteDeps,
  rawInput: unknown,
): Promise<GetBookingRequestActInviteOutput> {
  const input = parseInput(getBookingRequestActInviteInputSchema, rawInput);

  const request = await deps.repos.bookingRequests.getById(
    input.bookingRequestId,
  );
  if (!request || request.direction !== "TO_VENUE") {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }

  // The live bill, then the viewer's own spots on it: their person row and
  // every group row they edit. None → the same not-found a stranger gets.
  const bill = await deps.repos.bookingRequests.listActsForRequests([
    request.id,
  ]);
  const answerable = await taggedActsActorAnswersFor(
    deps.repos,
    input.actorHumanId,
    bill,
  );
  if (answerable.length === 0) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }
  // Primary first: the viewer tagged as themselves, then groups in bill order.
  const mine = [
    ...answerable.filter((act) => act.actOwnerType === "human"),
    ...answerable.filter((act) => act.actOwnerType !== "human"),
  ];
  const mineIds = new Set(mine.map((act) => act.id));

  const [placePage, eventId] = await Promise.all([
    deps.repos.entityPages.getByOwner("PLACE", request.placeId),
    findBookingEventForBill(deps.repos, request),
  ]);

  // What this viewer sees, in bill order: JOINED acts (CONFIRMED rows) and
  // their own spots in any state. Positions are counted over exactly this.
  const visible = bill.filter(
    (act) => mineIds.has(act.id) || act.confirmation === "CONFIRMED",
  );
  const positionOf = new Map(visible.map((act, index) => [act.id, index]));
  const others = visible.filter((act) => !mineIds.has(act.id));

  // The sender resolves through the SAME identity pass as the acts, so the
  // name on "who is asking" matches the name on their SELF row. An
  // unclaimed inquiry never tags anyone, but its (shadow) pair must not
  // become a name either — its identity is the contact it typed.
  const sender = getBookingRequestSender(request);
  const senderAct =
    sender.kind === "owned" && !isUnclaimedBookingInquiry(request)
      ? {
          source: "SELF" as const,
          actOwnerType: sender.performerOwnerType,
          actOwnerId: sender.performerOwnerId,
          externalName: null,
        }
      : null;
  const identities = await resolveBillIdentities(deps.repos, [
    ...others,
    ...mine,
    ...(senderAct ? [senderAct] : []),
  ]);
  const senderIdentity = senderAct
    ? billIdentityOf(senderAct, identities)
    : {
        // Anonymous, or unclaimed with a shadow pair: the name it typed.
        displayName:
          sender.kind === "owned" ? request.contactName : sender.contactName,
        href: null,
      };

  const eventMinted = eventId !== null;
  // The same predicate the withdrawal enforces (`isActOnBookingEventLineup`),
  // read once and only when it can matter: a JOINED spot and an existing
  // event.
  const lineup =
    eventId !== null && mine.some((act) => act.confirmation === "CONFIRMED")
      ? await deps.repos.eventHumans.listByEvent(eventId)
      : [];

  const spots = mine.map((act) => {
    const owner = {
      ownerType: act.actOwnerType as "human" | "organization",
      ownerId: act.actOwnerId as string,
    };
    const context = {
      requestStatus: request.status,
      actOnEventLineup:
        act.confirmation === "CONFIRMED" &&
        lineup.some((row) => lineupRowIsAct(row, owner)),
    };
    const answer = (to: "CONFIRMED" | "DECLINED") => {
      const verdict = judgeActAnswer(act.confirmation, to, context);
      return {
        can: verdict.kind === "write",
        blockedReason: (verdict.kind === "refuse"
          ? verdict.reason
          : null) satisfies ActAnswerBlockedReason | null,
      };
    };
    const confirm = answer("CONFIRMED");
    const decline = answer("DECLINED");
    const identity = billIdentityOf(act, identities);
    return {
      answeringAs: {
        ...owner,
        displayName: identity.displayName,
        href: identity.href,
      },
      myAct: {
        id: act.id,
        confirmation: act.confirmation,
        role: act.role,
        customRoleLabel: labelOf(act),
        sortOrder: positionOf.get(act.id) ?? 0,
        respondedAt: act.respondedAt,
      },
      canConfirm: confirm.can,
      canDecline: decline.can,
      confirmBlockedReason: confirm.blockedReason,
      declineBlockedReason: decline.blockedReason,
    };
  });
  const [primary] = spots;
  // Unreachable (`mine` is non-empty above) — keeps the type honest.
  if (!primary) throw fail("BOOKING_REQUEST_NOT_FOUND");

  return getBookingRequestActInviteOutputSchema.parse({
    bookingRequestId: request.id,
    status: request.status,
    intent: request.intent,
    venue: {
      placeId: request.placeId,
      name: request.placeName,
      pageSlug:
        placePage && placePage.visibility === "PUBLIC" ? placePage.slug : null,
    },
    sender: senderIdentity,
    preferredDates: request.preferredDates,
    answeringAs: primary.answeringAs,
    myAct: primary.myAct,
    identities: spots,
    otherActs: others.map((act) => {
      const identity = billIdentityOf(act, identities);
      return {
        source: act.source,
        displayName: identity.displayName,
        href: identity.href,
        role: act.role,
        customRoleLabel: labelOf(act),
        sortOrder: positionOf.get(act.id) ?? 0,
      };
    }),
    eventMinted,
    canConfirm: primary.canConfirm,
    canDecline: primary.canDecline,
    confirmBlockedReason: primary.confirmBlockedReason,
    declineBlockedReason: primary.declineBlockedReason,
  });
}

/** The label only means something beside OTHER (SQL CHECK; v3 L13). */
function labelOf(act: {
  role: string;
  customRoleLabel?: string | null;
}): string | null {
  return act.role === "OTHER" ? (act.customRoleLabel ?? null) : null;
}
