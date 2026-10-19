import { describe, expect, it, vi } from "vitest";

import type { EntityReportRecord } from "@th/ports/repos/entity-reports";

import {
  reviewEntityReport,
  type ReviewEntityReportDeps,
} from "../review-entity-report";
import {
  STAFF_ID,
  NOW,
  REPORTER_ID,
  REPORT_ID,
  makeClock,
  makeLogger,
  makeReport,
  makeStaffAuthz,
} from "./helpers";

function buildDeps(
  overrides: {
    /** Result of the CAS claim (null = loser / not PENDING). */
    claimed?: EntityReportRecord | null;
    /** Row returned by the post-loss getById disambiguation read. */
    existing?: EntityReportRecord | null;
    rolesByHuman?: Record<string, string[]>;
    /** Make the in-app notification create reject. */
    notifyError?: unknown;
  } = {},
) {
  const claimPendingForReview = vi.fn(async (input: Record<string, unknown>) => {
    if (overrides.claimed !== undefined) return overrides.claimed;
    return makeReport({
      status: input.status as EntityReportRecord["status"],
      reviewedByHumanId: input.reviewedByHumanId as string,
      reviewedAt: input.reviewedAt as Date,
      reviewNote: (input.reviewNote as string | null) ?? null,
    });
  });
  const getById = vi.fn(async () => overrides.existing ?? null);
  const audit = { log: vi.fn() };

  const notificationsCreate = vi.fn(async () => {
    if (overrides.notifyError !== undefined) {
      throw overrides.notifyError;
    }
    return { id: "notif-1", createdAt: NOW };
  });

  const txRepos = {
    entityReports: { claimPendingForReview, getById },
    audit,
  };
  const tx = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(txRepos),
  );

  const authz = makeStaffAuthz(
    overrides.rolesByHuman ?? { [STAFF_ID]: ["SUPPORT"] },
  );
  const logger = makeLogger();
  const reportError = vi.fn();

  const deps: ReviewEntityReportDeps = {
    repos: {
      tx,
      entityReports: { claimPendingForReview, getById },
      notifications: { create: notificationsCreate },
    } as unknown as ReviewEntityReportDeps["repos"],
    authz: authz as unknown as ReviewEntityReportDeps["authz"],
    clock: makeClock(),
    logger: logger as unknown as ReviewEntityReportDeps["logger"],
    reportError,
  };

  return {
    deps,
    tx,
    claimPendingForReview,
    getById,
    audit,
    notificationsCreate,
    authz,
    logger,
    reportError,
  };
}

const validInput = {
  reportId: REPORT_ID,
  verdict: "RESOLVED",
  actorHumanId: STAFF_ID,
};

