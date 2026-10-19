import { describe, expect, it, vi } from "vitest";

import type { ProcessorDisputeSnapshot } from "@th/ports/payment-processor-port";
import { DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS } from "@th/ports/dispute-evidence";
import { AppError } from "@th/errors";

import {
  buildDisputeEvidenceSubmitKey,
  sanitiseProcessorError,
  submitDisputeEvidence,
} from "../submit-dispute-evidence";
import { approveDisputeEvidence } from "../approve-dispute-evidence";
import { assembleDisputeEvidence } from "../assemble-dispute-evidence";
import { updateDisputeEvidenceDraft } from "../update-dispute-evidence-draft";
import { buildDisputeEvidenceMutexKey } from "../_shared/evidence-mutex";
import {
  buildEvidence,
  clock,
  DISPUTE_ID,
  makeFakeRepos,
  STAFF_ID,
  staffAuthz,
} from "./fixtures";

function snapshot(
  overrides: Partial<ProcessorDisputeSnapshot> = {},
): ProcessorDisputeSnapshot {
  return {
    processorDisputeId: "dp_123",
    chargeId: "ch_123",
    paymentIntentId: "pi_123",
    status: "needs_response",
    amountCents: 5_000,
    currency: "usd",
    reason: "fraudulent",
    evidenceDetails: {
      dueBy: new Date("2026-05-25T00:00:00.000Z"),
      hasEvidence: false,
      pastDue: false,
      submissionCount: 0,
    },
    evidence: {},
    ...overrides,
  };
}

