import { describe, expect, it, vi } from "vitest";

import { listBookingRequests } from "../list-booking-requests";
import type { ListBookingRequestsDeps } from "../list-booking-requests";
import {
  ACTOR_ID,
  NOW,
  OTHER_HUMAN_ID,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
  buildStageRepos,
  buildUnreadCountingRepo,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Booking-holds WORKFLOW projection on the list surfaces (FR-011 / FR-013 /
// FR-015 / FR-017): holds for everyone (own by construction), assignee and
// tags for the venue side only, batched, degrade-to-empty + reportError.
// ─────────────────────────────────────────────────────────────────────────────

const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECOND_REQUEST_ID = "45454545-4545-4545-8545-454545454545";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function buildDeps(options: { workflowError?: Error } = {}) {
  const place = buildPlaceRecord({ timezone: "America/Chicago" });
  const first = buildBookingRequestRecord({ id: REQUEST_ID, assigneeHumanId: OTHER_HUMAN_ID, performerOwnerId: ACTOR_ID });
  const second = buildBookingRequestRecord({ id: SECOND_REQUEST_ID, performerOwnerId: OTHER_HUMAN_ID });
  const records = [first, second];
  const stage = buildStageRepos({});

  const live = stage.bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-07-10" });
  // Deadline passed — projected as lapsed, never written.
  const lapsed = stage.bookingHolds.seed({
    bookingRequestId: REQUEST_ID,
    calendarId: CALENDAR_ID,
    date: "2026-07-11",
    status: "CHALLENGED",
    respondBy: new Date(NOW.getTime() - 1),
  });
  stage.bookingHolds.seed({ bookingRequestId: REQUEST_ID, calendarId: CALENDAR_ID, date: "2026-05-01", status: "RELEASED", releasedReason: "MANUAL" });
  const tag = stage.bookingTags.seedTag({ orgId: ORG_ID, name: "Locals", color: "info" });
  stage.bookingTags.joins.set(REQUEST_ID, [tag.id]);

  if (options.workflowError) {
    stage.bookingHolds.listLiveForRequests = vi.fn(async () => {
      throw options.workflowError;
    });
  }

  const reportError = vi.fn();
  const deps: ListBookingRequestsDeps = {
    repos: {
      bookingRequests: {
        listForPlace: vi.fn(async () => records),
        listForPerformer: vi.fn(async () => [first]),
      },
      places: { getById: vi.fn(async () => place) },
      authz: { getOrgMemberships: vi.fn(async () => []) },
      humans: { getByIds: vi.fn(async () => []) },
      organizations: { getByIds: vi.fn(async () => []) },
      bookingRequestMessages: buildUnreadCountingRepo(),
      agreements: stage.agreements,
      events: stage.events,
      bookingHolds: stage.bookingHolds,
      bookingTags: stage.bookingTags,
    } as unknown as ListBookingRequestsDeps["repos"],
    clock: { now: () => NOW },
    reportError,
  };
  return { deps, stage, live, lapsed, tag, reportError };
}

describe("listBookingRequests — booking-holds workflow projection", () => {
  it("venue scope: projects live holds (with lapsed), assignee and tags in ONE batched read each", async () => {
    const { deps, stage, live, lapsed, tag } = buildDeps();

    const result = await listBookingRequests(deps, { actorHumanId: ACTOR_ID, scope: "venue", placeId: PLACE_ID });

    const [first, second] = result.requests;
    expect(first).toMatchObject({
      id: REQUEST_ID,
      assigneeHumanId: OTHER_HUMAN_ID,
      tags: [{ id: tag.id, name: "Locals", color: "info" }],
    });
    expect(first!.holds).toEqual([
      // `askedFor` (P5-fixes): the request asked for 2026-07-10 only.
      { id: live.id, calendarId: CALENDAR_ID, date: "2026-07-10", position: 1, status: "ACTIVE", respondBy: null, lapsed: false, askedFor: true },
      { id: lapsed.id, calendarId: CALENDAR_ID, date: "2026-07-11", position: 1, status: "CHALLENGED", respondBy: lapsed.respondBy, lapsed: true, askedFor: false },
    ]);
    expect(second).toMatchObject({ id: SECOND_REQUEST_ID, holds: [], assigneeHumanId: null, tags: [] });

    expect(stage.bookingHolds.listLiveForRequests).toHaveBeenCalledTimes(1);
    expect(stage.bookingHolds.listLiveForRequests).toHaveBeenCalledWith([REQUEST_ID, SECOND_REQUEST_ID]);
    expect(stage.bookingTags.listForRequests).toHaveBeenCalledTimes(1);
    // Reads never write.
    expect(stage.bookingHolds.updateStatus).not.toHaveBeenCalled();
    expect(stage.bookingHolds.rows.get(lapsed.id)?.status).toBe("CHALLENGED");
  });

  it("performer scope: own holds YES; assignee and tags are venue-internal (null / [] and never read)", async () => {
    const { deps, stage, live } = buildDeps();

    const result = await listBookingRequests(deps, { actorHumanId: ACTOR_ID, scope: "performer" });

    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ id: REQUEST_ID, assigneeHumanId: null, tags: [] });
    expect(result.requests[0]!.holds.map((h) => h.id)).toEqual([live.id, expect.any(String)]);
    // FR-013: the act's hold summary never names the venue's calendar.
    expect(result.requests[0]!.holds.map((h) => h.calendarId)).toEqual([null, null]);
    expect(stage.bookingTags.listForRequests).not.toHaveBeenCalled();
  });

  it("degrades to no holds / no tags and REPORTS when the batched read fails", async () => {
    const error = new Error("holds down");
    const { deps, reportError } = buildDeps({ workflowError: error });

    const result = await listBookingRequests(deps, { actorHumanId: ACTOR_ID, scope: "venue", placeId: PLACE_ID });

    expect(result.requests.map((r) => r.holds)).toEqual([[], []]);
    expect(result.requests.map((r) => r.tags)).toEqual([[], []]);
    expect(reportError).toHaveBeenCalledWith(error, expect.objectContaining({ tags: expect.objectContaining({ step: "bookingWorkflow" }) }));
  });
});
