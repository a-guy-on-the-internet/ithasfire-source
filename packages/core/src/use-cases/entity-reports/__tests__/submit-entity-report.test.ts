import { describe, expect, it, vi } from "vitest";

import type { EntityReportRecord } from "@th/ports/repos/entity-reports";

import {
  submitEntityReport,
  type SubmitEntityReportDeps,
} from "../submit-entity-report";
import {
  ADMIN_ID,
  HUMAN_SUBJECT_ID,
  STAFF_ID,
  NOW,
  ORG_ID,
  PLACE_ID,
  REPORTER_ID,
  makeClock,
  makeLogger,
  makeReport,
} from "./helpers";

function buildDeps(
  overrides: {
    place?: { id: string; status: string } | null;
    human?: { id: string; status: string } | null;
    organization?: { id: string; status: string } | null;
    /** Existing PENDING report returned by the dedupe pre-check. */
    pendingExisting?: EntityReportRecord | null;
    /** Platform ADMINs returned by the forward staff-role lookup. */
    adminIds?: string[];
    /** Platform SUPPORT staff returned by the forward staff-role lookup. */
    supportIds?: string[];
    /** Make the repo create throw (adapter race path). */
    createError?: unknown;
    /** Make the in-app notification create reject. */
    notifyError?: unknown;
  } = {},
) {
  const placesGetById = vi.fn(async () =>
    overrides.place !== undefined
      ? overrides.place
      : { id: PLACE_ID, status: "ACTIVE" },
  );
  const humansGetById = vi.fn(async () =>
    overrides.human !== undefined
      ? overrides.human
      : { id: HUMAN_SUBJECT_ID, status: "ACTIVE" },
  );
  const organizationsGetById = vi.fn(async () =>
    overrides.organization !== undefined
      ? overrides.organization
      : { id: ORG_ID, status: "ACTIVE" },
  );

  const createMock = vi.fn(async (input: Record<string, unknown>) => {
    if (overrides.createError !== undefined) {
      throw overrides.createError;
    }
    return makeReport({
      subjectType: input.subjectType as EntityReportRecord["subjectType"],
      subjectId: input.subjectId as string,
      reporterHumanId: input.reporterHumanId as string,
      reason: input.reason as EntityReportRecord["reason"],
      details: (input.details as string | null) ?? null,
    });
  });
  const findPendingByReporterAndSubject = vi.fn(
    async () => overrides.pendingExisting ?? null,
  );
  const audit = { log: vi.fn() };

  const notificationsCreate = vi.fn(async () => {
    if (overrides.notifyError !== undefined) {
      throw overrides.notifyError;
    }
    return { id: "notif-1", createdAt: NOW };
  });
  const listHumanIdsByStaffRole = vi.fn(async (role: string) => {
    if (role === "ADMIN") return overrides.adminIds ?? [];
    if (role === "SUPPORT") return overrides.supportIds ?? [];
    return [];
  });

  const txRepos = {
    entityReports: { create: createMock },
    audit,
  };
  const tx = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(txRepos),
  );

  const logger = makeLogger();
  const reportError = vi.fn();

  const deps: SubmitEntityReportDeps = {
    repos: {
      tx,
      places: { getById: placesGetById },
      humans: { getById: humansGetById },
      organizations: { getById: organizationsGetById },
      entityReports: {
        create: createMock,
        findPendingByReporterAndSubject,
      },
      notifications: { create: notificationsCreate },
      authz: { listHumanIdsByStaffRole },
    } as unknown as SubmitEntityReportDeps["repos"],
    clock: makeClock(),
    logger: logger as unknown as SubmitEntityReportDeps["logger"],
    reportError,
  };

  return {
    deps,
    tx,
    createMock,
    findPendingByReporterAndSubject,
    audit,
    notificationsCreate,
    listHumanIdsByStaffRole,
    placesGetById,
    humansGetById,
    organizationsGetById,
    logger,
    reportError,
  };
}

const validInput = {
  subjectType: "PLACE",
  subjectId: PLACE_ID,
  reason: "CLOSED_OR_GONE",
  actorHumanId: REPORTER_ID,
};