function makeDeps(
  fake: ReturnType<typeof makeFakeRepos>,
  options: {
    retrieve?: ProcessorDisputeSnapshot;
    update?: () => Promise<ProcessorDisputeSnapshot>;
    allowed?: boolean;
    reportError?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const retrieveDispute = vi.fn(async () => options.retrieve ?? snapshot());
  const updateDisputeEvidence = vi.fn(
    options.update ??
      (async () =>
        snapshot({
          status: "under_review",
          evidenceDetails: {
            dueBy: null,
            hasEvidence: true,
            pastDue: false,
            submissionCount: 1,
          },
        })),
  );
  const idempotency = fake.idempotency;
  return {
    deps: {
      repos: fake.repos,
      authz: staffAuthz(options.allowed ?? true),
      payments: { retrieveDispute, updateDisputeEvidence },
      idempotency,
      clock,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      reportError: options.reportError,
    },
    retrieveDispute,
    updateDisputeEvidence,
    idempotency,
  };
}

const approved = () =>
  buildEvidence({ status: "APPROVED", reviewedByHumanId: "reviewer" });

describe("submitDisputeEvidence", () => {
  it("submits an APPROVED package with the version-keyed idempotency key and stamps everything", async () => {
    const fake = makeFakeRepos({ evidence: approved() });
    const { deps, retrieveDispute, updateDisputeEvidence, idempotency } =
      makeDeps(fake);

    const result = await submitDisputeEvidence(deps, {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
    });

    expect(retrieveDispute).toHaveBeenCalledWith({ processorDisputeId: "dp_123" });
    expect(updateDisputeEvidence).toHaveBeenCalledTimes(1);
    expect(updateDisputeEvidence).toHaveBeenCalledWith({
      processorDisputeId: "dp_123",
      evidence: approved().fields,
      submit: true,
      idempotencyKey: `dispute-evidence:${DISPUTE_ID}:1:update`,
    });
    expect(result.idempotencyKey).toBe(
      buildDisputeEvidenceSubmitKey(DISPUTE_ID, 1),
    );
    expect(result.processorStatus).toBe("under_review");
    expect(result.processorSubmissionCount).toBe(1);
    expect(result.reconciledFromProcessor).toBe(false);

    const stored = fake.evidence.get(DISPUTE_ID)!;
    expect(stored.status).toBe("SUBMITTED");
    expect(stored.submittedByHumanId).toBe(STAFF_ID);
    expect(stored.submittedAt).toEqual(clock.now());
    expect(stored.processorSubmissionCount).toBe(1);
    expect(stored.submitError).toBeNull();
    expect(stored.reconciledFromProcessor).toBe(false);
    expect(stored.fields).toEqual(approved().fields);

    // Dispute mirror columns.
    const dispute = fake.disputes.get(DISPUTE_ID)!;
    expect(dispute.evidenceHasEvidence).toBe(true);
    expect(dispute.evidencePastDue).toBe(false);
    expect(dispute.evidenceSubmissionCount).toBe(1);
    expect(dispute.evidenceSubmittedAt).toEqual(clock.now());
    expect(dispute.evidenceDueBy).toBeNull();

    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dispute.evidence_submitted",
        data: expect.objectContaining({
          actorHumanId: STAFF_ID,
          assembledVersion: 1,
          idempotencyKey: `dispute-evidence:${DISPUTE_ID}:1:update`,
          processorSubmissionCount: 1,
        }),
      }),
    );
    // Dispute-scoped mutex with a per-acquire owner token, released after.
    const lockKey = buildDisputeEvidenceMutexKey(DISPUTE_ID);
    expect(idempotency.__mocks.begin).toHaveBeenCalledWith(
      lockKey,
      300,
      expect.any(String),
    );
    const token = idempotency.__mocks.begin.mock.calls[0]![2];
    expect(idempotency.__mocks.release).toHaveBeenCalledWith(lockKey, token);
    expect(await idempotency.begin(lockKey, 60, "probe")).toBe(true);
    // The terminal write was a compare-and-set on the row read under the lock.
    expect(fake.repos.disputeEvidence.update).toHaveBeenCalledWith(
      expect.objectContaining({
        expect: { status: "APPROVED", assembledVersion: 1 },
        status: "SUBMITTED",
      }),
    );
  });

  it("uses the bumped assembledVersion in the key after a re-assemble", async () => {
    const fake = makeFakeRepos({
      evidence: buildEvidence({ status: "APPROVED", assembledVersion: 3 }),
    });
    const { deps, updateDisputeEvidence } = makeDeps(fake);
    await submitDisputeEvidence(deps, {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
    });
    expect(updateDisputeEvidence.mock.calls[0]![0]).toMatchObject({
      idempotencyKey: `dispute-evidence:${DISPUTE_ID}:3:update`,
    });
  });

  it.each([
    ["under_review", false],
    ["won", false],
    ["lost", false],
    ["warning_under_review", false],
    ["needs_response", true],
  ])(
    "refuses when the live processor status is %s / pastDue=%s and never calls update",
    async (status, pastDue) => {
      const fake = makeFakeRepos({ evidence: approved() });
      const { deps, updateDisputeEvidence } = makeDeps(fake, {
        retrieve: snapshot({
          status: status as ProcessorDisputeSnapshot["status"],
          evidenceDetails: {
            dueBy: null,
            hasEvidence: false,
            pastDue,
            submissionCount: 0,
          },
        }),
      });

      await expect(
        submitDisputeEvidence(deps, {
          disputeId: DISPUTE_ID,
          actorHumanId: STAFF_ID,
        }),
      ).rejects.toMatchObject({ code: "DISPUTE_NOT_ACCEPTING_EVIDENCE" });

      expect(updateDisputeEvidence).not.toHaveBeenCalled();
      // Package untouched; lock released for a retry.
      expect(fake.evidence.get(DISPUTE_ID)!.status).toBe("APPROVED");
      expect(deps.idempotency.__mocks.release).toHaveBeenCalledTimes(1);
    },
  );

  it("reconciles an APPROVED row to SUBMITTED when the processor already holds our submission (crash after Stripe accept)", async () => {
    const fake = makeFakeRepos({ evidence: approved() });
    const liveEvidence = {
      productDescription: "what stripe actually holds",
      customerName: "Buyer Person",
    };
    const { deps, updateDisputeEvidence } = makeDeps(fake, {
      retrieve: snapshot({
        status: "under_review",
        evidence: liveEvidence,
        evidenceDetails: {
          dueBy: null,
          hasEvidence: true,
          pastDue: false,
          submissionCount: 1,
        },
      }),
    });

    const result = await submitDisputeEvidence(deps, {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
    });

    expect(updateDisputeEvidence).not.toHaveBeenCalled();
    expect(result.reconciledFromProcessor).toBe(true);
    expect(result.processorStatus).toBe("under_review");
    expect(result.processorSubmissionCount).toBe(1);
    const stored = fake.evidence.get(DISPUTE_ID)!;
    expect(stored.status).toBe("SUBMITTED");
    // The record is what the PROCESSOR holds, nobody at the desk submitted
    // it on this run, and the provenance says so.
    expect(stored.fields).toEqual(liveEvidence);
    expect(stored.submittedByHumanId).toBeNull();
    expect(stored.reconciledFromProcessor).toBe(true);
    expect(Object.entries(stored.sources).filter(([k]) => k !== "truncated").every(([, v]) => v === "not_applicable")).toBe(true);
    expect(stored.submittedAt).toEqual(clock.now());
    expect(stored.processorSubmissionCount).toBe(1);
    expect(fake.disputes.get(DISPUTE_ID)).toMatchObject({
      evidenceHasEvidence: true,
      evidenceSubmissionCount: 1,
      evidenceSubmittedAt: clock.now(),
    });
    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dispute.evidence_submitted",
        data: expect.objectContaining({
          reconciledFromProcessor: true,
          actorHumanId: STAFF_ID,
          fieldKeys: ["productDescription", "customerName"],
        }),
      }),
    );
    expect(deps.logger.warn).toHaveBeenCalledWith(
      "dispute.evidence.reconciled_from_processor",
      expect.objectContaining({ disputeId: DISPUTE_ID }),
    );
  });

  it("does NOT reconcile when the processor shows no submission (under_review with hasEvidence=false still errors)", async () => {
    const fake = makeFakeRepos({ evidence: approved() });
    const { deps } = makeDeps(fake, {
      retrieve: snapshot({
        status: "under_review",
        evidenceDetails: { dueBy: null, hasEvidence: false, pastDue: false, submissionCount: 0 },
      }),
    });
    await expect(
      submitDisputeEvidence(deps, { disputeId: DISPUTE_ID, actorHumanId: STAFF_ID }),
    ).rejects.toMatchObject({ code: "DISPUTE_NOT_ACCEPTING_EVIDENCE" });
    expect(fake.evidence.get(DISPUTE_ID)!.status).toBe("APPROVED");
  });

  // ── Race scenarios ──────────────────────────────────────────────────────

  it("scenario A: an edit during the Stripe round-trip is refused by the dispute lock, so the SUBMITTED row matches what Stripe received", async () => {
    const fake = makeFakeRepos({
      evidence: buildEvidence({
        status: "APPROVED",
        fields: { productDescription: "2 tickets", customerEmailAddress: "buyer@example.com" },
      }),
    });
    const editResults: unknown[] = [];
    const { deps, updateDisputeEvidence } = makeDeps(fake, {
      update: async () => {
        // Admin2 tries to clear the email while Admin1's submit is in flight.
        await updateDisputeEvidenceDraft(
          {
            repos: fake.repos,
            authz: staffAuthz(true),
            idempotency: fake.idempotency,
            clock,
          },
          { disputeId: DISPUTE_ID, actorHumanId: "admin_2", fields: { customerEmailAddress: "" } },
        ).then(
          (r) => editResults.push({ ok: r }),
          (e) => editResults.push({ err: (e as { code?: string }).code }),
        );
        return snapshot({
          status: "under_review",
          evidenceDetails: { dueBy: null, hasEvidence: true, pastDue: false, submissionCount: 1 },
        });
      },
    });

    const result = await submitDisputeEvidence(deps, {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
    });

    expect(editResults).toEqual([{ err: "DISPUTE_EVIDENCE_STATE_INVALID" }]);
    expect(updateDisputeEvidence.mock.calls[0]![0]).toMatchObject({
      evidence: { customerEmailAddress: "buyer@example.com" },
    });
    // What Stripe got is what we stamped SUBMITTED.
    expect(result.evidence.status).toBe("SUBMITTED");
    expect(result.evidence.fields.customerEmailAddress).toBe("buyer@example.com");
    expect(fake.evidence.get(DISPUTE_ID)!.fields.customerEmailAddress).toBe("buyer@example.com");
  });

  it("scenario B: a force re-assemble + approve + submit during the round-trip is refused by the same dispute lock — one processor submission", async () => {
    const fake = makeFakeRepos({ evidence: approved() });
    const raceResults: string[] = [];
    let calls = 0;
    const { deps, updateDisputeEvidence } = makeDeps(fake, {
      update: async () => {
        calls += 1;
        if (calls === 1) {
          const admin2 = {
            repos: fake.repos,
            authz: staffAuthz(true),
            idempotency: fake.idempotency,
            clock,
          };
          await assembleDisputeEvidence(admin2, { disputeId: DISPUTE_ID, force: true }).then(
            () => raceResults.push("assemble:ok"),
            (e) => raceResults.push(`assemble:${(e as { code?: string }).code}`),
          );
          await approveDisputeEvidence(admin2, { disputeId: DISPUTE_ID, actorHumanId: "admin_2" }).then(
            () => raceResults.push("approve:ok"),
            (e) => raceResults.push(`approve:${(e as { code?: string }).code}`),
          );
          await submitDisputeEvidence(
            { ...deps, authz: staffAuthz(true) },
            { disputeId: DISPUTE_ID, actorHumanId: "admin_2" },
          ).then(
            () => raceResults.push("submit:ok"),
            (e) => raceResults.push(`submit:${(e as { code?: string }).code}`),
          );
        }
        return snapshot({
          status: "under_review",
          evidenceDetails: { dueBy: null, hasEvidence: true, pastDue: false, submissionCount: 1 },
        });
      },
    });

    await submitDisputeEvidence(deps, { disputeId: DISPUTE_ID, actorHumanId: STAFF_ID });

    expect(raceResults).toEqual([
      "assemble:DISPUTE_EVIDENCE_STATE_INVALID",
      "approve:DISPUTE_EVIDENCE_STATE_INVALID",
      "submit:DISPUTE_EVIDENCE_STATE_INVALID",
    ]);
    expect(updateDisputeEvidence).toHaveBeenCalledTimes(1);
    expect(fake.evidence.get(DISPUTE_ID)).toMatchObject({
      status: "SUBMITTED",
      assembledVersion: 1,
    });
  });

  it("CAS backstop: if the row somehow changes under the lock, the terminal write refuses instead of stamping SUBMITTED over foreign fields", async () => {
    const fake = makeFakeRepos({ evidence: approved() });
    const { deps } = makeDeps(fake, {
      update: async () => {
        // Simulate an out-of-band change (a stalled holder past TTL, say).
        const row = fake.evidence.get(DISPUTE_ID)!;
        fake.evidence.set(DISPUTE_ID, {
          ...row,
          status: "DRAFT",
          assembledVersion: 2,
          fields: { productDescription: "someone else's v2" },
        });
        return snapshot({
          status: "under_review",
          evidenceDetails: { dueBy: null, hasEvidence: true, pastDue: false, submissionCount: 1 },
        });
      },
    });

    await expect(
      submitDisputeEvidence(deps, { disputeId: DISPUTE_ID, actorHumanId: STAFF_ID }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_STATE_INVALID" });
    expect(fake.evidence.get(DISPUTE_ID)).toMatchObject({
      status: "DRAFT",
      assembledVersion: 2,
      submittedAt: null,
    });
  });

  it("accepts warning_needs_response as a submittable state", async () => {
    const fake = makeFakeRepos({ evidence: approved() });
    const { deps, updateDisputeEvidence } = makeDeps(fake, {
      retrieve: snapshot({ status: "warning_needs_response" }),
    });
    await submitDisputeEvidence(deps, {
      disputeId: DISPUTE_ID,
      actorHumanId: STAFF_ID,
    });
    expect(updateDisputeEvidence).toHaveBeenCalledTimes(1);
  });

  it("checks the size caps on the MERGED hash (processor-staged + ours)", async () => {
    const fake = makeFakeRepos({
      evidence: buildEvidence({
        status: "APPROVED",
        fields: { uncategorizedText: "x".repeat(DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS) },
      }),
    });
    // Stripe already holds 140k across other fields → merged > 150k.
    const staged = "y".repeat(DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS);
    const { deps, updateDisputeEvidence } = makeDeps(fake, {
      retrieve: snapshot({
        evidence: {
          accessActivityLog: staged,
          refundPolicyDisclosure: staged,
          refundRefusalExplanation: staged,
          cancellationPolicyDisclosure: staged,
          cancellationRebuttal: staged,
          duplicateChargeExplanation: staged,
          productDescription: staged,
        },
      }),
    });

    await expect(
      submitDisputeEvidence(deps, {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_LIMIT_EXCEEDED" });
    expect(updateDisputeEvidence).not.toHaveBeenCalled();
  });

  it("marks SUBMIT_FAILED with a sanitised message, reports, and rethrows a typed error on processor failure", async () => {
    const fake = makeFakeRepos({ evidence: approved() });
    const reportError = vi.fn();
    const processorError = Object.assign(
      new Error("Something broke for buyer@example.com from 203.0.113.7"),
      { type: "StripeAPIError" },
    );
    const { deps } = makeDeps(fake, {
      reportError,
      update: async () => {
        throw processorError;
      },
    });

    await expect(
      submitDisputeEvidence(deps, {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_SUBMIT_FAILED" });

    const stored = fake.evidence.get(DISPUTE_ID)!;
    expect(stored.status).toBe("SUBMIT_FAILED");
    expect(stored.submitError).toBe(
      "Error: Something broke for [email] from [ip]",
    );
    expect(stored.submittedAt).toBeNull();
    expect(reportError).toHaveBeenCalledWith(
      processorError,
      expect.objectContaining({
        tags: { useCase: "submitDisputeEvidence" },
        extra: expect.objectContaining({ disputeId: DISPUTE_ID }),
      }),
    );
    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "dispute.evidence_submit_failed" }),
    );
    // Mirror columns untouched on failure; lock released for a retry.
    expect(fake.disputes.get(DISPUTE_ID)!.evidenceSubmittedAt).toBeNull();
    expect(deps.idempotency.__mocks.release).toHaveBeenCalledTimes(1);
  });

  it("maps a residual processor invalid_request rejection to DISPUTE_NOT_ACCEPTING_EVIDENCE", async () => {
    const fake = makeFakeRepos({ evidence: approved() });
    const { deps } = makeDeps(fake, {
      reportError: vi.fn(),
      update: async () => {
        throw Object.assign(
          new Error("This dispute is not in a state that accepts evidence."),
          { type: "StripeInvalidRequestError", rawType: "invalid_request_error" },
        );
      },
    });

    await expect(
      submitDisputeEvidence(deps, {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_NOT_ACCEPTING_EVIDENCE" });
    expect(fake.evidence.get(DISPUTE_ID)!.status).toBe("SUBMIT_FAILED");
  });

  it("keeps a typed adapter error's code and survives a throwing reporter", async () => {
    const fake = makeFakeRepos({ evidence: approved() });
    const { deps } = makeDeps(fake, {
      reportError: vi.fn(() => {
        throw new Error("sentry down");
      }),
      update: async () => {
        throw new AppError("DISPUTE_EVIDENCE_LIMIT_EXCEEDED", {
          message: "adapter pre-flight",
        });
      },
    });
    await expect(
      submitDisputeEvidence(deps, {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_LIMIT_EXCEEDED" });
    expect(fake.evidence.get(DISPUTE_ID)!.status).toBe("SUBMIT_FAILED");
  });

  it.each(["DRAFT", "SUBMITTED", "SUBMIT_FAILED"] as const)(
    "requires APPROVED (rejects %s) before touching the processor",
    async (status) => {
      const fake = makeFakeRepos({ evidence: buildEvidence({ status }) });
      const { deps, retrieveDispute } = makeDeps(fake);
      await expect(
        submitDisputeEvidence(deps, {
          disputeId: DISPUTE_ID,
          actorHumanId: STAFF_ID,
        }),
      ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_STATE_INVALID" });
      expect(retrieveDispute).not.toHaveBeenCalled();
    },
  );

  it("refuses a concurrent submit while the dispute lock is held, before any read", async () => {
    const fake = makeFakeRepos({ evidence: approved() });
    await fake.idempotency.begin(buildDisputeEvidenceMutexKey(DISPUTE_ID), 60, "other");
    const { deps, retrieveDispute } = makeDeps(fake);
    await expect(
      submitDisputeEvidence(deps, {
        disputeId: DISPUTE_ID,
        actorHumanId: STAFF_ID,
      }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_STATE_INVALID" });
    expect(retrieveDispute).not.toHaveBeenCalled();
    expect(fake.repos.disputeEvidence.getByDisputeId).not.toHaveBeenCalled();
  });

  it("refuses a non-staff actor", async () => {
    const fake = makeFakeRepos({ evidence: approved() });
    const { deps, retrieveDispute } = makeDeps(fake, { allowed: false });
    await expect(
      submitDisputeEvidence(deps, {
        disputeId: DISPUTE_ID,
        actorHumanId: "random",
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(retrieveDispute).not.toHaveBeenCalled();
  });

  it("sanitises emails and IPs and caps the length", () => {
    const long = "e".repeat(1_000);
    expect(sanitiseProcessorError(new Error(`x a.b+c@d.co 10.0.0.1 ${long}`))).toHaveLength(500);
    expect(sanitiseProcessorError(new Error("mail me at a@b.co"))).toBe(
      "Error: mail me at [email]",
    );
    expect(sanitiseProcessorError("plain string")).toBe("plain string");
  });
});
