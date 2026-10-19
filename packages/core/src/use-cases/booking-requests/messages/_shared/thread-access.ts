import type { Repos } from "@th/ports/repos";
import type {
  BookingRequestRecord,
  BookingRequestsRepo,
} from "@th/ports/repos/booking-requests";
import type { BookingRequestMessagesRepo } from "@th/ports/repos/booking-request-messages";
import type { BookingThreadSide } from "@th/types/repos/booking-request-messages";
import type { TxRepos } from "@th/ports/repos";
import { fail } from "@th/errors";

import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
} from "@th/ports/repos/booking-requests";
import {
  ORG_ANY_ROLE,
  ORG_EDIT_ROLES,
  requireOrgMembership,
  requireOwnerAccess,
} from "../../../../lib/rbac";
import { requirePlaceOwnership } from "../../_shared/place-access";
import { orgsActorEdits } from "../../_shared/act-answerers";
import { ensurePlaceOwnerAccess } from "../../../places/_shared/ensure-place-owner-access";

// ─────────────────────────────────────────────────────────────────────────────
// Booking-thread authorization (booking-conversation FR-002 / venue-hierarchy
// FR-012) — TWO gates, split by read vs write:
//
//   - `ensureBookingThreadReader`      — reads (list-messages, mark-read,
//                                        list-attachments): membership-ANY,
//                                        mirroring the inbox
//                                        (`list-booking-requests`) exactly —
//                                        whoever can see a request in a list
//                                        can read its thread (2026-07-14
//                                        FR-002).
//   - `ensureBookingThreadParticipant` — writes (post-message, add/delete
//                                        attachment): the edit-role bar.
//
// The thread has exactly two human sides — the enum's `VENUE` slot is "the
// non-act party" in BOTH directions:
//   - TO_VENUE:     VENUE = the place's owners/staff;  PERFORMER = the act.
//   - TO_PERFORMER: VENUE = the SENDER organizer org;  PERFORMER = the act.
// SYSTEM authors messages but is never a client-postable side — every input
// schema in this module takes `BookingThreadSide` (VENUE | PERFORMER) only.
//
// The caller DECLARES its side (the UI always knows which surface it is on)
// and these helpers verify that claim; they never guess from memberships (a
// human who owns both sides would otherwise post ambiguously).
//
// WRITE gate per-direction rules (mirroring the existing authorizers
// verbatim):
//   - TO_VENUE + VENUE      → ensurePlaceOwnerAccess (org edit roles or a
//                             verified direct human owner — the venue
//                             management bar shared with spaces/calendars).
//   - TO_PERFORMER + VENUE  → requireOrgMembership(organizerOrgId,
//                             ORG_EDIT_ROLES) — the sender-control bar from
//                             create-organizer-booking-request.
//   - either + PERFORMER    → OWNED sender + requireOwnerAccess on the act
//                             pair (self for a human act, ORG_EDIT_ROLES for
//                             an org act) — exactly how
//                             respond-to-booking-request authorizes the act.
//                             ANONYMOUS senders have no signed-in performer
//                             participant (the guest thread token of the
//                             2026-07-14 spec is not built in this scope) →
//                             NOT_RESOURCE_OWNER.
//
// READ gate per-direction rules (mirroring `list-booking-requests` scopes
// verbatim):
//   - TO_VENUE + VENUE      → requirePlaceOwnership with NO requiredOrgRoles
//                             (scope: "venue" — any owning-org member or
//                             direct human owner).
//   - TO_PERFORMER + VENUE  → requireOrgMembership(organizerOrgId,
//                             ORG_ANY_ROLE) (scope: "organizer").
//   - either + PERFORMER    → OWNED sender + requireOwnerAccess with
//                             ORG_ANY_ROLE (scope: "performer" /
//                             "performer-inbox").
//
// UNCLAIMED INQUIRIES ARE REFUSED ON THE PERFORMER SIDE OF **BOTH** GATES, via
// `isUnclaimedBookingInquiry` and BEFORE the sender narrowing. Load-bearing,
// not a tidy-up (booking-inquirer-outreach, 2026-09-05):
//
//   Before venue→inquirer outreach existed, an unclaimed embed inquiry had a
//   NULL owner pair, so `getBookingRequestSender` returned `anonymous` and
//   every actor bounced off the `kind !== "owned"` throw. Outreach now attaches
//   a SHADOW owner pair to such a row on the venue's first reply, so the
//   narrowing reports `owned` and the gate collapses to
//   `actorHumanId === shadowHumanId` (rbac.ts `requireOwnerAccess`).
//
//   "But nobody can BE that shadow" is FALSE. `apps/api/src/auth/
//   shadow-upgrade.ts` mints a credential account onto a shadow AuthUser
//   straight from a sign-up body's password, and better-auth.ts sets
//   `requireEmailVerification: false` (its verification mail is explicitly
//   best-effort and non-blocking) — so SIGNING UP NEVER PROVES MAILBOX
//   CONTROL. Without this guard, anyone who types a stranger's address into a
//   public embed form, waits for the venue to reply, then signs up as that
//   address would read the venue's private replies and post as the performer.
//
//   The inquirer's legitimate route into the thread is the invite-to-claim
//   token (FR-007), the mechanism that DOES prove mailbox control; redeeming it
//   stamps `claimedAt` and this guard opens. Keep it consistent with the
//   identical guard in `withdraw-booking-request.ts`.
//
// An extra, READ-ONLY reader: side "ACT" (lineup-booking-requests v2, FR-008).
// A TAGGED act that has JOINED (CONFIRMED) a TO_VENUE request's LIVE bill may
// READ its thread — nothing more. For a tagged person that is the person;
// for a tagged GROUP (v3 L17) it is every member holding an org edit role
// (ORG_EDIT_ROLES) — the same people who may answer for the group:
//   - READ gate only. `ensureBookingThreadParticipant` (the write gate) takes
//     `BookingThreadSide` (VENUE | PERFORMER) and is unchanged, so an act can
//     never post, attach or delete — as "ACT" the input schemas refuse the
//     side, and as "PERFORMER" the owner check refuses the human (they are
//     not the sender).
//   - PENDING and DECLINED acts read nothing beyond their own invite; a SELF
//     row is the sender, who reads as PERFORMER; anyone else is refused.
//   - The ACT side sees what the VENUE side sees AND nothing sender-only or
//     venue-internal (list-messages drops both families for it).
// Read receipts are per-SIDE on the message rows, and an act is neither
// side, so `mark-read` is a no-op success for "ACT" (it must never clear the
// venue's or the sender's badge).
//
// There is NO third, STATUS gate, and adding one back would be a regression.
// An earlier `assertThreadWritable` closed the thread at DECLINED / WITHDRAWN /
// EXPIRED, which meant the moment a booking ended the two parties lost the only
// channel they had for it — "what happened with that Friday?" had nowhere to go
// once the row went terminal. The thread IS the booking's history, so it stays
// writable at EVERY status; who may write is decided purely by the two gates
// above. Status still governs the BOOKING (respond/withdraw keep their own CAS
// `expectedFrom` guards) — just never the conversation about it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who may READ a thread: the two parties ({@link BookingThreadSide}) plus
 * "ACT", a confirmed tagged artist on the bill — read-only (module header).
 * Never a writer's side: every write gate and write schema keeps
 * `BookingThreadSide`.
 */
