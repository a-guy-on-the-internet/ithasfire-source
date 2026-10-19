import { describe, expect, it, vi } from "vitest";

import type { PayeeLedgerEntryRecord } from "@th/ports/repos/payee-ledger";

import { getDisputeForDesk } from "../get-dispute-for-desk";
import { listDisputesForDesk } from "../list-disputes-for-desk";
import { syncDisputeEvidenceDetails } from "../sync-dispute-evidence-details";
import {
  buildDispute,
  buildEvidence,
  buildOrder,
  DISPUTE_ID,
  makeFakeRepos,
  ORDER_ID,
  ORG_ID,
  STAFF_ID,
  staffAuthz,
} from "./fixtures";

describe("syncDisputeEvidenceDetails", () => {
  it("writes the mirror columns, keeping dueBy when the event omitted it", async () => {
    const fake = makeFakeRepos();
    const before = fake.disputes.get(DISPUTE_ID)!.evidenceDueBy;

    const result = await syncDisputeEvidenceDetails(
      { repos: fake.repos },
      {
        stripeDisputeId: "dp_123",
        evidenceDetails: { hasEvidence: true, pastDue: false, submissionCount: 1 },
      },
    );

    expect(result).toEqual({ ok: true, updated: true });
    const after = fake.disputes.get(DISPUTE_ID)!;
    expect(after.evidenceHasEvidence).toBe(true);
    expect(after.evidencePastDue).toBe(false);
    expect(after.evidenceSubmissionCount).toBe(1);
    expect(after.evidenceDueBy).toEqual(before);
    expect(after.evidenceSubmittedAt).toBeNull();
    expect(fake.updateEvidenceDetails.mock.calls[0]![0]).not.toHaveProperty(
      "evidenceDueBy",
    );
  });

  it("returns updated=false for an unknown dispute instead of throwing", async () => {
    const fake = makeFakeRepos();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await syncDisputeEvidenceDetails(
      { repos: fake.repos, logger },
      {
        stripeDisputeId: "dp_unknown",
        evidenceDetails: { hasEvidence: false, pastDue: false, submissionCount: 0 },
      },
    );
    expect(result).toEqual({ ok: true, updated: false });
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("listDisputesForDesk", () => {
  it("delegates to the repo with defaults and enforces the read role", async () => {
    const fake = makeFakeRepos();
    const listForDesk = vi.fn(async () => ({ items: [], nextCursor: null }));
    (fake.repos.disputes as unknown as { listForDesk: typeof listForDesk }).listForDesk =
      listForDesk;

    const result = await listDisputesForDesk(
      { repos: fake.repos, authz: staffAuthz(true) },
      { actorHumanId: STAFF_ID },
    );

    expect(result).toEqual({ items: [], nextCursor: null });
    expect(listForDesk).toHaveBeenCalledWith({
      status: "open",
      cursor: null,
      limit: 25,
    });

    await expect(
      listDisputesForDesk(
        { repos: fake.repos, authz: staffAuthz(false) },
        { actorHumanId: "random", status: "closed", limit: 10 },
      ),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });
});

describe("getDisputeForDesk", () => {
  it("returns dispute + order/buyer/event/owner + evidence + ledger position", async () => {
    const hold: PayeeLedgerEntryRecord = {
      id: "hold_1",
      idempotencyKey: `dispute-hold:${DISPUTE_ID}:payee_1:usd`,
      payeeId: "payee_1",
      type: "DISPUTE_HOLD",
      amountCents: 3_000,
      currency: "usd",
      sourceKind: "dispute",
      sourceId: DISPUTE_ID,
      orderId: ORDER_ID,
      settlementId: null,
      disputeId: DISPUTE_ID,
      relatedEntryId: null,
      availableAt: null,
      consumedByEntryId: null,
      description: "Dispute hold",
      metadata: null,
      createdAt: new Date("2026-05-15T12:00:00.000Z"),
    } as PayeeLedgerEntryRecord;
    const fake = makeFakeRepos({
      evidence: buildEvidence(),
      ledgerEntries: [hold],
    });

    const result = await getDisputeForDesk(
      { repos: fake.repos, authz: staffAuthz(true) },
      { actorHumanId: STAFF_ID, disputeId: DISPUTE_ID },
    );

    expect(result.dispute).toMatchObject({
      id: DISPUTE_ID,
      stripeDisputeId: "dp_123",
      status: "OPEN",
    });
    expect(result.order).toMatchObject({ id: ORDER_ID, kind: "TICKETING" });
    expect(result.buyer).toEqual({
      humanId: "33333333-3333-4333-8333-333333333333",
      name: "Buyer Person",
      email: "buyer@example.com",
    });
    expect(result.event).toMatchObject({ title: "Rock Show", timezone: "America/Chicago" });
    expect(result.owner).toEqual({
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      name: "Drkmttr Collective",
    });
    expect(result.evidence).toMatchObject({ status: "DRAFT", assembledVersion: 1 });
    expect(result.ledger).toEqual({
      activeHolds: [
        expect.objectContaining({ id: "hold_1", amountCents: 3_000 }),
      ],
      debits: [],
      heldCents: 3_000,
      debitedCents: 0,
    });
  });

  it("returns nulls for an unlinked dispute and 404s an unknown one", async () => {
    const fake = makeFakeRepos({
      dispute: buildDispute({
        orderId: null,
        status: "NEEDS_TRIAGE",
        ownerSubjectType: null,
        ownerSubjectId: null,
        ownerOrgId: null,
      }),
    });
    const result = await getDisputeForDesk(
      { repos: fake.repos, authz: staffAuthz(true) },
      { actorHumanId: STAFF_ID, disputeId: DISPUTE_ID },
    );
    expect(result.order).toBeNull();
    expect(result.buyer).toBeNull();
    expect(result.event).toBeNull();
    expect(result.owner).toBeNull();
    expect(result.evidence).toBeNull();

    await expect(
      getDisputeForDesk(
        { repos: fake.repos, authz: staffAuthz(true) },
        { actorHumanId: STAFF_ID, disputeId: "nope" },
      ),
    ).rejects.toMatchObject({ code: "DISPUTE_NOT_FOUND" });
  });

  it("shows the same purchase IP the evidence sends: checkoutIp, else the refund-policy ack IP", async () => {
    const read = async (checkoutIp: string | null, refundPolicyAckIp: string | null) => {
      const fake = makeFakeRepos({ order: buildOrder({ checkoutIp, refundPolicyAckIp }) });
      const result = await getDisputeForDesk(
        { repos: fake.repos, authz: staffAuthz(true) },
        { actorHumanId: STAFF_ID, disputeId: DISPUTE_ID },
      );
      return result.order!.checkoutIp;
    };
    expect(await read("198.51.100.1", "198.51.100.2")).toBe("198.51.100.1");
    expect(await read(null, "198.51.100.2")).toBe("198.51.100.2");
    expect(await read(null, null)).toBeNull();
  });

  it("swallows a failing display lookup, reports it, and still returns the dispute", async () => {
    const reportError = vi.fn();
    const fake = makeFakeRepos();
    (fake.repos.organizations.getById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("orgs down"),
    );
    const result = await getDisputeForDesk(
      { repos: fake.repos, authz: staffAuthz(true), reportError },
      { actorHumanId: STAFF_ID, disputeId: DISPUTE_ID },
    );
    expect(result.owner).toEqual({
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      name: null,
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { useCase: "getDisputeForDesk", source: "owner" } }),
    );
  });

  it("refuses a non-staff actor", async () => {
    const fake = makeFakeRepos();
    await expect(
      getDisputeForDesk(
        { repos: fake.repos, authz: staffAuthz(false) },
        { actorHumanId: "random", disputeId: DISPUTE_ID },
      ),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });
});
