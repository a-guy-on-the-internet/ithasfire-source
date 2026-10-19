/**
 * Open calls v1, step 3 — the public call page (FR-003, NFR-005, FR-021).
 */
import { describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import {
  OC_EVENT_ID,
  OC_ORG_ID,
  OC_PLACE_ID,
  OC_SERIES_ID,
  createOpenCallWorld,
} from "@th/test-utils/fakes/open-calls";

import { getPublicOpenCall } from "../get-public-open-call";

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const world = createOpenCallWorld();
  const deps = { repos: world.repos, clock: world.clock as unknown as ClockPort };
  return { world, deps };
}

const lineupRow = (eventId: string, name: string, role = "PERFORMER"): EventHumanRecord =>
  ({
    id: crypto.randomUUID(),
    eventId,
    humanId: null,
    orgId: null,
    externalName: name,
    externalUrl: null,
    role,
    customRoleLabel: null,
    sortOrder: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    profileSlug: null,
    humanDisplayName: null,
  }) as EventHumanRecord;

const place = (locationMode: "EXACT" | "OBSCURED") => ({
  id: OC_PLACE_ID,
  name: "The Back Room",
  locationMode,
  locationRadiusMeters: locationMode === "EXACT" ? null : 800,
  locationLabel: null,
  formattedAddress: "500 Hidden Ln, Minneapolis, MN 55401",
  city: "Minneapolis",
  region: "MN",
  postalCode: "55401",
  countryCode: "US",
  lat: 44.95,
  lng: -93.2,
  orgIdsWithAccess: [OC_ORG_ID],
  humanIdsWithAccess: [],
  acceptsCommunityListings: false,
});

