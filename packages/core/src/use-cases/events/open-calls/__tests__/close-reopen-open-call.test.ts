/**
 * Open calls v1, step 3 — close (FR-005 + the FR-020 sweep), reopen, and the
 * resolver that later steps read a dated event's call through (FR-001).
 */
import { describe, expect, it } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import {
  OC_EDITOR_ID,
  OC_EVENT_ID,
  OC_SERIES_ID,
  OC_STRANGER_ID,
  createOpenCallWorld,
} from "@th/test-utils/fakes/open-calls";

import { closeOpenCall } from "../close-open-call";
import { reopenOpenCall } from "../reopen-open-call";
import { resolveOpenCallForEvent } from "../_shared/open-call-anchor";

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const world = createOpenCallWorld();
  const deps = { repos: world.repos, clock: world.clock as unknown as ClockPort };
  return { world, deps };
}

describe("closeOpenCall", () => {
  it("sweeps PENDING to REJECTED, leaves decided ones alone, returns the ids", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const p1 = world.addSubmission(call.id, "PENDING");
    const p2 = world.addSubmission(call.id, "PENDING");
    const picked = world.addSubmission(call.id, "APPROVED", { reviewedAt: new Date(0) });
    const told = world.addSubmission(call.id, "REJECTED", { reviewedAt: new Date(0) });
    const withdrawn = world.addSubmission(call.id, "WITHDRAWN");
    // A PENDING application on the event's ATTEND form is not the call's.
    const attend = world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    const guest = world.addSubmission(attend.id, "PENDING");

    const out = await closeOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });

    expect(out.alreadyClosed).toBe(false);
    expect(out.swept).toBe(2);
    expect(new Set(out.sweptSubmissionIds)).toEqual(new Set([p1.id, p2.id]));
    expect(p1).toMatchObject({ status: "REJECTED", reviewedAt: world.now });
    expect(p2).toMatchObject({ status: "REJECTED", reviewedAt: world.now });
    expect(picked).toMatchObject({ status: "APPROVED", reviewedAt: new Date(0) });
    expect(told).toMatchObject({ status: "REJECTED", reviewedAt: new Date(0) });
    expect(withdrawn.status).toBe("WITHDRAWN");
    expect(guest.status).toBe("PENDING");
    expect(call).toMatchObject({ closedAt: world.now, closedByHumanId: OC_EDITOR_ID });
    expect(world.locks).toContainEqual({ kind: "form_for_update", id: call.id });
    expect(world.audit).toContainEqual(
      expect.objectContaining({ action: "open_call_closed", entity: "event", entityId: OC_EVENT_ID }),
    );
  });

  it("is idempotent: a second close changes nothing and sweeps 0", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    world.addSubmission(call.id, "PENDING");
    const first = await closeOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(first.swept).toBe(1);
    // A late PENDING row (only possible through a bug) must not be swept by a
    // repeat close either: a repeat is a no-op.
    const second = await closeOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(second).toMatchObject({
      alreadyClosed: true,
      swept: 0,
      sweptSubmissionIds: [],
      closedAt: first.closedAt,
    });
    expect(world.audit.filter((a) => a.action === "open_call_closed")).toHaveLength(1);
  });

  it("refuses a stranger before taking the lock", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const pending = world.addSubmission(call.id, "PENDING");
    await expect(
      closeOpenCall(deps, { actorHumanId: OC_STRANGER_ID, formId: call.id }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(world.locks).toEqual([]);
    expect(pending.status).toBe("PENDING");
    expect(call.closedAt).toBeNull();
  });

  it("an ATTEND form id is not a call", async () => {
    const { world, deps } = setup();
    world.addEvent({ gateType: "APPLICATION" });
    const attend = world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    await expect(
      closeOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: attend.id }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_FOUND" });
  });

  it("a series call closes under series edit rights", async () => {
    const { world, deps } = setup();
    world.addSeries();
    const call = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    world.addSubmission(call.id, "PENDING", { eventId: null });
    await expect(
      closeOpenCall(deps, { actorHumanId: OC_STRANGER_ID, formId: call.id }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    const out = await closeOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out.swept).toBe(1);
    expect(world.audit).toContainEqual(
      expect.objectContaining({ entity: "event_series", entityId: OC_SERIES_ID }),
    );
  });
});

