import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MailerPort } from "@th/ports/comms/mailer";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import { isUnclaimedBookingInquiry } from "@th/ports/repos/booking-requests";

import { parseInput } from "../../lib/io";
import { ORG_EDIT_ROLES } from "../../lib/rbac";
import { CLAIM_TOKEN_TTL_DAYS, DAY_MS } from "./constants";
import { fail } from "@th/errors";
import {
  generateClaimToken,
  isClaimTokenHashCollision,
} from "./_shared/claim-token";
import { sendClaimInviteEmail } from "./_shared/invite-email";
import { requirePlaceOwnership } from "./_shared/place-access";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const resendBookingRequestInviteInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    bookingRequestId: z.uuid(),
  })
  .strict();

export const resendBookingRequestInviteOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
    claimTokenExpiresAt: z.date(),
  })
  .strict();

export type ResendBookingRequestInviteInput = z.infer<
  typeof resendBookingRequestInviteInputSchema
>;
export type ResendBookingRequestInviteOutput = z.infer<
  typeof resendBookingRequestInviteOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ResendBookingRequestInviteDeps = {
  repos: Pick<Repos, "tx" | "bookingRequests" | "places" | "authz" | "audit">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** See respond-to-booking-request: direct MailerPort send, notify() unusable. */
  mailer?: MailerPort;
  publicAppUrl?: string | null;
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Venue-side resend of the invite-to-claim email for an ACCEPTED-but-unclaimed
 * anonymous booking request (booking-request-embed-button FR-007 "resend"
 * affordance). ROTATES the token: a fresh raw token + hash + full
 * `CLAIM_TOKEN_TTL_DAYS` expiry replace the previous one in a single CAS
 * update, so the old link dies immediately (single active token, NFR-003).
 *
 * Same authorization bar as respond (place ownership, ORG_EDIT_ROLES for
 * org-mediated access) — resending re-emails a bearer credential.
 *
 * Deliberately NO resend counter/cap and no idempotency key: rotation is
 * last-write-wins (each call invalidates the previous link, so replays can't
 * multiply live credentials) and abuse control belongs at the transport
 * rate-limit layer when the step-6 procedure lands.
 */
export async function resendBookingRequestInvite(
  deps: ResendBookingRequestInviteDeps,
  rawInput: unknown,
): Promise<ResendBookingRequestInviteOutput> {
  const input = parseInput(resendBookingRequestInviteInputSchema, rawInput);
  const logger = deps.logger?.child({
    useCase: "resendBookingRequestInvite",
  });

  const request = await deps.repos.bookingRequests.getById(
    input.bookingRequestId,
  );
  if (!request) {
    throw fail("BOOKING_REQUEST_NOT_FOUND");
  }

  if (request.direction !== "TO_VENUE") {
    // Invite-to-claim is anonymous-TO_VENUE machinery only (NFR-001):
    // TO_PERFORMER rows are always owned and never carry a claim token.
    throw fail("INVALID_STATUS", {
      meta: { reason: "wrong_direction", bookingRequestId: request.id },
    });
  }

  const place = await deps.repos.places.getById(request.placeId);
  if (!place) {
    throw fail("PLACE_NOT_FOUND");
  }

  // Same bar as respond: the invite email carries a bearer credential.
  await requirePlaceOwnership(deps.repos, place, input.actorHumanId, {
    requiredOrgRoles: ORG_EDIT_ROLES,
  });

  assertResendable(request);
  // CLAIM STATE, not the sender narrowing: since booking-inquirer-outreach an
  // unclaimed inquiry the venue has replied to carries a SHADOW owner pair, and
  // narrowing on the sender would take the "Resend invite" button away from
  // exactly the inquiries a venue engaged with. A genuinely owned row (never
  // had contact fields) and a claimed row (claimedAt stamped) both still fail.
  if (!isUnclaimedBookingInquiry(request) || request.contactEmail === null) {
    throw fail("INVALID_STATUS", {
      meta: { reason: "not_anonymous_unclaimed", bookingRequestId: request.id },
    });
  }
  const contactEmail = request.contactEmail;

  const now = deps.clock.now();
  const claimTokenExpiresAt = new Date(
    now.getTime() + CLAIM_TOKEN_TTL_DAYS * DAY_MS,
  );

  // Retry ONCE on the astronomically-unlikely claimTokenHash collision
  // (same documented choice as the anonymous accept fork).
  let token = generateClaimToken();
  let updated: BookingRequestRecord;
  try {
    updated = await rotateInTx(deps, input, token.tokenHash, {
      claimTokenExpiresAt,
      placeId: place.id,
      now,
    });
  } catch (error) {
    if (!isClaimTokenHashCollision(error)) throw error;
    token = generateClaimToken();
    updated = await rotateInTx(deps, input, token.tokenHash, {
      claimTokenExpiresAt,
      placeId: place.id,
      now,
    });
  }

  // Post-commit, best-effort (NFR-004) — never throws.
  await sendClaimInviteEmail(
    {
      mailer: deps.mailer,
      publicAppUrl: deps.publicAppUrl,
      logger: deps.logger,
      reportError: deps.reportError,
    },
    {
      useCase: "resendBookingRequestInvite",
      bookingRequestId: updated.id,
      placeId: place.id,
      placeName: place.name,
      actName: updated.actName,
      contactEmail,
      rawToken: token.rawToken,
      claimTokenExpiresAt,
    },
  );

  logger?.info("booking_requests.invite_resent", {
    bookingRequestId: updated.id,
    actorHumanId: input.actorHumanId,
  });

  return resendBookingRequestInviteOutputSchema.parse({
    bookingRequestId: updated.id,
    claimTokenExpiresAt,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function assertResendable(
  request: Pick<BookingRequestRecord, "status" | "claimTokenHash" | "claimedAt">,
): void {
  if (request.status !== "ACCEPTED") {
    throw fail("INVALID_STATUS", { meta: { reason: "not_accepted" } });
  }
  if (request.claimedAt !== null) {
    throw fail("INVALID_STATUS", { meta: { reason: "already_claimed" } });
  }
  if (request.claimTokenHash === null) {
    // ACCEPTED-anonymous rows always get a token at accept time; a missing
    // hash means this row never went through the invite flow.
    throw fail("INVALID_STATUS", { meta: { reason: "no_active_invite" } });
  }
}

async function rotateInTx(
  deps: ResendBookingRequestInviteDeps,
  input: ResendBookingRequestInviteInput,
  tokenHash: string,
  args: { claimTokenExpiresAt: Date; placeId: string; now: Date },
): Promise<BookingRequestRecord> {
  const { claimTokenExpiresAt, placeId, now } = args;

  return deps.repos.tx(async (tx) => {
    // Friendly in-tx re-check; the authoritative race guard is the
    // setClaimToken CAS (ACCEPTED + anonymous-unclaimed at write time), so a
    // concurrent claim between the outer read and this write loses nothing —
    // the rotation simply conflicts instead of resurrecting a consumed token.
    const fresh = await tx.bookingRequests.getById(input.bookingRequestId);
    if (!fresh) {
      throw fail("BOOKING_REQUEST_NOT_FOUND");
    }
    assertResendable(fresh);

    const updated = await tx.bookingRequests.setClaimToken({
      id: fresh.id,
      claimTokenHash: tokenHash,
      claimTokenExpiresAt,
      expectedFrom: ["ACCEPTED"],
    });

    await tx.audit.log({
      entity: "booking_request",
      entityId: fresh.id,
      action: "booking_request.invite_resent",
      data: {
        actorHumanId: input.actorHumanId,
        placeId,
        claimTokenExpiresAt,
        // Deliberately NO token material — not even the hash.
      },
      at: now,
    });

    return updated;
  });
}
