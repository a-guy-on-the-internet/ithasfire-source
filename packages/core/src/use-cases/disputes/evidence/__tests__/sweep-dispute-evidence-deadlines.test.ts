import { describe, expect, it, vi } from "vitest";

import type { DisputeEvidenceAttentionRow } from "@th/ports/repos/disputes";

import {
  buildDisputeDeskUrl,
  classifyDisputeEvidenceAttention,
  sweepDisputeEvidenceDeadlines,
} from "../sweep-dispute-evidence-deadlines";
import {
  buildDispute,
  buildEvidence,
  clock,
  DISPUTE_ID,
  makeFakeRepos,
  NOW,
  ORDER_ID,
  ORG_ID,
} from "./fixtures";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

describe("classifyDisputeEvidenceAttention", () => {
  const base = { now: NOW, dueWithinDays: 3 };

  it("overdue when the deadline is in the past, regardless of package state", () => {
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: new Date(NOW.getTime() - 1),
        evidenceStatus: "DRAFT",
      }),
    ).toBe("overdue");
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: daysFromNow(-2),
        evidenceStatus: null,
      }),
    ).toBe("overdue");
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: daysFromNow(-2),
        evidenceStatus: "SUBMIT_FAILED",
      }),
    ).toBe("overdue");
  });

  it("due_soon is inclusive at exactly now + dueWithinDays and exclusive one ms after", () => {
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: daysFromNow(3),
        evidenceStatus: "DRAFT",
      }),
    ).toBe("due_soon");
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: new Date(daysFromNow(3).getTime() + 1),
        evidenceStatus: "DRAFT",
      }),
    ).toBeNull();
    // A deadline of exactly now is not yet overdue → due_soon.
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: NOW,
        evidenceStatus: "APPROVED",
      }),
    ).toBe("due_soon");
  });

  it("no_due_date when the deadline is unknown and the package is fine", () => {
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: null,
        evidenceStatus: "DRAFT",
      }),
    ).toBe("no_due_date");
  });

  it("submit_failed alerts even with a comfortably future deadline", () => {
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: daysFromNow(10),
        evidenceStatus: "SUBMIT_FAILED",
      }),
    ).toBe("submit_failed");
    // ...and outranks a missing deadline.
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: null,
        evidenceStatus: "SUBMIT_FAILED",
      }),
    ).toBe("submit_failed");
  });

  it("unassembled when there is no package, even with a far deadline; outranks no_due_date", () => {
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: daysFromNow(10),
        evidenceStatus: null,
      }),
    ).toBe("unassembled");
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: null,
        evidenceStatus: null,
      }),
    ).toBe("unassembled");
  });

  it("returns null for a healthy package with a deadline beyond the window", () => {
    expect(
      classifyDisputeEvidenceAttention({
        ...base,
        dueBy: daysFromNow(10),
        evidenceStatus: "APPROVED",
      }),
    ).toBeNull();
  });
});

describe("buildDisputeDeskUrl", () => {
  it("links to the platform desk with the dispute preselected, trimming trailing slashes", () => {
    expect(buildDisputeDeskUrl("https://ithasfire.com/", "d 1")).toBe(
      "https://ithasfire.com/platform/disputes?dispute=d%201",
    );
    expect(buildDisputeDeskUrl(null, "d1")).toBeUndefined();
    expect(buildDisputeDeskUrl("  ", "d1")).toBeUndefined();
  });
});

function attentionRow(
  overrides: Partial<DisputeEvidenceAttentionRow> = {},
): DisputeEvidenceAttentionRow {
  return {
    id: DISPUTE_ID,
    stripeDisputeId: "dp_123",
    status: "OPEN",
    evidenceDueBy: daysFromNow(2),
    evidencePastDue: null,
    amountCents: 5_000,
    currency: "usd",
    orderId: ORDER_ID,
    eventId: "22222222-2222-4222-8222-222222222222",
    eventTitle: "Rock Show",
    ownerOrgId: ORG_ID,
    ownerOrgName: "Drkmttr Collective",
    ownerHumanId: null,
    ownerHumanName: null,
    evidenceStatus: null,
    ...overrides,
  };
}

