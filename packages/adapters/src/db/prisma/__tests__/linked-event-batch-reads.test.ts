import { describe, expect, it, vi } from "vitest";

import { makeAgreementsRepo } from "../agreements";
import { makeBookingRequestsRepo } from "../booking-requests";
import type { PrismaClientOrTx } from "../types";

/**
 * Query-shape coverage for the two batch reads behind `/my-lineups`'
 * `passesBookingAct` (event → Agreement → BookingRequest for a whole page):
 *   - `AgreementsRepo.findManyByLinkedEventIds` — ONE query over BOTH link
 *     columns (the caller applies finalized-first precedence, so the rows
 *     must all come back);
 *   - `BookingRequestsRepo.findManyByAgreementIds` — ONE `IN (...)`.
 * Both cost ZERO round trips for an empty set. Same posture as
 * `agreements-find-many-by-ids.test.ts`: the properties live in the query.
 */

const EVENT_A = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const EVENT_B = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";
const AGREEMENT_A = "55555555-5555-4555-8555-555555555555";
const AGREEMENT_B = "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b";

function agreementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGREEMENT_A,
    type: "PERFORMANCE",
    status: "ACCEPTED",
    proposerType: "human",
    proposerId: "11111111-1111-4111-8111-111111111111",
    counterpartyType: "organization",
    counterpartyId: "22222222-2222-4222-8222-222222222222",
    placeId: "33333333-3333-4333-8333-333333333333",
    eventId: null,
    draftEventId: null,
    payoutTermsId: null,
    title: "Friday night",
    description: null,
    proposedDate: null,
    proposedEndDate: null,
    guaranteeCents: null,
    proposedAt: null,
    acceptedAt: null,
    declinedAt: null,
    declinedReason: null,
    expiresAt: null,
    fulfilledAt: null,
    createdAt: new Date("2026-06-02T00:00:00.000Z"),
    updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("makeAgreementsRepo.findManyByLinkedEventIds", () => {
  it("issues ONE query matching the finalized OR the draft link, and returns every row", async () => {
    const findMany = vi.fn(async () => [
      agreementRow({ eventId: EVENT_A }),
      agreementRow({ id: AGREEMENT_B, draftEventId: EVENT_B }),
    ]);
    const prisma = { agreement: { findMany } } as unknown as PrismaClientOrTx;

    const records = await makeAgreementsRepo(prisma).findManyByLinkedEventIds([
      EVENT_A,
      EVENT_B,
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { eventId: { in: [EVENT_A, EVENT_B] } },
          { draftEventId: { in: [EVENT_A, EVENT_B] } },
        ],
      },
    });
    expect(records.map((r) => [r.id, r.eventId, r.draftEventId])).toEqual([
      [AGREEMENT_A, EVENT_A, null],
      [AGREEMENT_B, null, EVENT_B],
    ]);
  });

  it("returns [] for an empty set WITHOUT a round trip", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { agreement: { findMany } } as unknown as PrismaClientOrTx;
    await expect(
      makeAgreementsRepo(prisma).findManyByLinkedEventIds([]),
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("makeBookingRequestsRepo.findManyByAgreementIds", () => {
  it("issues ONE IN query on agreementId", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      bookingRequest: { findMany },
    } as unknown as PrismaClientOrTx;

    await makeBookingRequestsRepo(prisma).findManyByAgreementIds([
      AGREEMENT_A,
      AGREEMENT_B,
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agreementId: { in: [AGREEMENT_A, AGREEMENT_B] } },
      }),
    );
  });

  it("returns [] for an empty set WITHOUT a round trip", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      bookingRequest: { findMany },
    } as unknown as PrismaClientOrTx;
    await expect(
      makeBookingRequestsRepo(prisma).findManyByAgreementIds([]),
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
