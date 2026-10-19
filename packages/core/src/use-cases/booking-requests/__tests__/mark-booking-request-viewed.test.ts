import { describe, expect, it, vi } from "vitest";

import type { OrgMembership } from "@th/ports/repos/authz";
import type {
  BookingRequestRecord,
  BookingRequestStatus,
} from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";

import { markBookingRequestViewed } from "../mark-booking-request-viewed";
import type { MarkBookingRequestViewedDeps } from "../mark-booking-request-viewed";
import {
  ACTOR_ID,
  NOW,
  ORG_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildPlaceRecord,
  withTx,
} from "./helpers";

type BuildDepsOptions = {
  request?: BookingRequestRecord | null;
  place?: PlaceRecord | null;
  memberships?: OrgMembership[];
  /** Simulate the adapter CAS losing to a concurrent transition. */
  markViewedConflict?: boolean;
};

function buildDeps(options: BuildDepsOptions = {}) {
  const request =
    options.request === undefined
      ? buildBookingRequestRecord()
      : options.request;

  const bookingRequests = {
    getById: vi.fn(async () => request),
    markViewed: vi.fn(
      async ({
        now,
        expectedFrom,
      }: {
        id: string;
        now: Date;
        expectedFrom: readonly BookingRequestStatus[];
      }) => {
        if (
          options.markViewedConflict ||
          !request ||
          !expectedFrom.includes(request.status)
        ) {
          throw {
            code: "conflict",
            message: "booking_request_status_changed",
          } as const;
        }
        return buildBookingRequestRecord({ status: "VIEWED", viewedAt: now });
      },
    ),
  };
  const places = {
    getById: vi.fn(async () =>
      options.place === undefined ? buildPlaceRecord() : options.place,
    ),
  };
  const authz = {
    getOrgMemberships: vi.fn(async () => options.memberships ?? []),
  };
  const audit = { log: vi.fn(async () => {}) };

  const mocks = { bookingRequests, places, authz, audit };

  const deps: MarkBookingRequestViewedDeps = {
    repos: withTx(mocks) as unknown as MarkBookingRequestViewedDeps["repos"],
    clock: { now: () => NOW },
  };

  return { deps, mocks };
}

describe("markBookingRequestViewed", () => {
  it("stamps PENDING → VIEWED and audits", async () => {
    const { deps, mocks } = buildDeps();

    const result = await markBookingRequestViewed(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(result).toEqual({
      bookingRequestId: REQUEST_ID,
      status: "VIEWED",
      viewedAt: NOW,
    });
    expect(mocks.bookingRequests.markViewed).toHaveBeenCalledWith({
      id: REQUEST_ID,
      now: NOW,
      expectedFrom: ["PENDING"],
    });
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking_request.viewed" }),
    );
  });

  it("is a no-op for an already-VIEWED request", async () => {
    const viewedAt = new Date("2026-06-09T00:00:00.000Z");
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({ status: "VIEWED", viewedAt }),
    });

    const result = await markBookingRequestViewed(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(result.status).toBe("VIEWED");
    expect(result.viewedAt).toEqual(viewedAt);
    expect(mocks.bookingRequests.markViewed).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it("rejects terminal statuses with invalid_status and never writes", async () => {
    const { deps, mocks } = buildDeps({
      request: buildBookingRequestRecord({ status: "DECLINED" }),
    });

    await expect(
      markBookingRequestViewed(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS" });

    // A DECLINED request must never be resurrected to VIEWED — guarded both
    // here (pre-check) and at write time (expectedFrom: ["PENDING"]).
    expect(mocks.bookingRequests.markViewed).not.toHaveBeenCalled();
  });

  it("allows an org VIEWER to stamp VIEWED (membership-any, not money-adjacent)", async () => {
    const { deps } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: [],
        orgIdsWithAccess: [ORG_ID],
      }),
      memberships: [{ orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" }],
    });

    const result = await markBookingRequestViewed(deps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
    });

    expect(result.status).toBe("VIEWED");
  });

  it("surfaces a conflict when the row left PENDING between read and write", async () => {
    const { deps } = buildDeps({ markViewedConflict: true });

    await expect(
      markBookingRequestViewed(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "booking_request_status_changed",
    });
  });

  it("rejects a non-owner with forbidden", async () => {
    const { deps } = buildDeps({
      place: buildPlaceRecord({
        humanIdsWithAccess: ["12121212-1212-4121-8121-121212121212"],
      }),
    });

    await expect(
      markBookingRequestViewed(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("throws not_found for a missing request", async () => {
    const { deps } = buildDeps({ request: null });

    await expect(
      markBookingRequestViewed(deps, {
        actorHumanId: ACTOR_ID,
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
  });
});