function withFeed(
  fake: ReturnType<typeof makeFakeRepos>,
  rows: DisputeEvidenceAttentionRow[],
) {
  const listOpenNeedingEvidenceAttention = vi.fn(async () => rows);
  (
    fake.repos.disputes as unknown as {
      listOpenNeedingEvidenceAttention: typeof listOpenNeedingEvidenceAttention;
    }
  ).listOpenNeedingEvidenceAttention = listOpenNeedingEvidenceAttention;
  return listOpenNeedingEvidenceAttention;
}

describe("sweepDisputeEvidenceDeadlines", () => {
  it("heals a dispute with no package through the real assembler and alerts on the deadline", async () => {
    const fake = makeFakeRepos();
    const feed = withFeed(fake, [attentionRow()]);

    const result = await sweepDisputeEvidenceDeadlines(
      { repos: fake.repos, idempotency: fake.idempotency, clock, publicAppUrl: "https://ithasfire.com/" },
      { now: NOW },
    );

    expect(feed).toHaveBeenCalledWith({ now: NOW, dueWithinDays: 3 });
    expect(fake.upsertDraft).toHaveBeenCalledTimes(1);
    expect(fake.evidence.get(DISPUTE_ID)?.status).toBe("DRAFT");
    expect(result).toEqual({
      ok: true,
      scanned: 1,
      healed: 1,
      healFailed: 0,
      alerts: [
        {
          disputeId: DISPUTE_ID,
          stripeDisputeId: "dp_123",
          bucket: "due_soon",
          dueBy: daysFromNow(2),
          evidenceStatus: "DRAFT",
          amountCents: 5_000,
          currency: "usd",
          eventTitle: "Rock Show",
          owner: "Drkmttr Collective",
          deskUrl: `https://ithasfire.com/platform/disputes?dispute=${DISPUTE_ID}`,
        },
      ],
    });
  });

  it("a healed package with a far deadline drops out of the alert list", async () => {
    const fake = makeFakeRepos();
    withFeed(fake, [attentionRow({ evidenceDueBy: daysFromNow(10) })]);

    const result = await sweepDisputeEvidenceDeadlines(
      { repos: fake.repos, idempotency: fake.idempotency, clock },
      {},
    );

    expect(result.healed).toBe(1);
    expect(result.alerts).toEqual([]);
  });

  it("reports a throwing heal, keeps sweeping, and still alerts the dispute as unassembled", async () => {
    // Order lookup is the one MUST-resolve source in the assembler: a throw
    // there escapes assembleDisputeEvidence and lands in the sweep's catch.
    const fake = makeFakeRepos();
    fake.repos.orders.getById = vi.fn(async () => {
      throw new Error("orders down");
    });
    const broken = attentionRow({ id: "dispute_broken", stripeDisputeId: "dp_b" });
    const healthy = attentionRow({
      id: "dispute_ok",
      stripeDisputeId: "dp_ok",
      evidenceStatus: "DRAFT",
      evidenceDueBy: daysFromNow(-1),
    });
    fake.disputes.set(
      "dispute_broken",
      buildDispute({ id: "dispute_broken", stripeDisputeId: "dp_b" }),
    );
    withFeed(fake, [broken, healthy]);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const reportError = vi.fn();

    const result = await sweepDisputeEvidenceDeadlines(
      {
        repos: fake.repos, idempotency: fake.idempotency,
        clock,
        logger: logger as never,
        reportError,
      },
      { now: NOW, dueWithinDays: 5 },
    );

    expect(result.scanned).toBe(2);
    expect(result.healed).toBe(0);
    expect(result.healFailed).toBe(1);
    expect(result.alerts.map((a) => [a.disputeId, a.bucket])).toEqual([
      ["dispute_broken", "unassembled"],
      ["dispute_ok", "overdue"],
    ]);
    expect(result.alerts[0]?.deskUrl).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "dispute.evidence.sweep.heal_failed",
      expect.objectContaining({
        disputeId: "dispute_broken",
        error: "orders down",
      }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "sweepDisputeEvidenceDeadlines", step: "heal" },
        extra: expect.objectContaining({ disputeId: "dispute_broken" }),
      }),
    );
  });

  it("a throwing reporter never changes the outcome", async () => {
    const fake = makeFakeRepos();
    fake.repos.orders.getById = vi.fn(async () => {
      throw new Error("orders down");
    });
    withFeed(fake, [attentionRow()]);

    const result = await sweepDisputeEvidenceDeadlines(
      {
        repos: fake.repos, idempotency: fake.idempotency,
        clock,
        reportError: () => {
          throw new Error("sentry down");
        },
      },
      { now: NOW },
    );

    expect(result.healFailed).toBe(1);
    expect(result.alerts[0]?.bucket).toBe("unassembled");
  });

  it("a feed row with a stale null status whose package already exists is not counted as healed and carries the real status", async () => {
    // Lost the race with the webhook (or a manual assemble) between the feed
    // read and the heal: the assembler returns already_assembled, the sweep
    // takes the package that exists instead of alerting on the stale null.
    const fake = makeFakeRepos({ evidence: buildEvidence({ status: "APPROVED" }) });
    withFeed(fake, [attentionRow({ evidenceStatus: null, evidenceDueBy: daysFromNow(1) })]);

    const result = await sweepDisputeEvidenceDeadlines(
      { repos: fake.repos, idempotency: fake.idempotency, clock },
      { now: NOW },
    );

    expect(fake.upsertDraft).not.toHaveBeenCalled();
    expect(result.healed).toBe(0);
    expect(result.healFailed).toBe(0);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]).toMatchObject({
      bucket: "due_soon",
      evidenceStatus: "APPROVED",
    });
  });

  it("does not heal rows that already have a package; counts submit_failed and no_due_date", async () => {
    const fake = makeFakeRepos({
      evidence: buildEvidence({ status: "SUBMIT_FAILED" }),
    });
    withFeed(fake, [
      attentionRow({ evidenceStatus: "SUBMIT_FAILED", evidenceDueBy: daysFromNow(9) }),
      attentionRow({
        id: "dispute_nodue",
        stripeDisputeId: "dp_nodue",
        evidenceStatus: "APPROVED",
        evidenceDueBy: null,
        ownerOrgName: null,
        ownerHumanName: "Solo Promoter",
      }),
    ]);

    const result = await sweepDisputeEvidenceDeadlines(
      { repos: fake.repos, idempotency: fake.idempotency, clock },
      { now: NOW },
    );

    expect(fake.upsertDraft).not.toHaveBeenCalled();
    expect(result.healed).toBe(0);
    expect(result.alerts.map((a) => a.bucket)).toEqual([
      "submit_failed",
      "no_due_date",
    ]);
    expect(result.alerts[1]?.owner).toBe("Solo Promoter");
  });

  it("an unlinked dispute (order gone) stays unassembled rather than counting as healed", async () => {
    const fake = makeFakeRepos({ order: null });
    withFeed(fake, [attentionRow({ evidenceDueBy: daysFromNow(1) })]);

    const result = await sweepDisputeEvidenceDeadlines(
      { repos: fake.repos, idempotency: fake.idempotency, clock },
      { now: NOW },
    );

    expect(result.healed).toBe(0);
    expect(result.healFailed).toBe(0);
    expect(result.alerts[0]).toMatchObject({
      bucket: "unassembled",
      evidenceStatus: null,
    });
  });

  it("rejects an out-of-range window", async () => {
    const fake = makeFakeRepos();
    withFeed(fake, []);
    await expect(
      sweepDisputeEvidenceDeadlines({ repos: fake.repos, idempotency: fake.idempotency, clock }, { dueWithinDays: 0 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      sweepDisputeEvidenceDeadlines({ repos: fake.repos, idempotency: fake.idempotency, clock }, { dueWithinDays: 15 }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
