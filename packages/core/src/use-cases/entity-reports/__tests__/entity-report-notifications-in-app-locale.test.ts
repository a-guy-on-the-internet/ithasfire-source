import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { CreateNotificationInput } from "@th/ports/repos/notifications";

import {
  notifyEntityReportReviewed,
  notifyEntityReportSubmitted,
} from "../_shared/entity-report-notifications";
import { renderStoredNotification } from "../../comms/render-stored-notification";
import {
  ADMIN_ID,
  HUMAN_SUBJECT_ID,
  NOW,
  PLACE_ID,
  REPORTER_ID,
  REPORT_ID,
  STAFF_ID,
  makeReport,
} from "./helpers";

// The entity-report in-app rows are written directly (not through `notify`).
// Their English text is pinned EXACTLY as it was before the rows started
// carrying a template. The Spanish re-render is pinned in
// comms/__tests__/notification-copy-locale-direct-a.test.ts.

function makeDeps() {
  const create = vi.fn(async (_input: CreateNotificationInput) => ({
    id: "n1",
    createdAt: NOW,
  }));
  const repos = {
    authz: {
      listHumanIdsByStaffRole: vi.fn(async (role: string) =>
        role === "ADMIN" ? [ADMIN_ID] : [STAFF_ID],
      ),
    },
    notifications: { create },
  } as unknown as Repos;
  return { deps: { repos }, create };
}

describe("entity-report in-app rows: English pinned", () => {
  it("submitted → staff", async () => {
    const { deps, create } = makeDeps();
    await notifyEntityReportSubmitted(deps, {
      report: makeReport({ reason: "CLOSED_OR_GONE" }),
    });
    const expected = (humanId: string) =>
      expect.objectContaining({
        humanId,
        title: "New listing report",
        body: "A visitor reported a place listing (closed or gone).",
        kind: "INFO",
        tags: ["platform", "entity-report"],
        action: { label: "Review report", route: "/platform/reports" },
      });
    expect(create.mock.calls.map(([i]) => i)).toEqual([
      expected(ADMIN_ID),
      expected(STAFF_ID),
    ]);
  });

  it("submitted: profile / impersonation", async () => {
    const { deps, create } = makeDeps();
    await notifyEntityReportSubmitted(deps, {
      report: makeReport({
        subjectType: "HUMAN",
        subjectId: HUMAN_SUBJECT_ID,
        reason: "IMPERSONATION",
      }),
    });
    expect(create.mock.calls[0]![0].body).toBe(
      "A visitor reported a profile listing (impersonation).",
    );
  });

  it("reviewed: resolved with note", async () => {
    const { deps, create } = makeDeps();
    await notifyEntityReportReviewed(deps, {
      report: makeReport({ status: "RESOLVED", reviewNote: "Marked closed." }),
    });
    expect(create.mock.calls.map(([i]) => i)).toEqual([
      expect.objectContaining({
        humanId: REPORTER_ID,
        title: "Your report was resolved",
        body: "Your report on a place listing was reviewed and resolved. Reviewer note: Marked closed.",
        kind: "SUCCESS",
        tags: ["entity-report"],
      }),
    ]);
    expect(create.mock.calls[0]![0].action).toBeUndefined();
    expect(create.mock.calls[0]![0].metadata).toEqual(
      expect.objectContaining({
        reportId: REPORT_ID,
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        status: "RESOLVED",
      }),
    );
  });

  it("reviewed: dismissed, organization, no note", async () => {
    const { deps, create } = makeDeps();
    await notifyEntityReportReviewed(deps, {
      report: makeReport({ status: "DISMISSED", subjectType: "ORGANIZATION" }),
    });
    expect(create.mock.calls.map(([i]) => i)).toEqual([
      expect.objectContaining({
        title: "Your report was reviewed",
        body: "Your report on an organization listing was reviewed and no action was taken.",
        kind: "INFO",
      }),
    ]);
  });
});

function stored(row: CreateNotificationInput) {
  return {
    id: "n1",
    title: row.title ?? null,
    body: row.body,
    action: row.action ?? null,
    metadata: row.metadata ?? null,
    templateKey: row.template?.key ?? null,
    templateVersion: row.template?.version ?? null,
    templateVariables: row.template?.variables ?? null,
    createdAt: NOW,
  };
}

describe("entity-report in-app rows: stored template, re-rendered in Spanish", () => {
  it("submitted", async () => {
    const { deps, create } = makeDeps();
    await notifyEntityReportSubmitted(deps, { report: makeReport() });
    const row = create.mock.calls[0]![0];
    expect(row.template).toEqual({
      key: "entity-report.submitted",
      version: "1",
      variables: {
        reportId: REPORT_ID,
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        reason: "CLOSED_OR_GONE",
      },
    });
    expect(row.metadata).toEqual({
      reportId: REPORT_ID,
      subjectType: "PLACE",
      subjectId: PLACE_ID,
      variant: "entity-report.submitted",
    });
    const es = renderStoredNotification({}, stored(row), "es");
    expect(es.title).toBe("Nuevo reporte de listado");
    expect(es.body).toBe(
      "Alguien reportó un listado de lugar (cerrado o desaparecido).",
    );
    expect(es.action).toEqual({
      label: "Revisar reporte",
      route: "/platform/reports",
    });
  });

  it("reviewed: the reviewer's note stays verbatim", async () => {
    const { deps, create } = makeDeps();
    await notifyEntityReportReviewed(deps, {
      report: makeReport({ status: "RESOLVED", reviewNote: "Marked closed." }),
    });
    const row = create.mock.calls[0]![0];
    expect(row.metadata?.variant).toBe("entity-report.reviewed");
    const es = renderStoredNotification({}, stored(row), "es");
    expect(es.title).toBe("Tu reporte se resolvió");
    expect(es.body).toBe(
      "Revisamos tu reporte sobre un listado de lugar y lo resolvimos. Nota de revisión: Marked closed.",
    );
  });

  it("a payload too large to store: row still written in English, skip reported", async () => {
    const { deps, create } = makeDeps();
    const reportError = vi.fn(() => {
      throw new Error("reporter down");
    });
    const warn = vi.fn();
    const note = "x".repeat(20_000);
    await notifyEntityReportReviewed(
      {
        ...deps,
        reportError,
        logger: { warn, child: () => ({ warn }) } as never,
      },
      { report: makeReport({ status: "RESOLVED", reviewNote: note }) },
    );
    expect(create).toHaveBeenCalledTimes(1);
    const row = create.mock.calls[0]![0];
    expect(row.template).toBeNull();
    expect(row.title).toBe("Your report was resolved");
    expect(row.body).toBe(
      `Your report on a place listing was reviewed and resolved. Reviewer note: ${note}`,
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          variant: "entity-report.reviewed",
          reason: "oversized",
        }),
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      "comms.direct_in_app.template_skipped",
      expect.objectContaining({ variant: "entity-report.reviewed" }),
    );
  });
});