describe("submitEntityReport", () => {
  it("happy path: creates the PENDING row + audit row in ONE tx, notifies platform staff, returns reportId", async () => {
    const { deps, tx, createMock, audit, notificationsCreate } = buildDeps({
      supportIds: [STAFF_ID],
    });

    const result = await submitEntityReport(deps, validInput);

    expect(result.reportId).toBe(makeReport().id);

    // One transaction; both the create and the audit row ran inside it.
    expect(tx).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      subjectType: "PLACE",
      subjectId: PLACE_ID,
      reporterHumanId: REPORTER_ID,
      reason: "CLOSED_OR_GONE",
      details: null,
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "entity_report",
        action: "entity_report.submitted",
        data: expect.objectContaining({
          subjectType: "PLACE",
          subjectId: PLACE_ID,
          reporterHumanId: REPORTER_ID,
          reason: "CLOSED_OR_GONE",
        }),
        at: NOW,
      }),
    );

    // Staff notification attempted post-commit with the platform queue
    // deep-link (spec v1.1: /platform/reports, not /moderate).
    expect(notificationsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: STAFF_ID,
        kind: "INFO",
        action: { label: "Review report", route: "/platform/reports" },
      }),
    );
  });

  it("sanitizes + stores details (trimmed) and passes them to the audit row", async () => {
    const { deps, createMock, audit } = buildDeps();

    await submitEntityReport(deps, {
      ...validInput,
      details: "  The venue shut down <b>last month</b>.  ",
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({ details: "The venue shut down last month." }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          details: "The venue shut down last month.",
        }),
      }),
    );
  });

  it("rejects a reason outside the subject type's subset (HUMAN + CLOSED_OR_GONE)", async () => {
    const { deps, createMock } = buildDeps();

    await expect(
      submitEntityReport(deps, {
        subjectType: "HUMAN",
        subjectId: HUMAN_SUBJECT_ID,
        reason: "CLOSED_OR_GONE",
        actorHumanId: REPORTER_ID,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: expect.objectContaining({ reason: "invalid_reason_for_subject" }),
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects IMPERSONATION on a PLACE (subset is per-subject in BOTH directions)", async () => {
    const { deps } = buildDeps();

    await expect(
      submitEntityReport(deps, { ...validInput, reason: "IMPERSONATION" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: expect.objectContaining({ reason: "invalid_reason_for_subject" }),
    });
  });

  it("rejects reason=OTHER without details — including details that sanitize to empty", async () => {
    const { deps, createMock } = buildDeps();

    await expect(
      submitEntityReport(deps, { ...validInput, reason: "OTHER" }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: expect.objectContaining({
        reason: "details_required",
        fields: ["details"],
      }),
    });

    // "<p>   </p>" strips to "" — sanitize runs BEFORE the required check.
    await expect(
      submitEntityReport(deps, {
        ...validInput,
        reason: "OTHER",
        details: "<p>   </p>",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      meta: expect.objectContaining({ reason: "details_required" }),
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects details longer than 2000 chars (after sanitize) via the input schema", async () => {
    const { deps, createMock } = buildDeps();

    await expect(
      submitEntityReport(deps, { ...validInput, details: "x".repeat(2001) }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("dedupe pre-check: an existing PENDING report throws report_already_open and burns no insert", async () => {
    const { deps, createMock } = buildDeps({
      pendingExisting: makeReport(),
    });

    await expect(submitEntityReport(deps, validInput)).rejects.toMatchObject({
      code: "report_already_open",
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("adapter race path: create's report_already_open propagates UNCHANGED (same code as the pre-check)", async () => {
    const raceError = {
      code: "report_already_open",
      message: "report_already_open",
      cause: new Error("P2002"),
    };
    const { deps } = buildDeps({ createError: raceError });

    await expect(submitEntityReport(deps, validInput)).rejects.toBe(raceError);
  });

  it.each([
    ["PLACE", PLACE_ID, "PLACE_NOT_FOUND"],
    ["HUMAN", HUMAN_SUBJECT_ID, "HUMAN_NOT_FOUND"],
    ["ORGANIZATION", ORG_ID, "ORG_NOT_FOUND"],
  ] as const)(
    "missing %s subject collapses to %s",
    async (subjectType, subjectId, expectedCode) => {
      const { deps, createMock } = buildDeps({
        place: null,
        human: null,
        organization: null,
      });

      await expect(
        submitEntityReport(deps, {
          subjectType,
          subjectId,
          reason: "INCORRECT_INFO",
          actorHumanId: REPORTER_ID,
        }),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(createMock).not.toHaveBeenCalled();
    },
  );

  it("a non-ACTIVE subject collapses to the same NOT_FOUND (no status oracle)", async () => {
    const { deps } = buildDeps({
      place: { id: PLACE_ID, status: "ARCHIVED" },
    });

    await expect(submitEntityReport(deps, validInput)).rejects.toMatchObject({
      code: "PLACE_NOT_FOUND",
    });
  });

  it("notification failure NEVER fails the submit — swallowed with logger.warn AND reported via reportError", async () => {
    const notifyError = new Error("notifications down");
    const { deps, logger, reportError } = buildDeps({
      supportIds: [STAFF_ID],
      notifyError,
    });

    const result = await submitEntityReport(deps, validInput);

    expect(result.reportId).toBe(makeReport().id);
    expect(logger.warn).toHaveBeenCalledWith(
      "entity_report.in_app_failed",
      expect.objectContaining({ humanId: STAFF_ID }),
    );
    // Sentry convention: the createInApp swallow is where per-recipient
    // failures die, so the reportError obligation lives THERE (the outer
    // catch never sees them).
    expect(reportError).toHaveBeenCalledWith(
      notifyError,
      expect.objectContaining({
        tags: expect.objectContaining({
          useCase: "submit-entity-report",
          area: "entity_report_notifications",
        }),
        extra: expect.objectContaining({
          reportId: makeReport().id,
          humanId: STAFF_ID,
        }),
      }),
    );
  });

  it("recipient-resolution failure is also swallowed (outer warn + reportError) and the submit still succeeds", async () => {
    const authzError = new Error("authz down");
    const { deps, listHumanIdsByStaffRole, logger, reportError } = buildDeps();
    listHumanIdsByStaffRole.mockRejectedValueOnce(authzError);

    const result = await submitEntityReport(deps, validInput);

    expect(result.reportId).toBe(makeReport().id);
    expect(logger.warn).toHaveBeenCalledWith(
      "entity_report.submitted_notify_failed",
      expect.objectContaining({ reportId: makeReport().id }),
    );
    expect(reportError).toHaveBeenCalledWith(
      authzError,
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "submit-entity-report" }),
      }),
    );
  });

  it("a THROWING reporter never fails the submit — warn still logged (guarded reportError)", async () => {
    const { deps, logger, reportError } = buildDeps({
      supportIds: [STAFF_ID],
      notifyError: new Error("notifications down"),
    });
    reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });

    const result = await submitEntityReport(deps, validInput);

    expect(result.reportId).toBe(makeReport().id);
    expect(reportError).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "entity_report.in_app_failed",
      expect.objectContaining({ humanId: STAFF_ID }),
    );
  });

  it("a clean submit reports nothing", async () => {
    const { deps, reportError } = buildDeps({ supportIds: [STAFF_ID] });

    await submitEntityReport(deps, validInput);

    expect(reportError).not.toHaveBeenCalled();
  });

  it("notifies the DISTINCT union of platform ADMIN + SUPPORT staff (overlap deduped, no volunteer roles queried)", async () => {
    // ADMIN_ID also holds SUPPORT — must be notified exactly ONCE.
    const { deps, notificationsCreate, listHumanIdsByStaffRole } = buildDeps({
      adminIds: [ADMIN_ID],
      supportIds: [STAFF_ID, ADMIN_ID],
    });

    await submitEntityReport(deps, validInput);

    expect(listHumanIdsByStaffRole).toHaveBeenCalledWith("ADMIN");
    expect(listHumanIdsByStaffRole).toHaveBeenCalledWith("SUPPORT");
    // Spec v1.1: no volunteer indirection — the COMMUNITY_MODERATOR role is
    // never consulted (the old moderator→ADMIN fallback is gone).
    expect(listHumanIdsByStaffRole).not.toHaveBeenCalledWith(
      "COMMUNITY_MODERATOR",
    );
    const notifiedHumanIds = notificationsCreate.mock.calls.map(
      (call) => (call[0] as { humanId: string }).humanId,
    );
    expect([...notifiedHumanIds].sort()).toEqual(
      [ADMIN_ID, STAFF_ID].sort(),
    );
  });

  it("the reporter is excluded from the staff recipient list", async () => {
    // The reporter is themselves platform staff — they never get pinged
    // about their own report.
    const { deps, notificationsCreate } = buildDeps({
      adminIds: [REPORTER_ID],
      supportIds: [STAFF_ID],
    });

    await submitEntityReport(deps, validInput);

    const notifiedHumanIds = notificationsCreate.mock.calls.map(
      (call) => (call[0] as { humanId: string }).humanId,
    );
    expect(notifiedHumanIds).toEqual([STAFF_ID]);
    expect(notifiedHumanIds).not.toContain(REPORTER_ID);
  });

  it("rejects unknown input keys (.strict()) and bad enum members", async () => {
    const { deps } = buildDeps();

    await expect(
      submitEntityReport(deps, { ...validInput, smuggled: true }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    await expect(
      submitEntityReport(deps, { ...validInput, reason: "MADE_UP" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
