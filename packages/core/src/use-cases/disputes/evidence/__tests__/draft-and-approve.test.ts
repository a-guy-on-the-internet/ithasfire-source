import { describe, expect, it, vi } from "vitest";

import { DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS } from "@th/ports/dispute-evidence";

import { approveDisputeEvidence } from "../approve-dispute-evidence";
import { updateDisputeEvidenceDraft } from "../update-dispute-evidence-draft";
import {
  buildEvidence,
  clock,
  DISPUTE_ID,
  makeFakeRepos,
  STAFF_ID,
  staffAuthz,
} from "./fixtures";

import { buildDisputeEvidenceMutexKey } from "../_shared/evidence-mutex";

const deps = (fake: ReturnType<typeof makeFakeRepos>, allowed = true) => ({
  repos: fake.repos,
  authz: staffAuthz(allowed),
  idempotency: fake.idempotency,
  clock,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

describe("updateDisputeEvidenceDraft", () => {
  it("merges text edits over the stored fields, keeps untouched keys, and stays DRAFT", async () => {
    const fake = makeFakeRepos({ evidence: buildEvidence() });

    const result = await updateDisputeEvidenceDraft(deps(fake), {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
      fields: { customerName: "Buyer P. Person", cancellationRebuttal: "n/a" },
    });

    expect(result.evidence.status).toBe("DRAFT");
    expect(result.evidence.fields).toEqual({
      productDescription: "2 tickets to Rock Show",
      customerName: "Buyer P. Person",
      uncategorizedText: "ORDER SUMMARY",
      cancellationRebuttal: "n/a",
    });
    expect(result.combinedChars).toBe(
      "2 tickets to Rock Show".length +
        "Buyer P. Person".length +
        "ORDER SUMMARY".length +
        "n/a".length,
    );
    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dispute.evidence_draft_updated",
        data: expect.objectContaining({
          actorHumanId: STAFF_ID,
          editedKeys: ["customerName", "cancellationRebuttal"],
          clearedKeys: [],
        }),
      }),
    );
    // Values never reach the audit log.
    expect(JSON.stringify(fake.audit.mock.calls[0]![0].data)).not.toContain(
      "Buyer P. Person",
    );
  });

  it("accepts an explicit empty string as a deliberate clear", async () => {
    const fake = makeFakeRepos({ evidence: buildEvidence() });
    const result = await updateDisputeEvidenceDraft(deps(fake), {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
      fields: { customerName: "" },
    });
    expect(result.evidence.fields.customerName).toBe("");
    expect(fake.audit.mock.calls[0]![0].data).toMatchObject({
      clearedKeys: ["customerName"],
    });
  });

  it("drops APPROVED back to DRAFT and clears the reviewer stamp", async () => {
    const fake = makeFakeRepos({
      evidence: buildEvidence({
        status: "APPROVED",
        reviewedByHumanId: "other_admin",
        reviewedAt: clock.now(),
      }),
    });
    const result = await updateDisputeEvidenceDraft(deps(fake), {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
      fields: { uncategorizedText: "edited" },
    });
    expect(result.evidence.status).toBe("DRAFT");
    expect(result.evidence.reviewedByHumanId).toBeNull();
    expect(result.evidence.reviewedAt).toBeNull();
  });

  it("rejects edits to a SUBMITTED package", async () => {
    const fake = makeFakeRepos({ evidence: buildEvidence({ status: "SUBMITTED" }) });
    await expect(
      updateDisputeEvidenceDraft(deps(fake), {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
        fields: { customerName: "x" },
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_STATE_INVALID" });
    expect(fake.repos.disputeEvidence.update).not.toHaveBeenCalled();
  });

  it("rejects file-id fields at the boundary (v1 is text only)", async () => {
    const fake = makeFakeRepos({ evidence: buildEvidence() });
    await expect(
      updateDisputeEvidenceDraft(deps(fake), {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
        fields: { receipt: "file_123" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects an over-limit merge with the violations in meta", async () => {
    const fake = makeFakeRepos({ evidence: buildEvidence() });
    // Each field individually under the per-field cap; combined over 150k.
    const big = "x".repeat(DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS);
    await expect(
      updateDisputeEvidenceDraft(deps(fake), {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
        fields: {
          uncategorizedText: big,
          accessActivityLog: big,
          refundPolicyDisclosure: big,
          refundRefusalExplanation: big,
          cancellationPolicyDisclosure: big,
          cancellationRebuttal: big,
          duplicateChargeExplanation: big,
          productDescription: big,
        },
      }),
    ).rejects.toMatchObject({
      code: "DISPUTE_EVIDENCE_LIMIT_EXCEEDED",
      meta: expect.objectContaining({
        violations: expect.arrayContaining([
          expect.objectContaining({ kind: "combined" }),
        ]),
      }),
    });
    expect(fake.repos.disputeEvidence.update).not.toHaveBeenCalled();
  });

  it("refuses a non-staff actor before touching the package", async () => {
    const fake = makeFakeRepos({ evidence: buildEvidence() });
    await expect(
      updateDisputeEvidenceDraft(deps(fake, false), {
        disputeId: DISPUTE_ID,
        actorHumanId: "random_user",
        fields: { customerName: "x" },
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(fake.repos.disputeEvidence.getByDisputeId).not.toHaveBeenCalled();
  });

  it("refuses while the dispute mutex is held by a submit, and releases its own claim afterwards", async () => {
    const fake = makeFakeRepos({ evidence: buildEvidence() });
    const key = buildDisputeEvidenceMutexKey(DISPUTE_ID);
    await fake.idempotency.begin(key, 60, "submit-in-flight");

    await expect(
      updateDisputeEvidenceDraft(deps(fake), {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
        fields: { customerName: "x" },
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_STATE_INVALID" });
    expect(fake.repos.disputeEvidence.update).not.toHaveBeenCalled();

    await fake.idempotency.release(key, "submit-in-flight");
    await updateDisputeEvidenceDraft(deps(fake), {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
      fields: { customerName: "x" },
    });
    expect(await fake.idempotency.begin(key, 60, "probe")).toBe(true);
  });

  it("throws DISPUTE_EVIDENCE_NOT_FOUND when nothing was assembled yet", async () => {
    const fake = makeFakeRepos();
    await expect(
      updateDisputeEvidenceDraft(deps(fake), {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
        fields: { customerName: "x" },
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_NOT_FOUND" });
  });
});

describe("approveDisputeEvidence", () => {
  it("moves DRAFT → APPROVED and stamps the reviewer", async () => {
    const fake = makeFakeRepos({ evidence: buildEvidence() });
    const result = await approveDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
    });
    expect(result.evidence.status).toBe("APPROVED");
    expect(result.evidence.reviewedByHumanId).toBe(STAFF_ID);
    expect(result.evidence.reviewedAt).toEqual(clock.now());
    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "dispute.evidence_approved" }),
    );
  });

  it("re-approves a SUBMIT_FAILED package and clears the error", async () => {
    const fake = makeFakeRepos({
      evidence: buildEvidence({ status: "SUBMIT_FAILED", submitError: "boom" }),
    });
    const result = await approveDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
    });
    expect(result.evidence.status).toBe("APPROVED");
    expect(result.evidence.submitError).toBeNull();
  });

  it("is a no-op on an already APPROVED package", async () => {
    const fake = makeFakeRepos({
      evidence: buildEvidence({ status: "APPROVED", reviewedByHumanId: "a" }),
    });
    const result = await approveDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
    });
    expect(result.evidence.reviewedByHumanId).toBe("a");
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it("rejects SUBMITTED and empty packages", async () => {
    const submitted = makeFakeRepos({ evidence: buildEvidence({ status: "SUBMITTED" }) });
    await expect(
      approveDisputeEvidence(deps(submitted), {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_STATE_INVALID" });

    const empty = makeFakeRepos({ evidence: buildEvidence({ fields: {} }) });
    await expect(
      approveDisputeEvidence(deps(empty), {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_STATE_INVALID" });
  });

  it("refuses while the dispute mutex is held", async () => {
    const fake = makeFakeRepos({ evidence: buildEvidence() });
    await fake.idempotency.begin(buildDisputeEvidenceMutexKey(DISPUTE_ID), 60, "other");
    await expect(
      approveDisputeEvidence(deps(fake), {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_STATE_INVALID" });
    expect(fake.evidence.get(DISPUTE_ID)!.status).toBe("DRAFT");
  });

  it("refuses a non-staff actor", async () => {
    const fake = makeFakeRepos({ evidence: buildEvidence() });
    await expect(
      approveDisputeEvidence(deps(fake, false), {
        disputeId: DISPUTE_ID,
        actorHumanId: "random",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });
});
