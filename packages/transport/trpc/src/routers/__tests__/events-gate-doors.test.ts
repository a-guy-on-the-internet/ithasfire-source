import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

/**
 * Gated-event "doors" redesign, through the REAL router:
 *  - `getGatedPreview` carries the event's local DAY and nothing about the
 *    place (no zone: "America/Chicago" names a city), and answers the same for every viewer (it feeds an
 *    edge-cached, identity-free document);
 *  - `getViewerApplicationStatus` carries the organizer's decline note on a
 *    REJECTED submission, keyed on the SESSION's human only.
 */

const EVENT_ID = "44444444-4444-4444-8444-444444444444";
const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const STARTS_AT = new Date("2026-10-10T01:00:00.000Z");

const gatedEventRepos = () =>
  ({
    events: {
      getById: vi.fn(async (id: string) =>
        id === EVENT_ID
          ? {
              id: EVENT_ID,
              slug: "secret-show",
              title: "Secret Show",
              status: "PUBLISHED",
              publishedAt: new Date("2026-07-01T00:00:00.000Z"),
              gateType: "PASSWORD",
              startsAt: STARTS_AT,
              timezone: "America/Chicago",
              recurrenceSchedule: null,
              city: "Nashville",
              region: "TN",
              addressLine1: "1 Secret St",
              locationLabel: "The Back Room",
            }
          : null,
      ),
    },
    images: { getPrimaryImageRefs: vi.fn(async () => new Map()) },
    imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
    eventDates: { listUpcoming: vi.fn(async () => []) },
  }) as unknown as Ctx["repos"];

describe("events.getGatedPreview — the gate shows the date, never the place", () => {
  it("returns the local day only — no instant, no zone, no location keys", async () => {
    const { caller } = createCaller(eventsRouter, {
      repos: gatedEventRepos(),
      actorHumanId: null,
    });

    const result = await caller.getGatedPreview({ eventId: EVENT_ID });

    expect(result).toEqual({
      eventId: EVENT_ID,
      slug: "secret-show",
      title: "Secret Show",
      heroImageUrl: null,
      // 01:00Z on the 10th is the evening of the 9th in Chicago.
      gateDate: "2026-10-09",
    });
  });

  it("is identity-free: a signed-in viewer gets byte-identical output to an anonymous one", async () => {
    const anon = createCaller(eventsRouter, {
      repos: gatedEventRepos(),
      actorHumanId: null,
      auth: null,
    });
    const signedIn = createCaller(eventsRouter, {
      repos: gatedEventRepos(),
      actorHumanId: VIEWER_ID,
    });

    const a = await anon.caller.getGatedPreview({ eventId: EVENT_ID });
    const b = await signedIn.caller.getGatedPreview({ eventId: EVENT_ID });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

const submissionRepos = (
  status: string,
  decisionReason: string | null,
  ownerHumanId = VIEWER_ID,
) => {
  const getSubmissionByEventAndHuman = vi.fn(
    // (eventId, purpose, humanId) since open calls v1: the attendee status
    // reads the ATTEND form only.
    async (eventId: string, purpose: string, humanId: string) =>
      eventId === EVENT_ID && purpose === "ATTEND" && humanId === ownerHumanId
        ? {
            id: "55555555-5555-4555-8555-555555555555",
            formId: "f0000000-0000-4000-8000-00000000000f",
            purpose: "ATTEND",
            eventId: EVENT_ID,
            humanId: ownerHumanId,
            contactEmail: "applicant@example.com",
            contactPhone: null,
            status,
            answers: { q1: "private" },
            decisionReason,
            questionsSnapshot: {},
            reviewerHumanId: null,
            reviewedAt: new Date("2026-09-30T10:00:00.000Z"),
            approvalToken: "secret-token",
            tokenExpiresAt: null,
            metadata: {},
            createdAt: new Date("2026-09-29T10:00:00.000Z"),
            updatedAt: new Date("2026-09-30T10:00:00.000Z"),
          }
        : null,
  );
  return {
    repos: {
      eventApplications: { getSubmissionByEventAndHuman },
    } as unknown as Ctx["repos"],
    getSubmissionByEventAndHuman,
  };
};

describe("events.getViewerApplicationStatus — the decline note", () => {
  it("carries decisionReason on the viewer's own REJECTED submission", async () => {
    const { repos } = submissionRepos("REJECTED", "Full this time, sorry.");
    const { caller } = createCaller(eventsRouter, {
      repos,
      actorHumanId: VIEWER_ID,
    });

    const result = await caller.getViewerApplicationStatus({
      eventId: EVENT_ID,
    });

    expect(result).toEqual({
      hasSubmission: true,
      submission: {
        id: "55555555-5555-4555-8555-555555555555",
        status: "REJECTED",
        createdAt: new Date("2026-09-29T10:00:00.000Z"),
        reviewedAt: new Date("2026-09-30T10:00:00.000Z"),
        decisionReason: "Full this time, sorry.",
      },
    });
  });

  it("nulls a stale note on a non-REJECTED submission", async () => {
    const { repos } = submissionRepos("PENDING", "left over from a rescind");
    const { caller } = createCaller(eventsRouter, {
      repos,
      actorHumanId: VIEWER_ID,
    });

    const result = await caller.getViewerApplicationStatus({
      eventId: EVENT_ID,
    });
    expect(result.submission.decisionReason).toBeNull();
  });

  it("keys on the SESSION's human, so another applicant's note is unreachable", async () => {
    const other = "66666666-6666-4666-8666-666666666666";
    const { repos, getSubmissionByEventAndHuman } = submissionRepos(
      "REJECTED",
      "someone else's note",
      other,
    );
    const { caller } = createCaller(eventsRouter, {
      repos,
      actorHumanId: VIEWER_ID,
    });

    const result = await caller.getViewerApplicationStatus({
      eventId: EVENT_ID,
    });
    expect(result).toEqual({ hasSubmission: false, submission: null });
    expect(getSubmissionByEventAndHuman).toHaveBeenCalledWith(
      EVENT_ID,
      "ATTEND",
      VIEWER_ID,
    );
  });

  it("ignores a client-supplied viewer id — the session decides", async () => {
    const { repos, getSubmissionByEventAndHuman } = submissionRepos(
      "REJECTED",
      "note",
    );
    const { caller } = createCaller(eventsRouter, {
      repos,
      actorHumanId: null,
    });

    const result = await caller.getViewerApplicationStatus({
      eventId: EVENT_ID,
      viewerHumanId: VIEWER_ID,
    });
    // The procedure input is a non-strict object: an extra key is stripped,
    // never honoured. Anonymous stays anonymous.
    expect(result).toEqual({ hasSubmission: false, submission: null });
    expect(getSubmissionByEventAndHuman).not.toHaveBeenCalled();
  });
});
