import { describe, expect, it, vi } from "vitest";

import { makeAgreementsRepo } from "../agreements";
import type { PrismaClientOrTx } from "../types";

/**
 * Query-shape coverage for `AgreementsRepo.findManyByIds` — the set-shaped
 * batch behind the booking inbox's stage rail
 * (`listBookingRequests` projects `agreementStatus` + the linked event onto
 * every row).
 *
 * Two properties live entirely in the query, so that is what is asserted:
 *   - ONE `IN (...)` for the whole page, never one round trip per row (the
 *     org-wide inbox spans up to 100 venues);
 *   - the empty set costs ZERO round trips — `id: { in: [] }` would otherwise
 *     be a pointless query on the common inbox, where no row has an agreement.
 *
 * The record mapping is asserted alongside because BOTH event link columns
 * have to survive it: a projection blind to `draftEventId` reports "no event"
 * for the state a booked event spends most of its life in.
 */

const AGREEMENT_A = "55555555-5555-4555-8555-555555555555";
const AGREEMENT_B = "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b";
const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const DRAFT_EVENT_ID = "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2";

function agreementPrisma(rows: unknown[] = []) {
  const findMany = vi.fn(async () => rows);
  const prisma = {
    agreement: { findMany },
  } as unknown as PrismaClientOrTx;
  return { prisma, findMany };
}

/** Minimal `Agreement` row shape `toRecord` reads. */
function row(overrides: Record<string, unknown> = {}) {
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

describe("makeAgreementsRepo.findManyByIds", () => {
  it("issues ONE set-shaped query for the whole page", async () => {
    const { prisma, findMany } = agreementPrisma([
      row(),
      row({ id: AGREEMENT_B, status: "DRAFT" }),
    ]);

    const records = await makeAgreementsRepo(prisma).findManyByIds([
      AGREEMENT_A,
      AGREEMENT_B,
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: [AGREEMENT_A, AGREEMENT_B] } },
    });
    expect(records.map((r) => [r.id, r.status])).toEqual([
      [AGREEMENT_A, "ACCEPTED"],
      [AGREEMENT_B, "DRAFT"],
    ]);
  });

  it("returns [] for an empty id set WITHOUT a round trip", async () => {
    const { prisma, findMany } = agreementPrisma();

    await expect(
      makeAgreementsRepo(prisma).findManyByIds([]),
    ).resolves.toEqual([]);

    expect(findMany).not.toHaveBeenCalled();
  });

  it("omits ids with no row rather than padding the result", async () => {
    // Port contract: missing ids are silently dropped, so callers must key by
    // id instead of assuming positional alignment.
    const { prisma } = agreementPrisma([row()]);

    const records = await makeAgreementsRepo(prisma).findManyByIds([
      AGREEMENT_A,
      AGREEMENT_B,
    ]);

    expect(records.map((r) => r.id)).toEqual([AGREEMENT_A]);
  });

  it("carries BOTH event link columns through the mapping", async () => {
    // `eventId` (finalized) and `draftEventId` (pre-finalize anchor) are
    // separate columns; a mapping that drops the draft anchor makes most real
    // bookings read as "no event".
    const { prisma } = agreementPrisma([
      row({ eventId: EVENT_ID, draftEventId: DRAFT_EVENT_ID }),
    ]);

    const [record] = await makeAgreementsRepo(prisma).findManyByIds([
      AGREEMENT_A,
    ]);

    expect(record).toMatchObject({
      eventId: EVENT_ID,
      draftEventId: DRAFT_EVENT_ID,
      // The hand-mirrored party unions are cast from the DB's plain strings.
      proposerType: "human",
      counterpartyType: "organization",
    });
  });
});
