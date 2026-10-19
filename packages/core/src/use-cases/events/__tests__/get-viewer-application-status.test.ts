import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type {
  ApplicationSubmissionStatus,
  EventApplicationSubmissionRecord,
} from "@th/types";

import {
  getViewerApplicationStatus,
  type GetViewerApplicationStatusDeps,
} from "../get-viewer-application-status";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const VIEWER_ID = "33333333-3333-4333-8333-333333333333";
const SUBMISSION_ID = "44444444-4444-4444-8444-444444444444";
const NOTE = "We're at capacity for this one — hope to see you next time.";

function makeSubmission(
  status: ApplicationSubmissionStatus,
  decisionReason: string | null,
): EventApplicationSubmissionRecord {
  return {
    id: SUBMISSION_ID,
    eventId: EVENT_ID,
    humanId: VIEWER_ID,
    contactEmail: "applicant@example.com",
    contactPhone: null,
    status,
    answers: { q1: "a private answer" },
    decisionReason,
    questionsSnapshot: {},
    reviewerHumanId: "55555555-5555-4555-8555-555555555555",
    reviewedAt: new Date("2026-09-30T10:00:00.000Z"),
    approvalToken: "secret-token",
    tokenExpiresAt: null,
    metadata: {},
    createdAt: new Date("2026-09-29T10:00:00.000Z"),
    updatedAt: new Date("2026-09-30T10:00:00.000Z"),
  } as EventApplicationSubmissionRecord;
}

function makeDeps(
  submission: EventApplicationSubmissionRecord | null,
): GetViewerApplicationStatusDeps {
  return {
    repos: {
      eventApplications: {
        getSubmissionByEventAndHuman: vi.fn(async () => submission),
      },
    } as unknown as Pick<Repos, "eventApplications">,
  };
}

describe("getViewerApplicationStatus — the organizer's decline note", () => {
  it("returns decisionReason on a REJECTED submission", async () => {
    const deps = makeDeps(makeSubmission("REJECTED", NOTE));
    const result = await getViewerApplicationStatus(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
    });
    expect(result).toEqual({
      hasSubmission: true,
      submission: {
        id: SUBMISSION_ID,
        status: "REJECTED",
        createdAt: new Date("2026-09-29T10:00:00.000Z"),
        reviewedAt: new Date("2026-09-30T10:00:00.000Z"),
        decisionReason: NOTE,
      },
    });
  });

  it("a REJECTED submission without a note returns null, not undefined", async () => {
    const deps = makeDeps(makeSubmission("REJECTED", null));
    const result = await getViewerApplicationStatus(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
    });
    expect(result.submission?.decisionReason).toBeNull();
  });

  it.each<ApplicationSubmissionStatus>([
    "PENDING",
    "APPROVED",
    "WITHDRAWN",
    "EXPIRED",
    "WAITLISTED",
  ])(
    "a %s submission never carries a note, even a stale one left in the column",
    async (status) => {
      const deps = makeDeps(makeSubmission(status, NOTE));
      const result = await getViewerApplicationStatus(deps, {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER_ID,
      });
      expect(result.submission?.status).toBe(status);
      expect(result.submission?.decisionReason).toBeNull();
    },
  );

  it("exposes only the viewer-facing keys — never answers, contact, token or reviewer", async () => {
    const deps = makeDeps(makeSubmission("REJECTED", NOTE));
    const result = await getViewerApplicationStatus(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
    });
    expect(Object.keys(result.submission ?? {}).sort()).toEqual(
      ["createdAt", "decisionReason", "id", "reviewedAt", "status"].sort(),
    );
  });

  it("reads ONLY the viewer's own row, keyed on (eventId, viewerHumanId)", async () => {
    const deps = makeDeps(makeSubmission("REJECTED", NOTE));
    await getViewerApplicationStatus(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
    });
    expect(
      deps.repos.eventApplications.getSubmissionByEventAndHuman,
    ).toHaveBeenCalledWith(EVENT_ID, "ATTEND", VIEWER_ID);
  });

  it("an anonymous viewer gets no submission and triggers no read", async () => {
    const deps = makeDeps(makeSubmission("REJECTED", NOTE));
    const result = await getViewerApplicationStatus(deps, {
      eventId: EVENT_ID,
      viewerHumanId: null,
    });
    expect(result).toEqual({ hasSubmission: false, submission: null });
    expect(
      deps.repos.eventApplications.getSubmissionByEventAndHuman,
    ).not.toHaveBeenCalled();
  });

  it("no submission → hasSubmission false", async () => {
    const deps = makeDeps(null);
    const result = await getViewerApplicationStatus(deps, {
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
    });
    expect(result).toEqual({ hasSubmission: false, submission: null });
  });

  it("rejects malformed input with a typed validation error", async () => {
    const deps = makeDeps(null);
    await expect(
      getViewerApplicationStatus(deps, {
        eventId: "not-a-uuid",
        viewerHumanId: VIEWER_ID,
      }),
    ).rejects.toBeDefined();
    await expect(
      getViewerApplicationStatus(deps, {
        eventId: EVENT_ID,
        viewerHumanId: VIEWER_ID,
        extra: true,
      }),
    ).rejects.toBeDefined();
  });
});