export type BookingThreadReaderSide = BookingThreadSide | "ACT";

/**
 * READ gate: membership-any, exactly the bar that already shows the request
 * in a list surface. See the module header for the per-direction table.
 */
export async function ensureBookingThreadReader(
  repos: Repos,
  request: BookingRequestRecord,
  actorHumanId: string,
  side: BookingThreadReaderSide,
): Promise<void> {
  if (side === "ACT") {
    // Only TO_VENUE requests carry a bill (NFR-004). The person's own row
    // is read by its owner key — the ACTOR — so no one can borrow another
    // artist's spot; a group's spot only through an edit role in that group.
    if (
      request.direction !== "TO_VENUE" ||
      !(await actorReadsAsJoinedAct(repos, request.id, actorHumanId))
    ) {
      throw fail("NOT_RESOURCE_OWNER", {
        meta: { entity: "booking_request_thread" },
      });
    }
    return;
  }

  if (side === "VENUE") {
    if (request.direction === "TO_VENUE") {
      // Mirrors list-booking-requests scope:"venue": load the place, then
      // requirePlaceOwnership with NO requiredOrgRoles (membership-any).
      const place = await repos.places.getById(request.placeId);
      if (!place) {
        throw fail("PLACE_NOT_FOUND");
      }
      await requirePlaceOwnership(repos, place, actorHumanId);
      return;
    }
    // Mirrors scope:"organizer": org membership, any role.
    await requireOrgMembership({
      repos,
      orgId: request.organizerOrgId,
      actorHumanId,
      roles: ORG_ANY_ROLE,
    });
    return;
  }

  // PERFORMER side — mirrors scope:"performer"/"performer-inbox": owned
  // sender, self for a human act, org membership (any role) for an org act.
  //
  // UNCLAIMED INQUIRIES ARE REFUSED FIRST, ahead of the sender narrowing —
  // see the module header for why this cannot be left to `requireOwnerAccess`.
  if (isUnclaimedBookingInquiry(request)) {
    throw fail("NOT_RESOURCE_OWNER", {
      meta: { entity: "booking_request_thread" },
    });
  }
  const sender = getBookingRequestSender(request);
  if (sender.kind !== "owned") {
    throw fail("NOT_RESOURCE_OWNER", {
      meta: { entity: "booking_request_thread" },
    });
  }
  await requireOwnerAccess({
    repos,
    ownerType:
      sender.performerOwnerType === "human" ? "HUMAN" : "ORGANIZATION",
    ownerId: sender.performerOwnerId,
    actorHumanId,
    roles: ORG_ANY_ROLE,
  });
}

