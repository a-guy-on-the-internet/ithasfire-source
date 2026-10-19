import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";
import type { SetBookingRequestClaimTokenInput } from "@th/types/repos/booking-requests";

import { resendBookingRequestInvite } from "../resend-booking-request-invite";
import type { ResendBookingRequestInviteDeps } from "../resend-booking-request-invite";
import {
  ACTOR_ID,
  NOW,
  ORG_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
} from "./helpers";

const PUBLIC_APP_URL = "https://ithasfire.test";
const OLD_TOKEN_HASH = createHash("sha256")
  .update("old-raw-token", "utf8")
  .digest("hex");
const OLD_EXPIRY = new Date("2026-06-20T12:00:00.000Z");

/** ACCEPTED-but-unclaimed anonymous request holding the previous token. */
function buildInvitedRequest(
  overrides: Partial<BookingRequestRecord> = {},
): BookingRequestRecord {
  return buildBookingRequestRecord({
    performerOwnerType: null,
    performerOwnerId: null,
    contactName: "The Basement Tapes",
    contactEmail: "band@example.com",
    actName: "The Basement Tapes",
    source: "EMBED",
    status: "ACCEPTED",
    respondedAt: new Date("2026-06-09T12:00:00.000Z"),
    claimTokenHash: OLD_TOKEN_HASH,
    claimTokenExpiresAt: OLD_EXPIRY,
    ...overrides,
  });
}

type BuildDepsOptions = {
  request?: BookingRequestRecord | null;
  place?: PlaceRecord | null;
  memberships?: OrgMembership[];
  mailerFails?: boolean;
  claimTokenCollisions?: number;
};

