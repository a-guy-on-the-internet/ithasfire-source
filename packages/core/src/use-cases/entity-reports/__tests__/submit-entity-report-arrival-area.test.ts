import { describe, expect, it, vi } from "vitest";

import type { EntityReportRecord } from "@th/ports/repos/entity-reports";

import {
  EVENT_ID,
  MODERATOR,
  NOW,
  OTHER_PLACE_ID,
  PLACE_ID,
  PLACE_MANAGER,
  PLACE_ORG,
  STRANGER,
  TRUE_LAT,
  TRUE_LNG,
  areaRow,
  errorOf,
  makeEvent,
  makePlace,
  makeWorld,
  type WorldOptions,
} from "../../arrival-areas/__tests__/arrival-area-world";
import { submitEntityReport } from "../submit-entity-report";
import { makeReport } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// arrival-areas FR-011: reporting an arrival area. The reporter may report
// only an area `listArrivalAreasForViewer` shows them, and anything else (a
// missing id, a withheld place's area, load-in, a switched-off area) is the
// SAME bare ARRIVAL_AREA_NOT_FOUND. The report keeps a snapshot of what they
// saw.
// ─────────────────────────────────────────────────────────────────────────────

const AREA_ID = "cccccccc-cccc-4ccc-8ccc-0000000000a1";
const MISSING_ID = "cccccccc-cccc-4ccc-8ccc-0000000000ff";

const EXACT = { locationMode: "EXACT", locationRadiusMeters: null } as const;

function build(options: WorldOptions & { withAuthz?: boolean } = {}) {
  const world = makeWorld(options);
  const create = vi.fn(async (input: Record<string, unknown>) =>
    makeReport({
      subjectType: input.subjectType as EntityReportRecord["subjectType"],
      subjectId: input.subjectId as string,
      reporterHumanId: input.reporterHumanId as string,
      reason: input.reason as EntityReportRecord["reason"],
      details: (input.details as string | null) ?? null,
      subjectSnapshot:
        (input.subjectSnapshot as EntityReportRecord["subjectSnapshot"]) ?? null,
    }),
  );
  const repos = world.repos as unknown as Record<string, unknown>;
  repos.entityReports = {
    create,
    findPendingByReporterAndSubject: vi.fn(async () => null),
  };
  repos.notifications = { create: vi.fn(async () => ({ id: "n-1", createdAt: NOW })) };
  (repos.authz as Record<string, unknown>).listHumanIdsByStaffRole = vi.fn(
    async () => [MODERATOR],
  );
  const reportError = vi.fn();
  const deps = {
    repos: world.repos,
    ...(options.withAuthz === false ? {} : { authz: world.authz }),
    clock: { now: () => NOW },
    reportError,
  } as never;
  return { world, deps, create, reportError };
}

const report = (overrides: Record<string, unknown> = {}) => ({
  subjectType: "ARRIVAL_AREA",
  subjectId: AREA_ID,
  reason: "INCORRECT_INFO",
  actorHumanId: STRANGER,
  ...overrides,
});

const parking = areaRow({
  id: AREA_ID,
  label: "Back lot",
  cost: "PAID",
  priceText: "$5",
  note: "Gate closes at 11",
});