describe("getPublicOpenCall", () => {
  it("works while the event is a DRAFT, and shows the call", async () => {
    const { world, deps } = setup();
    const event = world.addEvent({ status: "DRAFT", title: "Unannounced show" });
    const call = world.addForm({
      purpose: "PERFORM",
      eventId: event.id,
      introText: "Looking for two bands",
      payKind: "FIXED",
      payDetails: "$200 each",
      closesAt: new Date(world.now.getTime() + 3 * DAY),
    });
    world.questions.push({
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      formId: call.id,
      type: "SHORT_TEXT",
      label: "Link to your music",
      description: null,
      options: null,
      isRequired: true,
      order: 0,
      createdAt: world.now,
      updatedAt: world.now,
    });

    const out = await getPublicOpenCall(deps, { publicId: call.publicId });

    expect(out).toMatchObject({
      publicId: call.publicId,
      anchor: "event",
      title: "Unannounced show",
      introText: "Looking for two bands",
      pay: { kind: "FIXED", details: "$200 each" },
      closed: false,
      closedReason: null,
      acceptingApplications: true,
      dates: [{ startsAt: event.startsAt, endsAt: event.endsAt }],
    });
    expect(out.questions).toEqual([
      expect.objectContaining({ label: "Link to your music", isRequired: true }),
    ]);
  });

  it("NOT_FOUND for an ATTEND form's publicId, an unknown id, and a banned owner", async () => {
    const { world, deps } = setup();
    world.addEvent({ gateType: "APPLICATION" });
    const attend = world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    await expect(getPublicOpenCall(deps, { publicId: attend.publicId })).rejects.toMatchObject({
      code: "OPEN_CALL_NOT_FOUND",
    });
    await expect(getPublicOpenCall(deps, { publicId: "nosuchcall" })).rejects.toMatchObject({
      code: "OPEN_CALL_NOT_FOUND",
    });
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    world.bannedOwnerIds.add(OC_ORG_ID);
    await expect(getPublicOpenCall(deps, { publicId: call.publicId })).rejects.toMatchObject({
      code: "OPEN_CALL_NOT_FOUND",
    });
  });

  it("exposes no submission data, no event id and no slug", async () => {
    const { world, deps } = setup();
    world.addEvent({ slug: "secret-slug" } as never);
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const sub = world.addSubmission(call.id, "PENDING", { answers: { q: "my private pitch" } });
    const out = await getPublicOpenCall(deps, { publicId: call.publicId });
    const wire = JSON.stringify(out);
    expect(wire).not.toContain(sub.id);
    expect(wire).not.toContain("my private pitch");
    expect(wire).not.toContain(sub.humanId!);
    expect(wire).not.toContain(OC_EVENT_ID);
    expect(wire).not.toContain(call.id);
    expect(wire).not.toContain("secret-slug");
    expect(Object.keys(out).sort()).toEqual(
      [
        "acceptingApplications",
        "anchor",
        "bookedSoFar",
        "closed",
        "closedReason",
        "closesAt",
        "dates",
        "introText",
        "location",
        "opensAt",
        "pay",
        "publicId",
        "questions",
        "timezone",
        "title",
      ].sort(),
    );
  });

  describe("address withholding (NFR-005)", () => {
    it("an EXACT, ungated event shows its address", async () => {
      const { world, deps } = setup();
      world.addEvent();
      const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
      const out = await getPublicOpenCall(deps, { publicId: call.publicId });
      expect(out.location).toMatchObject({
        mode: "EXACT",
        addressText: "12 Elm St, Minneapolis, MN 55401",
      });
    });

    it("an OBSCURED event shows no street and no postcode", async () => {
      const { world, deps } = setup();
      world.addEvent({ locationMode: "OBSCURED", locationRadiusMeters: 500 });
      const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
      const out = await getPublicOpenCall(deps, { publicId: call.publicId });
      expect(out.location).toMatchObject({ mode: "OBSCURED", addressText: null, postalCode: null });
      expect(JSON.stringify(out)).not.toContain("12 Elm St");
    });

    it("a venue that withholds its address is a floor over an EXACT event row", async () => {
      const { world, deps } = setup();
      // The event's org runs the venue, so the venue counts as confirmed and
      // is named; its address still stays withheld.
      world.places.set(OC_PLACE_ID, place("OBSCURED"));
      world.addEvent({ placeId: OC_PLACE_ID });
      const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
      const out = await getPublicOpenCall(deps, { publicId: call.publicId });
      expect(out.location).toMatchObject({
        mode: "OBSCURED",
        addressText: null,
        placeName: "The Back Room",
      });
      const wire = JSON.stringify(out);
      expect(wire).not.toContain("12 Elm St");
      expect(wire).not.toContain("500 Hidden Ln");
    });

    it("a venue that has not confirmed the event is not named", async () => {
      const { world, deps } = setup();
      world.places.set(OC_PLACE_ID, { ...place("EXACT"), orgIdsWithAccess: [] });
      world.addEvent({ placeId: OC_PLACE_ID });
      const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
      const out = await getPublicOpenCall(deps, { publicId: call.publicId });
      expect(out.location?.placeName).toBeNull();
    });

    it("a gated event is label only (no coordinates)", async () => {
      const { world, deps } = setup();
      world.addEvent({ gateType: "APPLICATION" });
      const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
      const out = await getPublicOpenCall(deps, { publicId: call.publicId });
      expect(out.location).toMatchObject({ lat: null, lng: null, radiusMeters: null });
    });

    it("a failed venue read degrades to hidden and is reported", async () => {
      const { world, deps } = setup();
      world.addEvent({ placeId: OC_PLACE_ID });
      const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
      const boom = new Error("db down");
      (world.repos.places as { getById: unknown }).getById = async () => {
        throw boom;
      };
      const reportError = vi.fn();
      const out = await getPublicOpenCall({ ...deps, reportError }, { publicId: call.publicId });
      expect(out.location).toMatchObject({ hidden: true, addressText: null, lat: null });
      expect(reportError).toHaveBeenCalledWith(boom, expect.anything());
    });
  });

  describe("closed state", () => {
    it("closed by the poster", async () => {
      const { world, deps } = setup();
      world.addEvent();
      const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID, closedAt: world.now });
      const out = await getPublicOpenCall(deps, { publicId: call.publicId });
      expect(out).toMatchObject({
        closed: true,
        closedReason: "closed_by_poster",
        acceptingApplications: false,
      });
    });

    it("closed once the last date has started (FR-021), without anyone pressing Close", async () => {
      const { world, deps } = setup();
      world.addEvent({ startsAt: new Date(world.now.getTime() - 60_000) });
      const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
      const out = await getPublicOpenCall(deps, { publicId: call.publicId });
      expect(out).toMatchObject({ closed: true, closedReason: "last_date_started" });
    });

    it("closed when the event was cancelled (FR-022)", async () => {
      const { world, deps } = setup();
      world.addEvent({ status: "CANCELLED" });
      const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
      expect((await getPublicOpenCall(deps, { publicId: call.publicId })).closedReason).toBe(
        "event_ended",
      );
    });

    it("past the deadline: still open, but not accepting (FR-004)", async () => {
      const { world, deps } = setup();
      world.addEvent();
      const call = world.addForm({
        purpose: "PERFORM",
        eventId: OC_EVENT_ID,
        closesAt: new Date(world.now.getTime() - 60_000),
      });
      expect(await getPublicOpenCall(deps, { publicId: call.publicId })).toMatchObject({
        closed: false,
        acceptingApplications: false,
      });
    });
  });

  it("Booked so far: the event's public lineup, volunteers left out", async () => {
    const { world, deps } = setup();
    world.addEvent({ status: "DRAFT" });
    world.lineup.push(lineupRow(OC_EVENT_ID, "The Openers"), lineupRow(OC_EVENT_ID, "Door helper", "VOLUNTEER"));
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const out = await getPublicOpenCall(deps, { publicId: call.publicId });
    expect(out.bookedSoFar).toEqual([
      { startsAt: null, acts: [expect.objectContaining({ name: "The Openers" })] },
    ]);
  });

  it("a series call lists its upcoming live dates and per-date lineups", async () => {
    const { world, deps } = setup();
    world.addSeries();
    const materialised = world.addEvent({ startsAt: new Date(world.now.getTime() + 2 * DAY) });
    world.addOccurrence({ startsAt: new Date(world.now.getTime() - DAY) });
    world.addOccurrence({ startsAt: materialised.startsAt, eventId: materialised.id });
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 9 * DAY) });
    world.addOccurrence({ startsAt: new Date(world.now.getTime() + 16 * DAY), status: "SKIPPED" });
    world.lineup.push(lineupRow(materialised.id, "Week one act"));
    const call = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });

    const out = await getPublicOpenCall(deps, { publicId: call.publicId });
    expect(out.anchor).toBe("series");
    expect(out.title).toBe("Tuesday Open Stage");
    expect(out.dates.map((d) => d.startsAt)).toEqual([
      materialised.startsAt,
      new Date(world.now.getTime() + 9 * DAY),
    ]);
    expect(out.bookedSoFar).toEqual([
      { startsAt: materialised.startsAt, acts: [expect.objectContaining({ name: "Week one act" })] },
    ]);
    expect(out.location).toMatchObject({ mode: "EXACT" });
    expect(out.closed).toBe(false);
  });

  it("a series call with no upcoming live date shows Closed", async () => {
    const { world, deps } = setup();
    world.addSeries();
    world.addOccurrence({ startsAt: new Date(world.now.getTime() - DAY) });
    const call = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    const out = await getPublicOpenCall(deps, { publicId: call.publicId });
    expect(out).toMatchObject({ closed: true, closedReason: "last_date_started", location: null });
  });

  it("a series call never borrows the venue or lineup of a PRIVATE or cancelled date", async () => {
    const { world, deps } = setup();
    world.addSeries();
    const priv = world.addEvent({
      id: "20000000-0000-4000-8000-000000000201",
      visibility: "PRIVATE",
      addressText: "1 Private Rd",
      startsAt: new Date(world.now.getTime() + 1 * DAY),
    });
    const cancelled = world.addEvent({
      id: "20000000-0000-4000-8000-000000000202",
      status: "CANCELLED",
      addressText: "2 Cancelled Ave",
      startsAt: new Date(world.now.getTime() + 2 * DAY),
    });
    const pub = world.addEvent({
      id: "20000000-0000-4000-8000-000000000203",
      addressText: "3 Public St",
      startsAt: new Date(world.now.getTime() + 3 * DAY),
    });
    for (const e of [priv, cancelled, pub]) {
      world.addOccurrence({ startsAt: e.startsAt, eventId: e.id });
      world.lineup.push(lineupRow(e.id, `Act at ${e.addressText}`));
    }
    const call = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });

    const out = await getPublicOpenCall(deps, { publicId: call.publicId });
    expect(out.location).toMatchObject({ addressText: "3 Public St" });
    expect(out.bookedSoFar).toEqual([
      { startsAt: pub.startsAt, acts: [expect.objectContaining({ name: "Act at 3 Public St" })] },
    ]);
    const wire = JSON.stringify(out);
    expect(wire).not.toContain("1 Private Rd");
    expect(wire).not.toContain("2 Cancelled Ave");
    // The dates are the series' LIVE nights: the night whose materialised
    // event was cancelled is off even though its occurrence still reads
    // GENERATED (step 8 fix); the private night is still a date.
    expect(out.dates).toHaveLength(2);
    expect(out.dates.map((d) => d.startsAt)).toEqual([priv.startsAt, pub.startsAt]);
  });

  it("an EVENT call shows its own event even when it is PRIVATE (Q11)", async () => {
    const { world, deps } = setup();
    world.addEvent({ visibility: "PRIVATE" });
    world.lineup.push(lineupRow(OC_EVENT_ID, "Own act"));
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const out = await getPublicOpenCall(deps, { publicId: call.publicId });
    expect(out.location).toMatchObject({ addressText: "12 Elm St, Minneapolis, MN 55401" });
    expect(out.bookedSoFar[0]?.acts).toHaveLength(1);
  });
});
