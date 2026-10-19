import { describe, expect, it, vi } from "vitest";

import type { EventDateStatus } from "@th/types";
import type { EventStatus } from "@th/types/repos/events";

import { rsvpMayReceiveAddress, viewerHoldsLiveRsvp } from "../holder-eligibility";

const EVENT_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const VIEWER = "11111111-1111-4111-8111-111111111111";

function repos(rows: { eventRsvp?: boolean; scheduledNight?: boolean }) {
  const existsForUser = vi.fn(async () => rows.eventRsvp === true);
  const existsForUserOnEvent = vi.fn(async () => rows.scheduledNight === true);
  return {
    repos: {
      eventRsvps: { existsForUser },
      eventDateRsvps: { existsForUserOnEvent },
    } as unknown as Parameters<typeof viewerHoldsLiveRsvp>[0],
    existsForUser,
    existsForUserOnEvent,
  };
}

describe("viewerHoldsLiveRsvp", () => {
  it("an event-level RSVP counts on a live event", async () => {
    const r = repos({ eventRsvp: true });
    expect(await viewerHoldsLiveRsvp(r.repos, { id: EVENT_ID, status: "PUBLISHED" }, VIEWER)).toBe(true);
    expect(r.existsForUserOnEvent).not.toHaveBeenCalled();
  });

  it("a per-night RSVP counts only on a SCHEDULED night", async () => {
    const r = repos({ scheduledNight: true });
    expect(await viewerHoldsLiveRsvp(r.repos, { id: EVENT_ID, status: "PUBLISHED" }, VIEWER)).toBe(true);
    expect(r.existsForUserOnEvent).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: VIEWER,
      dateStatus: "SCHEDULED",
    });
  });

  it("a CANCELLED event releases nothing, and reads no RSVP row", async () => {
    const r = repos({ eventRsvp: true, scheduledNight: true });
    expect(await viewerHoldsLiveRsvp(r.repos, { id: EVENT_ID, status: "CANCELLED" }, VIEWER)).toBe(false);
    expect(r.existsForUser).not.toHaveBeenCalled();
    expect(r.existsForUserOnEvent).not.toHaveBeenCalled();
  });

  it("an ARCHIVED event releases nothing, and reads no RSVP row", async () => {
    const r = repos({ eventRsvp: true, scheduledNight: true });
    expect(await viewerHoldsLiveRsvp(r.repos, { id: EVENT_ID, status: "ARCHIVED" }, VIEWER)).toBe(false);
    expect(r.existsForUser).not.toHaveBeenCalled();
    expect(r.existsForUserOnEvent).not.toHaveBeenCalled();
  });

  it("a known event-RSVP answer is reused instead of read again", async () => {
    const r = repos({ eventRsvp: false });
    expect(
      await viewerHoldsLiveRsvp(r.repos, { id: EVENT_ID, status: "PUBLISHED" }, VIEWER, {
        eventRsvpExists: true,
      }),
    ).toBe(true);
    expect(r.existsForUser).not.toHaveBeenCalled();
  });
});

describe("rsvpMayReceiveAddress", () => {
  it("an event-level RSVP on a live event may receive the street", () => {
    expect(rsvpMayReceiveAddress({ eventStatus: "PUBLISHED" })).toBe(true);
  });

  it("a CANCELLED event releases nothing", () => {
    expect(rsvpMayReceiveAddress({ eventStatus: "CANCELLED" })).toBe(false);
    expect(
      rsvpMayReceiveAddress({ eventStatus: "CANCELLED", dateStatus: "SCHEDULED" }),
    ).toBe(false);
  });

  it("a per-night RSVP counts only on a SCHEDULED night", () => {
    expect(
      rsvpMayReceiveAddress({ eventStatus: "PUBLISHED", dateStatus: "SCHEDULED" }),
    ).toBe(true);
    expect(
      rsvpMayReceiveAddress({ eventStatus: "PUBLISHED", dateStatus: "CANCELLED" }),
    ).toBe(false);
    // An unknown night status fails closed.
    expect(
      rsvpMayReceiveAddress({
        eventStatus: "PUBLISHED",
        dateStatus: "SOMETHING_NEW" as EventDateStatus,
      }),
    ).toBe(false);
  });

  it("an ARCHIVED event releases nothing (archiving keeps the RSVP rows)", () => {
    expect(rsvpMayReceiveAddress({ eventStatus: "ARCHIVED" })).toBe(false);
    expect(
      rsvpMayReceiveAddress({ eventStatus: "ARCHIVED", dateStatus: "SCHEDULED" }),
    ).toBe(false);
  });

  it("DRAFT and COMPLETED events are on the releasing list", () => {
    expect(rsvpMayReceiveAddress({ eventStatus: "COMPLETED" })).toBe(true);
    expect(rsvpMayReceiveAddress({ eventStatus: "DRAFT" })).toBe(true);
  });

  it("an unknown event status fails closed", () => {
    expect(
      rsvpMayReceiveAddress({ eventStatus: "SOMETHING_NEW" as EventStatus }),
    ).toBe(false);
  });

  it("a missing event status fails closed", () => {
    expect(rsvpMayReceiveAddress({ eventStatus: null })).toBe(false);
    expect(rsvpMayReceiveAddress({ eventStatus: undefined })).toBe(false);
  });
});
