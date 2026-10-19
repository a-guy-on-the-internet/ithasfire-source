import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";

import { listBookingAgreements } from "../list-booking-agreements";
import type { ListBookingAgreementsDeps } from "../list-booking-agreements";
import {
  AGREEMENT_ID,
  PERFORMER_ID,
  VENUE_ADMIN_ID,
  VENUE_ORG_ID,
  buildAgreementRecord,
  makeAuthzFake,
} from "./helpers";

const ORG_AGREEMENT_ID = "12121212-1212-4121-8121-121212121212";

function buildDeps(byParty: Record<string, AgreementRecord[]>) {
  const listByParty = vi.fn(
    async ({
      partyType,
      partyId,
      statuses,
    }: {
      partyType: string;
      partyId: string;
      statuses?: string[];
    }) =>
      (byParty[`${partyType}:${partyId}`] ?? []).filter(
        (record) => !statuses || statuses.includes(record.status),
      ),
  );

  const deps = {
    repos: {
      agreements: { listByParty },
      authz: makeAuthzFake(),
      humans: {
        getByIds: vi.fn(async (ids: string[]) =>
          ids.map((id) => ({ id, name: "Performer" })),
        ),
      },
      organizations: {
        getByIds: vi.fn(async (ids: string[]) =>
          ids.map((id) => ({ id, name: "Venue Org" })),
        ),
      },
    } as unknown as ListBookingAgreementsDeps["repos"],
  } satisfies ListBookingAgreementsDeps;

  return { deps, listByParty };
}

describe("listBookingAgreements", () => {
  it("merges human-party and org-party agreements, deduped, newest first", async () => {
    const humanAgreement = buildAgreementRecord({
      updatedAt: new Date("2026-06-02T00:00:00.000Z"),
    });
    const orgAgreement = buildAgreementRecord({
      id: ORG_AGREEMENT_ID,
      status: "PROPOSED",
      updatedAt: new Date("2026-06-09T00:00:00.000Z"),
    });

    const { deps } = buildDeps({
      [`human:${VENUE_ADMIN_ID}`]: [],
      // The admin's venue org is a party on both rows → dedupe.
      [`organization:${VENUE_ORG_ID}`]: [orgAgreement, humanAgreement],
    });

    const result = await listBookingAgreements(deps, {
      actorHumanId: VENUE_ADMIN_ID,
    });

    expect(result.agreements.map((a) => a.id)).toEqual([
      ORG_AGREEMENT_ID,
      AGREEMENT_ID,
    ]);
    expect(result.agreements[0]).toMatchObject({
      actorSide: "counterparty",
      proposerDisplayName: "Performer",
      counterpartyDisplayName: "Venue Org",
    });
  });

  it("identifies the proposer side for the performer human", async () => {
    const { deps } = buildDeps({
      [`human:${PERFORMER_ID}`]: [buildAgreementRecord()],
    });

    const result = await listBookingAgreements(deps, {
      actorHumanId: PERFORMER_ID,
    });

    expect(result.agreements).toHaveLength(1);
    expect(result.agreements[0]!.actorSide).toBe("proposer");
  });

  it("passes the statuses filter through", async () => {
    const { deps, listByParty } = buildDeps({
      [`human:${PERFORMER_ID}`]: [buildAgreementRecord({ status: "DECLINED" })],
    });

    const result = await listBookingAgreements(deps, {
      actorHumanId: PERFORMER_ID,
      statuses: ["DRAFT", "PROPOSED"],
    });

    expect(result.agreements).toEqual([]);
    expect(listByParty).toHaveBeenCalledWith(
      expect.objectContaining({ statuses: ["DRAFT", "PROPOSED"] }),
    );
  });
});