describe("submitEntityReport ARRIVAL_AREA (arrival-areas FR-011)", () => {
  it("an area the reporter can see: PENDING report with the snapshot of what they saw", async () => {
    const { deps, create, world } = build({
      place: makePlace(EXACT),
      areas: [parking],
    });
    const out = await submitEntityReport(deps, report());

    expect(out.reportId).toBeDefined();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectType: "ARRIVAL_AREA",
        subjectId: AREA_ID,
        reporterHumanId: STRANGER,
        reason: "INCORRECT_INFO",
        subjectSnapshot: {
          type: "ARRIVAL_AREA",
          kind: "PARKING",
          label: "Back lot",
          cost: "PAID",
          priceText: "$5",
          note: "Gate closes at 11",
          geometry: parking.geometry,
          placeId: PLACE_ID,
          eventId: null,
          seenOnEventId: null,
        },
      }),
    );
    // The audit row carries ids, never the geometry.
    const submitted = world.audit.find((a) => a.action === "entity_report.submitted");
    expect(JSON.stringify(submitted)).not.toContain(String(TRUE_LNG).slice(0, 7));
  });

  it("a withheld place's area is not found for the public, the same error as a missing id", async () => {
    const { deps, create } = build({ areas: [parking] }); // OBSCURED by default
    const hidden = await errorOf(submitEntityReport(deps, report()));
    const missing = await errorOf(
      submitEntityReport(deps, report({ subjectId: MISSING_ID })),
    );
    expect(hidden.code).toBe("ARRIVAL_AREA_NOT_FOUND");
    expect(hidden).toEqual(missing);
    expect(hidden.meta ?? {}).toEqual({});
    expect(create).not.toHaveBeenCalled();
  });

  it("the place's manager sees the withheld place's areas, so may report one", async () => {
    const { deps, create } = build({ areas: [parking] });
    await submitEntityReport(deps, report({ actorHumanId: PLACE_MANAGER }));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("load-in at a public place is not found for the public", async () => {
    const { deps, create } = build({
      place: makePlace(EXACT),
      areas: [areaRow({ id: AREA_ID, kind: "LOAD_IN" })],
    });
    expect((await errorOf(submitEntityReport(deps, report()))).code).toBe(
      "ARRIVAL_AREA_NOT_FOUND",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("a switched-off event area is not found (it is shown to no one)", async () => {
    const { deps } = build({
      place: makePlace(EXACT),
      event: makeEvent({
        ...EXACT,
        status: "PUBLISHED",
        publishedAt: new Date(NOW.getTime() - 1000),
        addressRevealPreset: null,
        addressRevealAt: null,
      } as never),
      areas: [
        areaRow({
          id: AREA_ID,
          placeId: null,
          eventId: EVENT_ID,
          disabledAt: new Date(NOW.getTime() - 1000),
        }),
      ],
    });
    expect((await errorOf(submitEntityReport(deps, report()))).code).toBe(
      "ARRIVAL_AREA_NOT_FOUND",
    );
  });

  it("seenOnEventId: a place's area seen on its public event page is checked against that page, and recorded", async () => {
    const { deps, create } = build({
      place: makePlace(EXACT),
      event: makeEvent({
        ...EXACT,
        status: "PUBLISHED",
        publishedAt: new Date(NOW.getTime() - 1000),
        addressRevealPreset: null,
        addressRevealAt: null,
      } as never),
      areas: [parking],
    });
    await submitEntityReport(deps, report({ seenOnEventId: EVENT_ID }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectSnapshot: expect.objectContaining({
          placeId: PLACE_ID,
          eventId: null,
          seenOnEventId: EVENT_ID,
        }),
      }),
    );
  });

  it("seenOnEventId naming an event at another place does not reach the area", async () => {
    const { deps, create } = build({
      place: makePlace(EXACT),
      event: makeEvent({
        ...EXACT,
        placeId: OTHER_PLACE_ID,
        status: "PUBLISHED",
        publishedAt: new Date(NOW.getTime() - 1000),
      } as never),
      areas: [parking],
    });
    expect(
      (await errorOf(submitEntityReport(deps, report({ seenOnEventId: EVENT_ID })))).code,
    ).toBe("ARRIVAL_AREA_NOT_FOUND");
    expect(create).not.toHaveBeenCalled();
  });

  it("without the authz dep every ARRIVAL_AREA report fails closed", async () => {
    const { deps, create } = build({
      place: makePlace(EXACT),
      areas: [parking],
      withAuthz: false,
    });
    expect((await errorOf(submitEntityReport(deps, report()))).code).toBe(
      "ARRIVAL_AREA_NOT_FOUND",
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("reason subset: CLOSED_OR_GONE is allowed; DUPLICATE and IMPERSONATION are not", async () => {
    const ok = build({ place: makePlace(EXACT), areas: [parking] });
    await submitEntityReport(ok.deps, report({ reason: "CLOSED_OR_GONE" }));
    expect(ok.create).toHaveBeenCalledTimes(1);

    for (const reason of ["DUPLICATE", "IMPERSONATION"]) {
      const { deps, create } = build({ place: makePlace(EXACT), areas: [parking] });
      const err = await errorOf(submitEntityReport(deps, report({ reason })));
      expect(err).toMatchObject({
        code: "INVALID_INPUT",
        meta: { reason: "invalid_reason_for_subject" },
      });
      expect(create).not.toHaveBeenCalled();
    }
  });

  it("a malformed stored shape is listed, not drawn: the snapshot keeps a null geometry", async () => {
    const { deps, create } = build({
      place: makePlace(EXACT),
      areas: [
        areaRow({
          id: AREA_ID,
          geometry: { type: "Polygon", coordinates: [[[TRUE_LNG, TRUE_LAT]]] } as never,
        }),
      ],
    });
    await submitEntityReport(deps, report());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectSnapshot: expect.objectContaining({ geometry: null }),
      }),
    );
  });

  it("seenOnEventId on a listing subject is refused", async () => {
    const { deps } = build({ place: makePlace(EXACT) });
    const err = await errorOf(
      submitEntityReport(deps, {
        subjectType: "PLACE",
        subjectId: PLACE_ID,
        reason: "SPAM",
        actorHumanId: STRANGER,
        seenOnEventId: EVENT_ID,
      }),
    );
    expect(err).toMatchObject({
      code: "INVALID_INPUT",
      meta: { reason: "seen_on_event_not_allowed" },
    });
  });

  describe("gated and withheld event pages (arrival-areas FR-011)", () => {
    const published = {
      status: "PUBLISHED",
      publishedAt: new Date(NOW.getTime() - 1000),
    } as const;
    const gatedEvent = () =>
      makeEvent({
        ...EXACT,
        ...published,
        gateType: "PASSWORD",
        addressRevealPreset: null,
        addressRevealAt: null,
      } as never);

    it("a reporter the transport passed through the event's gate may report its area", async () => {
      const { deps, create } = build({
        place: makePlace(EXACT),
        event: gatedEvent(),
        areas: [parking],
      });
      await submitEntityReport(
        deps,
        report({ seenOnEventId: EVENT_ID, gateAccessGranted: true }),
      );
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("a reporter who has not passed the gate gets the missing-id error", async () => {
      const { deps, create } = build({
        place: makePlace(EXACT),
        event: gatedEvent(),
        areas: [parking],
      });
      const locked = await errorOf(
        submitEntityReport(
          deps,
          report({ seenOnEventId: EVENT_ID, gateAccessGranted: false }),
        ),
      );
      const missing = await errorOf(
        submitEntityReport(deps, report({ subjectId: MISSING_ID })),
      );
      expect(locked.code).toBe("ARRIVAL_AREA_NOT_FOUND");
      expect(locked).toEqual(missing);
      expect(create).not.toHaveBeenCalled();
    });

    it("a gate pass without seenOnEventId is ignored (an event-only area on a gated event)", async () => {
      const { deps, create } = build({
        place: makePlace(EXACT),
        event: gatedEvent(),
        areas: [areaRow({ id: AREA_ID, placeId: null, eventId: EVENT_ID })],
      });
      expect(
        (await errorOf(submitEntityReport(deps, report({ gateAccessGranted: true })))).code,
      ).toBe("ARRIVAL_AREA_NOT_FOUND");
      expect(create).not.toHaveBeenCalled();
    });

    // The default place withholds its address: its areas reach the public
    // only through the event page, and only for a ticket holder after reveal
    // of a show the place vouched for (here its own, the `owner` arm).
    const revealedEvent = () =>
      makeEvent({
        ...published,
        orgId: PLACE_ORG,
        // The default DAY_BEFORE reveal, already past: the show is tonight.
        addressRevealAt: new Date(NOW.getTime() - 1000),
        startsAt: new Date(NOW.getTime() + 6 * 60 * 60 * 1000),
        endsAt: new Date(NOW.getTime() + 9 * 60 * 60 * 1000),
      } as never);

    it("a ticket holder reports a withheld place's area seen on the event page", async () => {
      const { deps, create, world } = build({
        event: revealedEvent(),
        areas: [parking],
      });
      (
        world.repos.tickets.viewerHoldsActiveTicketForEvent as ReturnType<typeof vi.fn>
      ).mockResolvedValue(true);
      await submitEntityReport(deps, report({ seenOnEventId: EVENT_ID }));
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectSnapshot: expect.objectContaining({
            placeId: PLACE_ID,
            seenOnEventId: EVENT_ID,
          }),
        }),
      );
    });

    it("an RSVP-er (owner ruling Q4) reports a withheld place's area seen on the event page; never its load-in", async () => {
      const loadIn = areaRow({
        id: "cccccccc-cccc-4ccc-8ccc-0000000000a2",
        kind: "LOAD_IN",
      });
      const { deps, create, world } = build({
        event: makeEvent({ ...revealedEvent(), attendanceMode: "RSVP" } as never),
        areas: [parking, loadIn],
      });
      (
        world.repos.eventRsvps.existsForUser as ReturnType<typeof vi.fn>
      ).mockResolvedValue(true);
      await submitEntityReport(deps, report({ seenOnEventId: EVENT_ID }));
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectId: AREA_ID,
          subjectSnapshot: expect.objectContaining({
            kind: "PARKING",
            placeId: PLACE_ID,
            seenOnEventId: EVENT_ID,
          }),
        }),
      );
      const refused = await errorOf(
        submitEntityReport(deps, report({ subjectId: loadIn.id, seenOnEventId: EVENT_ID })),
      );
      expect(refused.code).toBe("ARRIVAL_AREA_NOT_FOUND");
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("a non-holder naming the same event page gets the missing-id error", async () => {
      const { deps, create } = build({
        event: revealedEvent(),
        areas: [parking],
      });
      const err = await errorOf(
        submitEntityReport(deps, report({ seenOnEventId: EVENT_ID })),
      );
      expect(err.code).toBe("ARRIVAL_AREA_NOT_FOUND");
      expect(err.meta ?? {}).toEqual({});
      expect(create).not.toHaveBeenCalled();
    });

    it("a draft event as seenOnEventId reaches nothing", async () => {
      const { deps, create } = build({
        place: makePlace(EXACT),
        event: makeEvent({ ...EXACT, status: "DRAFT", publishedAt: null } as never),
        areas: [parking],
      });
      expect(
        (await errorOf(submitEntityReport(deps, report({ seenOnEventId: EVENT_ID })))).code,
      ).toBe("ARRIVAL_AREA_NOT_FOUND");
      expect(create).not.toHaveBeenCalled();
    });
  });
});
