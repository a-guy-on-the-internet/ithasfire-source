/**
 * A draft holds its night under FR-001, so a forgotten draft must be
 * discardable, or it blocks the series / its events for good.
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

import { discardOpenCallDraft } from "../discard-open-call-draft";
import { upsertEventApplicationForm } from "../../upsert-event-application-form";
import { upsertSeriesOpenCall } from "../upsert-series-open-call";

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const world = createOpenCallWorld();
  const deps = { repos: world.repos, clock: world.clock as unknown as ClockPort };
  return { world, deps };
}

const draftFields = { postedAt: null, postedByHumanId: null } as const;

describe("discardOpenCallDraft", () => {
  it("deletes a draft event call, audits it, and is idempotent", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, ...draftFields });

    const out = await discardOpenCallDraft(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out).toEqual({ formId: call.id, discarded: true });
    expect(world.forms.find((f) => f.id === call.id)).toBeUndefined();
    expect(world.locks).toContainEqual({ kind: "form_for_update", id: call.id });
    expect(world.audit).toEqual([
      expect.objectContaining({
        entity: "event",
        entityId: OC_EVENT_ID,
        action: "open_call_draft_discarded",
        data: { actorHumanId: OC_EDITOR_ID, formId: call.id, publicId: call.publicId },
      }),
    ]);

    const again = await discardOpenCallDraft(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(again).toEqual({ formId: call.id, discarded: false });
    expect(world.audit).toHaveLength(1);
  });

  it("discards a closed-but-never-posted call (postedAt null), with its questions", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({
      purpose: "PERFORM",
      eventId: OC_EVENT_ID,
      ...draftFields,
      closedAt: world.now,
      closedByHumanId: OC_EDITOR_ID,
    });
    await world.repos.eventApplications.upsertQuestion({
      formId: call.id,
      type: "SHORT_TEXT",
      label: "Your band?",
    });
    const out = await discardOpenCallDraft(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out).toEqual({ formId: call.id, discarded: true });
    expect(world.questions.filter((q) => q.formId === call.id)).toEqual([]);
  });

  it("refuses a stranger before taking any lock or deleting", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, ...draftFields });
    await expect(
      discardOpenCallDraft(deps, { actorHumanId: OC_STRANGER_ID, formId: call.id }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(world.locks).toEqual([]);
    expect(world.forms).toContain(call);
  });

  it("refuses a posted call: Close is how a posted call stops", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    await expect(
      discardOpenCallDraft(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", meta: { reason: "posted" } });
    expect(world.forms).toContain(call);
    expect(world.audit).toEqual([]);
  });

  it("refuses a draft that somehow has submissions (they would cascade away)", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, ...draftFields });
    world.addSubmission(call.id, "WITHDRAWN");
    await expect(
      discardOpenCallDraft(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", meta: { reason: "has_submissions" } });
    expect(world.forms).toContain(call);
  });

  it("an ATTEND form id is not a call: treated as gone, nothing deleted", async () => {
    const { world, deps } = setup();
    world.addEvent({ gateType: "APPLICATION" });
    const attend = world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    const out = await discardOpenCallDraft(deps, { actorHumanId: OC_EDITOR_ID, formId: attend.id });
    expect(out.discarded).toBe(false);
    expect(world.forms).toContain(attend);
  });

  it("takes the series advisory lock for a series call and for an event in a series", async () => {
    const { world, deps } = setup();
    world.addEvent();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 7 * DAY), eventId: OC_EVENT_ID });
    const eventDraft = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, ...draftFields });
    await discardOpenCallDraft(deps, { actorHumanId: OC_EDITOR_ID, formId: eventDraft.id });
    expect(world.locks).toEqual([
      { kind: "series_advisory", id: OC_SERIES_ID },
      { kind: "form_for_update", id: eventDraft.id },
    ]);

    world.locks.length = 0;
    const seriesDraft = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID, ...draftFields });
    await discardOpenCallDraft(deps, { actorHumanId: OC_EDITOR_ID, formId: seriesDraft.id });
    expect(world.locks).toEqual([
      { kind: "series_advisory", id: OC_SERIES_ID },
      { kind: "form_for_update", id: seriesDraft.id },
    ]);
    expect(world.audit.at(-1)).toMatchObject({ entity: "event_series", entityId: OC_SERIES_ID });
  });

  it("a series call needs series edit rights", async () => {
    const { world, deps } = setup();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 7 * DAY) });
    const seriesDraft = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID, ...draftFields });
    await expect(
      discardOpenCallDraft(deps, { actorHumanId: OC_STRANGER_ID, formId: seriesDraft.id }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

describe("drafts count toward one call per night (FR-001), and discarding frees the night", () => {
  it("a draft event call blocks a series call; discarding it unblocks it", async () => {
    const { world, deps } = setup();
    world.addEvent({ startsAt: new Date(world.now.getTime() + 7 * DAY) });
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 7 * DAY), eventId: OC_EVENT_ID });

    const eventDraft = await upsertEventApplicationForm(deps, {
      actorHumanId: OC_EDITOR_ID,
      eventId: OC_EVENT_ID,
      purpose: "PERFORM",
      payKind: "UNPAID",
    });
    expect(eventDraft.openCall?.postedAt).toBeNull();

    await expect(
      upsertSeriesOpenCall(deps, {
        actorHumanId: OC_EDITOR_ID,
        seriesId: OC_SERIES_ID,
        payKind: "UNPAID",
      }),
    ).rejects.toMatchObject({ code: "SERIES_OPEN_CALL_CONFLICT" });

    expect(
      (await discardOpenCallDraft(deps, { actorHumanId: OC_EDITOR_ID, formId: eventDraft.formId }))
        .discarded,
    ).toBe(true);

    const seriesCall = await upsertSeriesOpenCall(deps, {
      actorHumanId: OC_EDITOR_ID,
      seriesId: OC_SERIES_ID,
      payKind: "UNPAID",
    });
    expect(seriesCall.postedAt).toBeNull();
  });

  it("a draft series call blocks an event's own call; discarding it unblocks it", async () => {
    const { world, deps } = setup();
    world.addEvent({ startsAt: new Date(world.now.getTime() + 7 * DAY) });
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 7 * DAY), eventId: OC_EVENT_ID });
    const seriesDraft = await upsertSeriesOpenCall(deps, {
      actorHumanId: OC_EDITOR_ID,
      seriesId: OC_SERIES_ID,
      payKind: "UNPAID",
    });

    const eventCall = {
      actorHumanId: OC_EDITOR_ID,
      eventId: OC_EVENT_ID,
      purpose: "PERFORM" as const,
      payKind: "UNPAID" as const,
    };
    await expect(upsertEventApplicationForm(deps, eventCall)).rejects.toMatchObject({
      code: "OPEN_CALL_COVERED_BY_SERIES",
      meta: { posted: false },
    });

    await discardOpenCallDraft(deps, { actorHumanId: OC_EDITOR_ID, formId: seriesDraft.formId });
    const own = await upsertEventApplicationForm(deps, eventCall);
    expect(own.openCall?.postedAt).toBeNull();
  });
});