describe("reviewEntityReport", () => {
  it("non-staff actor gets STAFF_ONLY BEFORE any claim — the PENDING claim is never burned", async () => {
    const { deps, tx, claimPendingForReview, getById } = buildDeps({
      rolesByHuman: { [REPORTER_ID]: [] },
    });

    await expect(
      reviewEntityReport(deps, { ...validInput, actorHumanId: REPORTER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    // Authz-before-claim ordering: no repo call of ANY kind happened.
    expect(claimPendingForReview).not.toHaveBeenCalled();
    expect(getById).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });

  it("a COMMUNITY_MODERATOR is FORBIDDEN and never burns the claim — platform T&S only (spec v1.1)", async () => {
    const { deps, tx, claimPendingForReview } = buildDeps({
      rolesByHuman: { [STAFF_ID]: ["COMMUNITY_MODERATOR"] },
    });

    await expect(reviewEntityReport(deps, validInput)).rejects.toMatchObject({
      code: "STAFF_ONLY",
    });
    expect(claimPendingForReview).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });

  it.each([["ADMIN"], ["SUPPORT"], ["DEVELOPER"]])(
    "%s passes the platform-staff gate",
    async (role) => {
      const { deps } = buildDeps({
        rolesByHuman: { [STAFF_ID]: [role] },
      });

      const result = await reviewEntityReport(deps, validInput);
      expect(result.report.status).toBe("RESOLVED");
    },
  );

  it("win: CAS claims the verdict, audit row lands in the SAME tx, output carries the updated report", async () => {
    const { deps, tx, claimPendingForReview, audit } = buildDeps();

    const result = await reviewEntityReport(deps, {
      ...validInput,
      reviewNote: "  Confirmed closed — <i>street view</i> agrees.  ",
    });

    expect(tx).toHaveBeenCalledTimes(1);
    // reviewNote is sanitized + trimmed before it reaches the repo.
    expect(claimPendingForReview).toHaveBeenCalledWith({
      id: REPORT_ID,
      status: "RESOLVED",
      reviewedByHumanId: STAFF_ID,
      reviewedAt: NOW,
      reviewNote: "Confirmed closed — street view agrees.",
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "entity_report",
        entityId: REPORT_ID,
        action: "entity_report.reviewed",
        data: expect.objectContaining({
          actorHumanId: STAFF_ID,
          verdict: "RESOLVED",
          reviewNote: "Confirmed closed — street view agrees.",
        }),
        at: NOW,
      }),
    );
    expect(result.report.status).toBe("RESOLVED");
    expect(result.report.reviewedByHumanId).toBe(STAFF_ID);
  });

  it("CAS loser + missing row → NOT_FOUND (entity_report_not_found)", async () => {
    const { deps, getById } = buildDeps({ claimed: null, existing: null });

    await expect(reviewEntityReport(deps, validInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "entity_report_not_found",
    });
    expect(getById).toHaveBeenCalledWith(REPORT_ID);
  });

  it("CAS loser + already-reviewed row → CONFLICT (report_already_reviewed) — DISTINCT from missing", async () => {
    const { deps, audit } = buildDeps({
      claimed: null,
      existing: makeReport({
        status: "DISMISSED",
        reviewedByHumanId: REPORTER_ID,
        reviewedAt: NOW,
      }),
    });

    await expect(reviewEntityReport(deps, validInput)).rejects.toMatchObject({
      code: "CONFLICT",
      message: "report_already_reviewed",
      meta: expect.objectContaining({
        reason: "report_already_reviewed",
        status: "DISMISSED",
      }),
    });
    // A lost claim writes nothing.
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("RESOLVED notifies the reporter with kind SUCCESS and the review note in the body", async () => {
    const { deps, notificationsCreate } = buildDeps();

    await reviewEntityReport(deps, {
      ...validInput,
      reviewNote: "Delisted it.",
    });

    expect(notificationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: REPORTER_ID,
        kind: "SUCCESS",
        body: expect.stringContaining("Reviewer note: Delisted it."),
      }),
    );
  });

  it("DISMISSED notifies the reporter with kind INFO", async () => {
    const { deps, notificationsCreate } = buildDeps();

    await reviewEntityReport(deps, { ...validInput, verdict: "DISMISSED" });

    expect(notificationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: REPORTER_ID,
        kind: "INFO",
      }),
    );
  });

  it("notification failure NEVER fails the review — swallowed with logger.warn AND reported via reportError", async () => {
    const notifyError = new Error("notifications down");
    const { deps, logger, reportError } = buildDeps({ notifyError });

    const result = await reviewEntityReport(deps, validInput);

    expect(result.report.status).toBe("RESOLVED");
    expect(logger.warn).toHaveBeenCalledWith(
      "entity_report.in_app_failed",
      expect.objectContaining({ humanId: REPORTER_ID }),
    );
    // Sentry convention: createInApp swallows internally, so the reportError
    // obligation lives in ITS catch (the outer catch never sees this).
    expect(reportError).toHaveBeenCalledWith(
      notifyError,
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "review-entity-report",
          area: "entity_report_notifications",
        }),
        extra: expect.objectContaining({
          reportId: REPORT_ID,
          humanId: REPORTER_ID,
        }),
      }),
    );
  });

  it("a THROWING reporter never fails the review — warn still logged (guarded reportError)", async () => {
    const { deps, logger, reportError } = buildDeps({
      notifyError: new Error("notifications down"),
    });
    reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });

    const result = await reviewEntityReport(deps, validInput);

    expect(result.report.status).toBe("RESOLVED");
    expect(reportError).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "entity_report.in_app_failed",
      expect.objectContaining({ humanId: REPORTER_ID }),
    );
  });

  it("a clean review reports nothing", async () => {
    const { deps, reportError } = buildDeps();

    await reviewEntityReport(deps, validInput);

    expect(reportError).not.toHaveBeenCalled();
  });

  it("reviewNote longer than 2000 chars (after sanitize) is rejected by the schema", async () => {
    const { deps, claimPendingForReview } = buildDeps();

    await expect(
      reviewEntityReport(deps, {
        ...validInput,
        reviewNote: "x".repeat(2001),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(claimPendingForReview).not.toHaveBeenCalled();
  });

  it("an empty-after-sanitize reviewNote collapses to null", async () => {
    const { deps, claimPendingForReview } = buildDeps();

    await reviewEntityReport(deps, { ...validInput, reviewNote: "   " });

    expect(claimPendingForReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewNote: null }),
    );
  });

  it("rejects a verdict outside RESOLVED|DISMISSED (never back to PENDING)", async () => {
    const { deps } = buildDeps();

    await expect(
      reviewEntityReport(deps, { ...validInput, verdict: "PENDING" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