describe("reopenOpenCall", () => {
  it("reopens an upcoming event's call; swept applications stay told", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const pending = world.addSubmission(call.id, "PENDING");
    await closeOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });

    const out = await reopenOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out).toEqual({ formId: call.id, reopened: true });
    expect(call).toMatchObject({ closedAt: null, closedByHumanId: null });
    expect(pending.status).toBe("REJECTED");
  });

  it("is a no-op on an open call", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    expect(
      await reopenOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id }),
    ).toEqual({ formId: call.id, reopened: false });
  });

  it("is refused once the event has started", async () => {
    const { world, deps } = setup();
    world.addEvent({
      startsAt: new Date(world.now.getTime() - DAY),
      endsAt: new Date(world.now.getTime() + DAY),
    });
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, closedAt: world.now });
    await expect(
      reopenOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id }),
    ).rejects.toMatchObject({
      code: "OPEN_CALL_NOT_REOPENABLE",
      meta: { reason: "last_date_started" },
    });
    expect(call.closedAt).toEqual(world.now);
  });

  it("a multi-date event reopens while a later date is still to come", async () => {
    const { world, deps } = setup();
    world.addEvent({ startsAt: new Date(world.now.getTime() - DAY) });
    world.eventDates.push(
      {
        id: "d1",
        eventId: OC_EVENT_ID,
        ordinal: 1,
        startsAt: new Date(world.now.getTime() - DAY),
        endsAt: null,
        status: "SCHEDULED",
        createdAt: world.now,
        updatedAt: world.now,
      },
      {
        id: "d2",
        eventId: OC_EVENT_ID,
        ordinal: 2,
        startsAt: new Date(world.now.getTime() + 6 * DAY),
        endsAt: null,
        status: "SCHEDULED",
        createdAt: world.now,
        updatedAt: world.now,
      },
    );
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, closedAt: world.now });
    expect(
      (await reopenOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id })).reopened,
    ).toBe(true);
  });

  it("an event whose date rows are ALL cancelled has no live date: not reopenable", async () => {
    const { world, deps } = setup();
    // The event's own start is upcoming, but it has date rows, all called off,
    // so the start is not a fallback date.
    world.addEvent();
    world.eventDates.push({
      id: "d1",
      eventId: OC_EVENT_ID,
      ordinal: 1,
      startsAt: new Date(world.now.getTime() + 6 * DAY),
      endsAt: null,
      status: "CANCELLED",
      createdAt: world.now,
      updatedAt: world.now,
    });
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, closedAt: world.now });
    await expect(
      reopenOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id }),
    ).rejects.toMatchObject({
      code: "OPEN_CALL_NOT_REOPENABLE",
      meta: { reason: "last_date_started" },
    });
  });

  it.each(["CANCELLED", "ARCHIVED"] as const)("is refused on a %s event", async (status) => {
    const { world, deps } = setup();
    world.addEvent({ status });
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, closedAt: world.now });
    await expect(
      reopenOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_REOPENABLE", meta: { reason: "event_ended" } });
  });

  it("a series call reopens only while a live occurrence is still to come", async () => {
    const { world, deps } = setup();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() - DAY) });
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + DAY), status: "CANCELLED" });
    const call = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID, closedAt: world.now });
    await expect(
      reopenOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_REOPENABLE" });

    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 7 * DAY) });
    expect(
      (await reopenOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id })).reopened,
    ).toBe(true);
  });

  it("refuses a stranger", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, closedAt: world.now });
    await expect(
      reopenOpenCall(deps, { actorHumanId: OC_STRANGER_ID, formId: call.id }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

describe("resolveOpenCallForEvent (FR-001)", () => {
  it("the event's own call wins", async () => {
    const { world } = setup();
    world.addEvent();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + DAY), eventId: OC_EVENT_ID });
    const own = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    const resolved = await resolveOpenCallForEvent(world.repos, OC_EVENT_ID, { postedOnly: true });
    expect(resolved).toMatchObject({ via: "event", form: { id: own.id } });
  });

  it("else the series' call", async () => {
    const { world } = setup();
    world.addEvent();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + DAY), eventId: OC_EVENT_ID });
    const seriesCall = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    const resolved = await resolveOpenCallForEvent(world.repos, OC_EVENT_ID, { postedOnly: true });
    expect(resolved).toMatchObject({ via: "series", form: { id: seriesCall.id } });
  });

  it("else null; an ATTEND form never resolves; a DETACHED event is not the series'", async () => {
    const { world } = setup();
    world.addEvent({ gateType: "APPLICATION" });
    world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    expect(await resolveOpenCallForEvent(world.repos, OC_EVENT_ID, { postedOnly: true })).toBeNull();

    world.addSeries();
    world.addOccurrence({
      startsAt: new Date(world.now.getTime() + DAY),
      eventId: OC_EVENT_ID,
      status: "DETACHED",
    });
    world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    expect(await resolveOpenCallForEvent(world.repos, OC_EVENT_ID, { postedOnly: true })).toBeNull();
  });
  it("postedOnly: a draft is found by the organizer tab, never by public callers", async () => {
    const { world } = setup();
    world.addEvent();
    const draft = world.addForm({
      purpose: "PERFORM",
      eventId: OC_EVENT_ID,
      postedAt: null,
      postedByHumanId: null,
    });
    expect(
      await resolveOpenCallForEvent(world.repos, OC_EVENT_ID, { postedOnly: true }),
    ).toBeNull();
    expect(
      await resolveOpenCallForEvent(world.repos, OC_EVENT_ID, { postedOnly: false }),
    ).toMatchObject({ via: "event", form: { id: draft.id } });
  });

  it("postedOnly: a draft series call is hidden from public callers too", async () => {
    const { world } = setup();
    world.addEvent();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + DAY), eventId: OC_EVENT_ID });
    const draft = world.addForm({
      purpose: "PERFORM",
      seriesId: OC_SERIES_ID,
      postedAt: null,
      postedByHumanId: null,
    });
    expect(
      await resolveOpenCallForEvent(world.repos, OC_EVENT_ID, { postedOnly: true }),
    ).toBeNull();
    expect(
      await resolveOpenCallForEvent(world.repos, OC_EVENT_ID, { postedOnly: false }),
    ).toMatchObject({ via: "series", form: { id: draft.id } });
  });
});
