import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { makeBookingRequestsRepo } from "../booking-requests";
import type { PrismaClientOrTx } from "../types";

/**
 * Query-shape coverage for the venue→inquirer outreach writes
 * (booking-inquirer-outreach, 2026-09-05). Every property that matters here
 * lives in the WHERE clause, so the assertion is on the query Prisma is asked
 * to run — the same posture as `booking-requests-list-for-places.test.ts`.
 *
 * What must hold:
 *  - `attachInquirerOwner` only ever touches an OWNERLESS, UNCLAIMED,
 *    contact-bearing row (idempotence + the DB sender-identity CHECK), and
 *    maps a P2002 on "BookingRequest_open_pair_key" to the same
 *    `duplicate_open_request` shape `create` uses;
 *  - `setInquirerEmailMessageId` is first-write-wins, so two concurrent
 *    replies cannot leave the mail thread root oscillating;
 *  - `markInquirerEmailUndeliverable` is address-keyed but NARROWLY scoped
 *    (mailed + reachable + unclaimed) and MONOTONIC, so one bounce cannot fan out
 *    across venues we never mailed, and an out-of-order provider replay cannot
 *    resurrect a stale status;
 *  - `findOpenByContactEmailAndPlace` is scoped by CLAIM STATE, not by a null
 *    owner pair — the shadow flip drops a row out of the anonymous partial
 *    index, and this pre-check is what keeps "one open inquiry per (place,
 *    email)" true across that window.
 */

const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const PLACE_ID = "33333333-3333-4333-8333-333333333333";
const SHADOW_HUMAN_ID = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Minimal row shape `toRecord` needs. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    direction: "TO_VENUE",
    placeId: PLACE_ID,
    organizerOrgId: null,
    attachedEventId: null,
    calendarId: null,
    performerOwnerType: "human",
    performerOwnerId: SHADOW_HUMAN_ID,
    contactName: "Jo Rivera",
    contactEmail: "jo@example.com",
    source: "EMBED",
    embedId: null,
    claimTokenHash: null,
    claimTokenExpiresAt: null,
    claimedAt: null,
    inquirerEmailMessageId: null,
    inquirerEmailUndeliverableAt: null,
    inquirerEmailUndeliverableStatus: null,
    message: "hello",
    preferredDates: ["2026-07-10"],
    expectedDraw: null,
    genre: null,
    links: [],
    tags: [],
    assigneeHumanId: null,
    taxFormStatus: "NONE",
    lastMessageAt: null,
    intent: "PERFORM",
    spaceId: null,
    requestedStartsAt: null,
    requestedEndsAt: null,
    purpose: null,
    expectedAttendance: null,
    originEventId: null,
    parkedUnclaimedAt: null,
    actName: null,
    lineupSize: null,
    setLengthMinutes: null,
    contactPhone: null,
    techNeeds: null,
    feeType: null,
    feeAmountCents: null,
    feeCurrency: null,
    linkMusic: null,
    linkVideo: null,
    linkSocial: null,
    linkEpk: null,
    status: "PENDING",
    viewedAt: null,
    respondedAt: null,
    declineReason: null,
    agreementId: null,
    verifiedStatsSnapshot: null,
    expiresAt: new Date("2026-06-24T12:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    place: { name: "The Ember Room" },
    organizerOrg: null,
    attachedEvent: null,
    calendar: null,
    ...overrides,
  };
}

function bookingPrisma(options: {
  updateManyImpl?: () => Promise<{ count: number }>;
  findUniqueRow?: unknown;
  findFirstRow?: unknown;
}) {
  const updateMany = vi.fn(
    options.updateManyImpl ?? (async () => ({ count: 1 })),
  );
  // The adapter's shared `refetch` uses findUniqueOrThrow.
  const findUniqueOrThrow = vi.fn(async () => options.findUniqueRow ?? row());
  const findFirst = vi.fn(async () => options.findFirstRow ?? null);
  const prisma = {
    bookingRequest: { updateMany, findUniqueOrThrow, findFirst },
  } as unknown as PrismaClientOrTx;
  return { prisma, updateMany, findUniqueOrThrow, findFirst };
}

