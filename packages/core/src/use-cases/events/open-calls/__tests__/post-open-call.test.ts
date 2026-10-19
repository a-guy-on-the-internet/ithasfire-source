/**
 * Owner ruling Q41: saving makes a DRAFT call; "Post call" makes it public.
 */
import { describe, expect, it } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import {
  OC_EDITOR_ID,
  OC_EVENT_ID,
  OC_ORG_ID,
  OC_SERIES_ID,
  OC_STRANGER_ID,
  createOpenCallWorld,
} from "@th/test-utils/fakes/open-calls";

import { closeOpenCall } from "../close-open-call";
import { getPublicOpenCall } from "../get-public-open-call";
import { listPosterOpenCalls } from "../list-poster-open-calls";
import { postOpenCall } from "../post-open-call";
import { reopenOpenCall } from "../reopen-open-call";
import { upsertEventApplicationForm } from "../../upsert-event-application-form";
import { upsertSeriesOpenCall } from "../upsert-series-open-call";

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const world = createOpenCallWorld();
  const deps = { repos: world.repos, clock: world.clock as unknown as ClockPort };
  return { world, deps };
}

describe("postOpenCall", () => {
  it("a saved call is a draft until posted: hidden, unlisted; then public and listed", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const saved = await upsertEventApplicationForm(deps, {
      actorHumanId: OC_EDITOR_ID,
      eventId: OC_EVENT_ID,
      purpose: "PERFORM",
      payKind: "UNPAID",
    });
    expect(saved.openCall?.postedAt).toBeNull();
    const publicId = saved.openCall!.publicId;

    await expect(getPublicOpenCall(deps, { publicId })).rejects.toMatchObject({
      code: "OPEN_CALL_NOT_FOUND",
    });
    expect(
      (await listPosterOpenCalls(deps, { poster: { kind: "org", orgId: OC_ORG_ID } })).calls,
    ).toEqual([]);

    const posted = await postOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: saved.formId });
    expect(posted).toEqual({
      formId: saved.formId,
      publicId,
      postedAt: world.now,
      alreadyPosted: false,
    });
    expect(world.forms[0]).toMatchObject({ postedAt: world.now, postedByHumanId: OC_EDITOR_ID });
    expect(world.audit.map((a) => a.action)).toContain("open_call_posted");

    expect((await getPublicOpenCall(deps, { publicId })).publicId).toBe(publicId);
    expect(
      (await listPosterOpenCalls(deps, { poster: { kind: "org", orgId: OC_ORG_ID } })).calls,
    ).toHaveLength(1);
  });

  it("is idempotent: posting again changes nothing", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, postedAt: null, postedByHumanId: null });
    const first = await postOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    const auditCount = world.audit.length;
    const second = await postOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(second).toEqual({ ...first, alreadyPosted: true });
    expect(world.audit).toHaveLength(auditCount);
  });

  it("refuses a stranger before taking any lock or writing", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, postedAt: null, postedByHumanId: null });
    await expect(
      postOpenCall(deps, { actorHumanId: OC_STRANGER_ID, formId: call.id }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(world.locks).toEqual([]);
    expect(call.postedAt).toBeNull();
  });

  it("re-validates the stored pay", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({
      purpose: "PERFORM",
      eventId: OC_EVENT_ID,
      payKind: "FIXED",
      payDetails: null,
      postedAt: null,
      postedByHumanId: null,
    });
    await expect(
      postOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      issues: [expect.objectContaining({ message: "pay_details_required" })],
    });
    expect(call.postedAt).toBeNull();
  });

  it("refuses an ended anchor: a started event, a cancelled event, a series with no date ahead", async () => {
    const { world, deps } = setup();
    world.addEvent({ startsAt: new Date(world.now.getTime() - DAY) });
    const started = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, postedAt: null, postedByHumanId: null });
    await expect(
      postOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: started.id }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_EDITABLE", meta: { reason: "last_date_started" } });

    world.events.get(OC_EVENT_ID)!.startsAt = new Date(world.now.getTime() + DAY);
    world.events.get(OC_EVENT_ID)!.status = "CANCELLED";
    await expect(
      postOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: started.id }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_EDITABLE", meta: { reason: "event_ended" } });

    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() - DAY) });
    const seriesCall = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID, postedAt: null, postedByHumanId: null });
    await expect(
      postOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: seriesCall.id }),
    ).rejects.toMatchObject({ code: "SERIES_INACTIVE", meta: { reason: "last_date_started" } });
  });

  it("refuses a closed-but-never-posted call (data repair only)", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({
      purpose: "PERFORM",
      eventId: OC_EVENT_ID,
      postedAt: null,
      postedByHumanId: null,
      closedAt: world.now,
    });
    await expect(
      postOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", meta: { reason: "closed" } });
  });

  it("an ATTEND form id is not a call", async () => {
    const { world, deps } = setup();
    world.addEvent({ gateType: "APPLICATION" });
    const attend = world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    await expect(
      postOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: attend.id }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_FOUND" });
  });

  it("a series call posts under series edit rights", async () => {
    const { world, deps } = setup();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 7 * DAY) });
    const saved = await upsertSeriesOpenCall(deps, {
      actorHumanId: OC_EDITOR_ID,
      seriesId: OC_SERIES_ID,
      payKind: "UNPAID",
    });
    expect(saved.postedAt).toBeNull();
    await expect(
      postOpenCall(deps, { actorHumanId: OC_STRANGER_ID, formId: saved.formId }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(
      (await postOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: saved.formId })).alreadyPosted,
    ).toBe(false);
  });
});

describe("draft calls elsewhere", () => {
  it("reopen is refused on a draft", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, postedAt: null, postedByHumanId: null });
    await expect(
      reopenOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_REOPENABLE", meta: { reason: "not_posted" } });
  });

  it("closing a draft is a harmless no-op, and the draft can still be posted", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, postedAt: null, postedByHumanId: null });
    const out = await closeOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id });
    expect(out).toEqual({
      formId: call.id,
      closedAt: null,
      posted: false,
      alreadyClosed: false,
      swept: 0,
      sweptSubmissionIds: [],
    });
    expect(call.closedAt).toBeNull();
    expect(world.audit).toEqual([]);
    expect(
      (await postOpenCall(deps, { actorHumanId: OC_EDITOR_ID, formId: call.id })).alreadyPosted,
    ).toBe(false);
  });
});
