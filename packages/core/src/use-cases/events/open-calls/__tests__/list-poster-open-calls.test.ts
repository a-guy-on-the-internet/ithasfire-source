/**
 * Open calls v1, step 3 — the poster's public page lists its open calls (FR-003).
 */
import { describe, expect, it } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import {
  OC_EDITOR_ID,
  OC_ORG_ID,
  OC_OTHER_ORG_ID,
  OC_SERIES_ID,
  createOpenCallWorld,
} from "@th/test-utils/fakes/open-calls";

import { listPosterOpenCalls } from "../list-poster-open-calls";

const DAY = 24 * 60 * 60 * 1000;

describe("listPosterOpenCalls", () => {
  it("lists open calls by next date, card fields only", async () => {
    const world = createOpenCallWorld();
    const deps = { repos: world.repos, clock: world.clock as unknown as ClockPort };
    const later = world.addEvent({
      id: "20000000-0000-4000-8000-000000000101",
      title: "Later show",
      startsAt: new Date(world.now.getTime() + 20 * DAY),
    });
    const draft = world.addEvent({
      id: "20000000-0000-4000-8000-000000000102",
      title: "Draft show",
      status: "DRAFT",
      startsAt: new Date(world.now.getTime() + 4 * DAY),
    });
    const priv = world.addEvent({
      id: "20000000-0000-4000-8000-000000000103",
      visibility: "PRIVATE",
    });
    const closed = world.addEvent({ id: "20000000-0000-4000-8000-000000000104" });
    const other = world.addEvent({ id: "20000000-0000-4000-8000-000000000105", orgId: OC_OTHER_ORG_ID });
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 7 * DAY) });

    const laterCall = world.addForm({ purpose: "PERFORM", eventId: later.id, payKind: "FIXED" });
    const draftEventCall = world.addForm({ purpose: "PERFORM", eventId: draft.id });
    world.addForm({ purpose: "PERFORM", eventId: priv.id });
    world.addForm({ purpose: "PERFORM", eventId: closed.id, closedAt: world.now });
    world.addForm({ purpose: "PERFORM", eventId: other.id });
    world.addForm({ purpose: "ATTEND", eventId: later.id });
    const seriesCall = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });

    const out = await listPosterOpenCalls(deps, { poster: { kind: "org", orgId: OC_ORG_ID } });
    expect(out.calls.map((c) => c.publicId)).toEqual([
      draftEventCall.publicId,
      seriesCall.publicId,
      laterCall.publicId,
    ]);
    expect(out.calls[2]).toEqual({
      publicId: laterCall.publicId,
      anchor: "event",
      title: "Later show",
      payKind: "FIXED",
      closesAt: null,
      nextStartsAt: later.startsAt,
      timezone: "America/Chicago",
    });
  });

  it("a person's calls, and a banned poster lists nothing", async () => {
    const world = createOpenCallWorld();
    const deps = { repos: world.repos, clock: world.clock as unknown as ClockPort };
    const mine = world.addEvent({ orgId: null, humanId: OC_EDITOR_ID });
    world.addForm({ purpose: "PERFORM", eventId: mine.id });
    expect(
      (await listPosterOpenCalls(deps, { poster: { kind: "human", humanId: OC_EDITOR_ID } })).calls,
    ).toHaveLength(1);
    world.bannedOwnerIds.add(OC_EDITOR_ID);
    expect(
      (await listPosterOpenCalls(deps, { poster: { kind: "human", humanId: OC_EDITOR_ID } })).calls,
    ).toEqual([]);
  });

  it("rejects a malformed poster", async () => {
    const world = createOpenCallWorld();
    const deps = { repos: world.repos, clock: world.clock as unknown as ClockPort };
    await expect(
      listPosterOpenCalls(deps, { poster: { kind: "org", humanId: OC_EDITOR_ID } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