describe("bookingRequests.attachInquirerOwner", () => {
  it("only touches an OWNERLESS, UNCLAIMED, contact-bearing row", async () => {
    const { prisma, updateMany } = bookingPrisma({});

    await makeBookingRequestsRepo(prisma).attachInquirerOwner({
      id: REQUEST_ID,
      performerOwnerType: "human",
      performerOwnerId: SHADOW_HUMAN_ID,
    });

    const args = updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(args.where).toEqual({
      id: REQUEST_ID,
      // Idempotence: a second venue reply matches zero rows.
      performerOwnerId: null,
      // NOT a claim — the token redeem stays the only way to attach a real
      // party, and every accept/mint gate keys off `claimedAt`.
      claimedAt: null,
      // Keeps the write inside the anonymous family, and with the
      // all-or-nothing owner pair keeps "BookingRequest_sender_identity_check"
      // satisfied.
      contactEmail: { not: null },
    });
    // The contact fields are NOT cleared — the venue inbox's mailto affordance
    // (embed spec FR-006) reads them.
    expect(args.data).toEqual({
      performerOwnerType: "human",
      performerOwnerId: SHADOW_HUMAN_ID,
    });
  });

  it("returns null (not a throw) when the CAS matches nothing", async () => {
    const { prisma, findUniqueOrThrow } = bookingPrisma({
      updateManyImpl: async () => ({ count: 0 }),
    });

    const result = await makeBookingRequestsRepo(prisma).attachInquirerOwner({
      id: REQUEST_ID,
      performerOwnerType: "human",
      performerOwnerId: SHADOW_HUMAN_ID,
    });

    expect(result).toBeNull();
    // No pointless refetch on the no-op path.
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it("maps a P2002 to duplicate_open_request", async () => {
    // The shadow already holds an open request at this place, so the flip
    // violates the SQL-only partial unique "BookingRequest_open_pair_key".
    const { prisma } = bookingPrisma({
      updateManyImpl: async () => {
        throw new Prisma.PrismaClientKnownRequestError("unique violation", {
          code: "P2002",
          clientVersion: "test",
        });
      },
    });

    await expect(
      makeBookingRequestsRepo(prisma).attachInquirerOwner({
        id: REQUEST_ID,
        performerOwnerType: "human",
        performerOwnerId: SHADOW_HUMAN_ID,
      }),
    ).rejects.toMatchObject({
      // Same domain shape as `create`, so callers have one thing to catch.
      code: "duplicate_open_request",
    });
  });
});

describe("bookingRequests.setInquirerEmailMessageId", () => {
  it("is first-write-wins so the mail thread root cannot oscillate", async () => {
    const { prisma, updateMany } = bookingPrisma({});

    const wrote = await makeBookingRequestsRepo(
      prisma,
    ).setInquirerEmailMessageId({ id: REQUEST_ID, messageId: "root@host" });

    expect(wrote).toBe(true);
    expect(updateMany.mock.calls[0]![0]).toEqual({
      where: { id: REQUEST_ID, inquirerEmailMessageId: null },
      data: { inquirerEmailMessageId: "root@host" },
    });
  });

  it("reports false when another send already claimed the root", async () => {
    const { prisma } = bookingPrisma({
      updateManyImpl: async () => ({ count: 0 }),
    });
    await expect(
      makeBookingRequestsRepo(prisma).setInquirerEmailMessageId({
        id: REQUEST_ID,
        messageId: "loser@host",
      }),
    ).resolves.toBe(false);
  });
});

describe("bookingRequests.markInquirerEmailUndeliverable", () => {
  it("is address-keyed but scoped to MAILED + REACHABLE + UNCLAIMED rows, and monotonic", async () => {
    const at = new Date("2026-09-05T10:00:00.000Z");
    const { prisma, updateMany } = bookingPrisma({
      updateManyImpl: async () => ({ count: 2 }),
    });

    const stamped = await makeBookingRequestsRepo(
      prisma,
    ).markInquirerEmailUndeliverable({
      contactEmail: "JO@Example.com",
      status: "BOUNCED",
      at,
    });

    expect(stamped).toBe(2);
    const args = updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(args.where).toEqual({
      // Lowercased at rest, so plain equality hits
      // "BookingRequest_contactEmail_idx".
      contactEmail: "jo@example.com",
      // A claimed row has a real account and the platform's own deliverability
      // machinery; never annotate it from this path.
      claimedAt: null,
      // ONLY rows this feature actually mailed. The address is all the webhook
      // gives us, so without this one bounce of venue A's reply would also
      // stamp the same person's untouched inquiries at venues B and C — and a
      // bounced GUEST TICKET RECEIPT to that address would stamp every one of
      // them.
      inquirerEmailMessageId: { not: null },
      // A DECLINED / WITHDRAWN / EXPIRED row is a finished conversation;
      // "we could not reach them" is noise on it. ACCEPTED is IN, and is the
      // reason this is not the plain open set: the invite-to-claim mail went
      // to this same address, so a bounce there means the inquirer will never
      // redeem the token and never show up.
      status: { in: ["PENDING", "VIEWED", "ACCEPTED"] },
      // Out-of-order provider replays must not overwrite a newer stamp.
      OR: [
        { inquirerEmailUndeliverableAt: null },
        { inquirerEmailUndeliverableAt: { lt: at } },
      ],
    });
    expect(args.data).toEqual({
      inquirerEmailUndeliverableAt: at,
      inquirerEmailUndeliverableStatus: "BOUNCED",
    });
  });
});

describe("bookingRequests.findOpenByContactEmailAndPlace", () => {
  it("scopes by CLAIM STATE, not by a null owner pair", async () => {
    // The shadow flip drops a row out of "BookingRequest_open_anon_pair_key"
    // (predicate: performerOwnerId IS NULL) with nothing keyed on the address
    // taking over, so this pre-check is the only thing still enforcing "one
    // open inquiry per (place, email)" in that window.
    const { prisma, findFirst } = bookingPrisma({});

    await makeBookingRequestsRepo(prisma).findOpenByContactEmailAndPlace({
      placeId: PLACE_ID,
      contactEmail: "JO@Example.com",
    });

    const args = findFirst.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(args.where).toMatchObject({
      placeId: PLACE_ID,
      direction: "TO_VENUE",
      claimedAt: null,
      contactEmail: "jo@example.com",
      status: { in: ["PENDING", "VIEWED"] },
    });
    expect(args.where).not.toHaveProperty("performerOwnerId");
  });
});

describe("bookingRequests.setClaimToken", () => {
  it("guards on UNCLAIMED, not on a null owner pair", async () => {
    // A shadow-owned inquiry must still be able to receive (and rotate) an
    // invite-to-claim token — an owner-null guard would silently kill
    // invite-to-claim for exactly the inquiries a venue engaged with.
    const { prisma, updateMany } = bookingPrisma({});
    const expiresAt = new Date("2026-09-19T10:00:00.000Z");

    await makeBookingRequestsRepo(prisma).setClaimToken({
      id: REQUEST_ID,
      claimTokenHash: "a".repeat(64),
      claimTokenExpiresAt: expiresAt,
      expectedFrom: ["ACCEPTED"],
    });

    const args = updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    expect(args.where).toEqual({
      id: REQUEST_ID,
      status: { in: ["ACCEPTED"] },
      contactEmail: { not: null },
      claimedAt: null,
    });
    expect(args.where).not.toHaveProperty("performerOwnerId");
  });
});