function buildDeps(options: BuildDepsOptions = {}) {
  let current =
    options.request === undefined ? buildInvitedRequest() : options.request;
  const place =
    options.place === undefined ? buildPlaceRecord() : options.place;
  let collisionsRemaining = options.claimTokenCollisions ?? 0;

  const bookingRequests = {
    getById: vi.fn(async () => current),
    setClaimToken: vi.fn(async (input: SetBookingRequestClaimTokenInput) => {
      if (collisionsRemaining > 0) {
        collisionsRemaining -= 1;
        throw {
          code: "conflict",
          message: "claim_token_hash_collision",
        } as const;
      }
      if (
        !current ||
        !input.expectedFrom.includes(current.status) ||
        current.performerOwnerId !== null ||
        current.claimedAt !== null
      ) {
        throw {
          code: "conflict",
          message: "booking_request_status_changed",
        } as const;
      }
      current = {
        ...current,
        claimTokenHash: input.claimTokenHash,
        claimTokenExpiresAt: input.claimTokenExpiresAt,
      };
      return current;
    }),
  };
  const places = { getById: vi.fn(async () => place) };
  const authz = {
    getOrgMemberships: vi.fn(async () => options.memberships ?? []),
  };
  const audit = { log: vi.fn(async () => {}) };

  const mocks = { bookingRequests, places, authz, audit };

  const tx = vi.fn(async <R,>(fn: (t: unknown) => Promise<R>): Promise<R> => {
    const snapshot = current;
    try {
      return await fn(mocks);
    } catch (error) {
      current = snapshot;
      throw error;
    }
  });

  const mailerSend = vi.fn(async (_input: unknown) => {
    if (options.mailerFails) throw new Error("smtp down");
    return { result: { id: "msg-1", status: "sent" } };
  });
  const mailer = {
    send: mailerSend,
    sendBatch: vi.fn(),
    health: vi.fn(),
  } as unknown as MailerPort;
  const reportError = vi.fn();

  const deps: ResendBookingRequestInviteDeps = {
    repos: {
      ...mocks,
      tx,
    } as unknown as ResendBookingRequestInviteDeps["repos"],
    clock: { now: () => NOW },
    mailer,
    publicAppUrl: PUBLIC_APP_URL,
    reportError,
  };

  return { deps, mocks, mailerSend, reportError, readCurrent: () => current };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function extractRawToken(sendMock: { mock: { calls: unknown[][] } }): string {
  const call = sendMock.mock.calls.at(-1)?.[0] as {
    template: { variables: { claimUrl: string } };
  };
  const claimUrl = call.template.variables.claimUrl;
  const match = claimUrl.match(/\/booking-requests\/claim\/([A-Za-z0-9_-]+)$/);
  expect(match, `claimUrl shape: ${claimUrl}`).not.toBeNull();
  return match![1]!;
}

describe("resendBookingRequestInvite", () => {
  it("rotates the token (old hash replaced), stamps a fresh 30-day expiry, and re-emails the claim link", async () => {
    const { deps, mocks, mailerSend, readCurrent } = buildDeps();

    const expectedExpiry = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    const result = await resendBookingRequestInvite(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(result).toEqual({
      bookingRequestId: REQUEST_ID,
      claimTokenExpiresAt: expectedExpiry,
    });

    // Single active token (NFR-003): the stored hash is a NEW one.
    const write = mocks.bookingRequests.setClaimToken.mock.calls[0]![0];
    expect(write.claimTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(write.claimTokenHash).not.toBe(OLD_TOKEN_HASH);
    expect(write.claimTokenExpiresAt).toEqual(expectedExpiry);
    expect(write.expectedFrom).toEqual(["ACCEPTED"]);
    expect(readCurrent()?.claimTokenHash).toBe(write.claimTokenHash);

    // Email carries the NEW raw token; new-generation idempotency key so the
    // resend isn't deduped away by the original accept's send.
    const rawToken = extractRawToken(mailerSend);
    expect(sha256Hex(rawToken)).toBe(write.claimTokenHash);
    expect(mailerSend.mock.calls[0]![0]).toMatchObject({
      to: { to: "band@example.com" },
      template: expect.objectContaining({ key: "booking.invite_to_claim" }),
      idempotencyKey: `booking-invite:${REQUEST_ID}:${expectedExpiry.getTime()}`,
    });

    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.invite_resent" }),
    );
    // No token material in the audit trail.
    const auditJson = JSON.stringify(mocks.audit.log.mock.calls);
    expect(auditJson).not.toContain(rawToken);
    expect(auditJson).not.toContain(write.claimTokenHash);
  });

  it("email failure is swallowed AND reported; the rotation still succeeds (NFR-004)", async () => {
    const { deps, mocks, reportError } = buildDeps({ mailerFails: true });

    const result = await resendBookingRequestInvite(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(result.bookingRequestId).toBe(REQUEST_ID);
    expect(mocks.bookingRequests.setClaimToken).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "resendBookingRequestInvite" },
      extra: {
        bookingRequestId: REQUEST_ID,
        placeId: buildPlaceRecord().id,
      },
    });
  });

  it("retries once with a fresh token on a claimTokenHash collision", async () => {
    const { deps, mocks, mailerSend } = buildDeps({ claimTokenCollisions: 1 });

    await resendBookingRequestInvite(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(mocks.bookingRequests.setClaimToken).toHaveBeenCalledTimes(2);
    const rawToken = extractRawToken(mailerSend);
    expect(sha256Hex(rawToken)).toBe(
      mocks.bookingRequests.setClaimToken.mock.calls[1]![0].claimTokenHash,
    );
  });

  it("rejects a not-yet-accepted request", async () => {
    const { deps, mocks } = buildDeps({
      request: buildInvitedRequest({ status: "PENDING" }),
    });

    await expect(
      resendBookingRequestInvite(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    expect(mocks.bookingRequests.setClaimToken).not.toHaveBeenCalled();
  });

  it("rejects an already-claimed request (owner backfilled → owned sender)", async () => {
    const { deps, mocks } = buildDeps({
      request: buildInvitedRequest({
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
        claimedAt: new Date("2026-06-11T00:00:00.000Z"),
        claimTokenHash: null,
        claimTokenExpiresAt: null,
      }),
    });

    await expect(
      resendBookingRequestInvite(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    expect(mocks.bookingRequests.setClaimToken).not.toHaveBeenCalled();
  });

  it("rejects an owned (never-anonymous) ACCEPTED request", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({
        status: "ACCEPTED",
        // Owned sender, no invite ever issued.
        claimTokenHash: null,
      }),
    });

    await expect(
      resendBookingRequestInvite(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });
    expect(mocks.bookingRequests.setClaimToken).not.toHaveBeenCalled();
  });

  it("rejects an anonymous ACCEPTED row with no active invite token", async () => {
    const { deps } = buildDeps({
      request: buildInvitedRequest({
        claimTokenHash: null,
        claimTokenExpiresAt: null,
      }),
    });

    await expect(
      resendBookingRequestInvite(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_STATUS",
      meta: { reason: "no_active_invite" },
    });
  });

  it("rejects a non-owner with forbidden", async () => {
    const { deps } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: ["12121212-1212-4121-8121-121212121212"],
      }),
    });

    await expect(
      resendBookingRequestInvite(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("rejects an org VIEWER (resend re-emails a bearer credential — edit roles required)", async () => {
    const { deps, mailerSend } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      }),
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" }],
    });

    await expect(
      resendBookingRequestInvite(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(mailerSend).not.toHaveBeenCalled();
  });

  it("throws not_found for a missing request", async () => {
    const { deps } = buildDeps({ request: null });

    await expect(
      resendBookingRequestInvite(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
  });
});