/**
 * The ACT reader's test: the actor is a TAGGED person who JOINED the live
 * bill, or holds an org edit role in a TAGGED group that joined it. The
 * person check is one owner-key read; only when it fails is the bill read
 * for joined groups (and memberships checked in ONE batched read). Removed
 * acts are off the bill (the port's default read) and read nothing.
 */
async function actorReadsAsJoinedAct(
  repos: Repos,
  bookingRequestId: string,
  actorHumanId: string,
): Promise<boolean> {
  const own = await repos.bookingRequests.getActForOwner({
    bookingRequestId,
    actOwnerType: "human",
    actOwnerId: actorHumanId,
  });
  if (own?.source === "TAGGED" && own.confirmation === "CONFIRMED") {
    return true;
  }
  const joinedGroupIds = (
    await repos.bookingRequests.listActsForRequests([bookingRequestId])
  )
    .filter(
      (act) =>
        act.source === "TAGGED" &&
        act.actOwnerType === "organization" &&
        act.actOwnerId !== null &&
        act.confirmation === "CONFIRMED",
    )
    .map((act) => act.actOwnerId as string);
  if (joinedGroupIds.length === 0) return false;
  const editable = await orgsActorEdits(repos, actorHumanId, joinedGroupIds);
  return editable.size > 0;
}

/** WRITE gate: the edit-role bar. See the module header. */
export async function ensureBookingThreadParticipant(
  repos: Repos,
  request: BookingRequestRecord,
  actorHumanId: string,
  side: BookingThreadSide,
): Promise<void> {
  if (side === "VENUE") {
    if (request.direction === "TO_VENUE") {
      await ensurePlaceOwnerAccess(repos, request.placeId, actorHumanId);
      return;
    }
    await requireOrgMembership({
      repos,
      orgId: request.organizerOrgId,
      actorHumanId,
      roles: ORG_EDIT_ROLES,
    });
    return;
  }

  // PERFORMER side — the act owner pair is the single source of truth, EXCEPT
  // that an unclaimed inquiry's owner pair is not a party (module header).
  if (isUnclaimedBookingInquiry(request)) {
    throw fail("NOT_RESOURCE_OWNER", {
      meta: { entity: "booking_request_thread" },
    });
  }
  const sender = getBookingRequestSender(request);
  if (sender.kind !== "owned") {
    throw fail("NOT_RESOURCE_OWNER", {
      meta: { entity: "booking_request_thread" },
    });
  }
  await requireOwnerAccess({
    repos,
    ownerType:
      sender.performerOwnerType === "human" ? "HUMAN" : "ORGANIZATION",
    ownerId: sender.performerOwnerId,
    actorHumanId,
    roles: ORG_EDIT_ROLES,
  });
}

/** See `spacesIn` in manage-spaces.ts — same unreachable-wiring guard. */
export function messagesIn(tx: TxRepos): BookingRequestMessagesRepo {
  if (!tx.bookingRequestMessages) {
    throw fail("NOT_CONFIGURED", {
      message: "bookingRequestMessages repo missing from tx",
    });
  }
  return tx.bookingRequestMessages;
}

/** Load + not-found guard shared by the thread/attachment use cases. */
export async function requireBookingRequest(
  bookingRequests: Pick<BookingRequestsRepo, "getById">,
  bookingRequestId: string,
): Promise<BookingRequestRecord> {
  const request = await bookingRequests.getById(bookingRequestId);
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }
  return request;
}
