import { describe, expect, it, vi } from "vitest";

import type { EntityReportRecord } from "@th/ports/repos/entity-reports";

import {
  listEntityReports,
  type ListEntityReportsDeps,
} from "../list-entity-reports";
import {
  HUMAN_SUBJECT_ID,
  STAFF_ID,
  ORG_ID,
  PLACE_ID,
  REPORTER_ID,
  makeLogger,
  makeReport,
  makeStaffAuthz,
} from "./helpers";

function buildDeps(
  overrides: {
    items?: EntityReportRecord[];
    nextCursor?: string | null;
    pendingCount?: number;
    rolesByHuman?: Record<string, string[]>;
    place?: { id: string; name: string } | null;
    humans?: Array<{ id: string; name: string | null }>;
    humanPages?: Array<{
      ownerId: string;
      slug: string;
      displayName: string | null;
    }>;
    /**
     * PLACE entity pages. `subjectSlug` for a venue comes from HERE, exactly
     * as it does for a human — `/places/{subjectSlug}` resolves
     * `EntityPage.slug`. It used to come from `Place.slug`, a multi-segment
     * directory key that route could not match, so every venue row in the
     * queue linked to a 404.
     */
    placePages?: Array<{
      ownerId: string;
      slug: string;
      displayName: string | null;
    }>;
    organizations?: Array<{ id: string; name: string; slug: string }>;
    /** arrival-areas FR-011: events an ARRIVAL_AREA report links to. */
    events?: Array<{ id: string; slug: string | null }>;
    /** arrival-areas FR-011: reported areas' CURRENT rows (absent = gone). */
    areas?: Array<{ id: string; placeId: string | null; eventId: string | null }>;
  } = {},
) {
  const listPaged = vi.fn(async () => ({
    items: overrides.items ?? [makeReport()],
    nextCursor: overrides.nextCursor ?? null,
  }));
  const countPending = vi.fn(async () => overrides.pendingCount ?? 1);
  const placesGetById = vi.fn(async () =>
    overrides.place !== undefined
      ? overrides.place
      : { id: PLACE_ID, name: "The Dive Bar" },
  );
  const humansGetByIds = vi.fn(async () => overrides.humans ?? []);
  // ONE spy, two owner types — dispatching on the argument keeps the call
  // COUNT meaningful (a PLACE batch and a HUMAN batch are distinguishable)
  // instead of both branches silently sharing one canned answer.
  const entityPagesGetByOwners = vi.fn(async (ownerType: string) =>
    ownerType === "PLACE"
      ? (overrides.placePages ?? [
          {
            ownerId: PLACE_ID,
            slug: "the-dive-bar-a1b2c3d4",
            displayName: "The Dive Bar",
          },
        ])
      : (overrides.humanPages ?? []),
  );
  const organizationsGetByIds = vi.fn(
    async () => overrides.organizations ?? [],
  );
  const eventsFindManyByIds = vi.fn(async (ids: string[]) =>
    (overrides.events ?? []).filter((e) => ids.includes(e.id)),
  );
  const arrivalAreasGetByIds = vi.fn(async (ids: readonly string[]) =>
    (overrides.areas ?? []).filter((a) => ids.includes(a.id)),
  );
  const authz = makeStaffAuthz(
    overrides.rolesByHuman ?? { [STAFF_ID]: ["SUPPORT"] },
  );
  const logger = makeLogger();
  const reportError = vi.fn();

  const deps: ListEntityReportsDeps = {
    repos: {
      entityReports: { listPaged, countPending },
      places: { getById: placesGetById },
      humans: { getByIds: humansGetByIds },
      entityPages: { getByOwners: entityPagesGetByOwners },
      organizations: { getByIds: organizationsGetByIds },
      events: { findManyByIds: eventsFindManyByIds },
      arrivalAreas: { getByIds: arrivalAreasGetByIds },
    } as unknown as ListEntityReportsDeps["repos"],
    authz: authz as unknown as ListEntityReportsDeps["authz"],
    logger: logger as unknown as ListEntityReportsDeps["logger"],
    reportError,
  };

  return {
    deps,
    listPaged,
    countPending,
    authz,
    placesGetById,
    humansGetByIds,
    entityPagesGetByOwners,
    organizationsGetByIds,
    eventsFindManyByIds,
    arrivalAreasGetByIds,
    logger,
    reportError,
  };
}

describe("listEntityReports", () => {
  it("non-staff actor gets STAFF_ONLY before ANY repo read", async () => {
    const { deps, listPaged, countPending, placesGetById } = buildDeps({
      rolesByHuman: { [REPORTER_ID]: [] },
    });

    await expect(
      listEntityReports(deps, { actorHumanId: REPORTER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });

    expect(listPaged).not.toHaveBeenCalled();
    expect(countPending).not.toHaveBeenCalled();
    expect(placesGetById).not.toHaveBeenCalled();
  });

  it("a COMMUNITY_MODERATOR is FORBIDDEN — entity reports are platform T&S, not community moderation (spec v1.1)", async () => {
    const { deps, listPaged, countPending } = buildDeps({
      rolesByHuman: { [STAFF_ID]: ["COMMUNITY_MODERATOR"] },
    });

    await expect(
      listEntityReports(deps, { actorHumanId: STAFF_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(listPaged).not.toHaveBeenCalled();
    expect(countPending).not.toHaveBeenCalled();
  });

  it.each([["ADMIN"], ["SUPPORT"], ["DEVELOPER"]])(
    "%s passes the platform-staff gate",
    async (role) => {
      const { deps } = buildDeps({
        rolesByHuman: { [STAFF_ID]: [role] },
      });

      const result = await listEntityReports(deps, {
        actorHumanId: STAFF_ID,
      });
      expect(result.items).toHaveLength(1);
    },
  );

  it("staff gets items + nextCursor + pendingCount, each item hydrated with subject display data", async () => {
    const report = makeReport();
    const { deps } = buildDeps({
      items: [report],
      nextCursor: report.id,
      pendingCount: 7,
    });

    const result = await listEntityReports(deps, {
      actorHumanId: STAFF_ID,
    });

    expect(result.items).toEqual([
      {
        ...report,
        subjectName: "The Dive Bar",
        // The PLACE entity page slug — flat, and what `/places/[slug]` resolves.
        subjectSlug: "the-dive-bar-a1b2c3d4",
        reporterName: null,
        subjectParentType: null,
        subjectKind: null,
      },
    ]);
    expect(result.nextCursor).toBe(report.id);
    expect(result.pendingCount).toBe(7);
  });

  it("hydrates the reporter's name from the SAME humans batch — no extra page query for reporters", async () => {
    const { deps, humansGetByIds, entityPagesGetByOwners } = buildDeps({
      items: [makeReport()],
      humans: [{ id: REPORTER_ID, name: "Rey Porter" }],
    });

    const result = await listEntityReports(deps, {
      actorHumanId: STAFF_ID,
    });

    expect(result.items[0]).toMatchObject({ reporterName: "Rey Porter" });
    expect(humansGetByIds).toHaveBeenCalledTimes(1);
    expect(humansGetByIds).toHaveBeenCalledWith([REPORTER_ID]);
    // No HUMAN subjects on this page → the HUMAN entity-pages query must not
    // fire solely for reporters (documented no-fallback choice). The PLACE
    // batch does run — the page's one subject is a venue.
    expect(entityPagesGetByOwners).toHaveBeenCalledTimes(1);
    expect(entityPagesGetByOwners).not.toHaveBeenCalledWith(
      "HUMAN",
      expect.anything(),
    );
  });

  it("a missing reporter row hydrates to reporterName null", async () => {
    const { deps } = buildDeps({ items: [makeReport()], humans: [] });

    const result = await listEntityReports(deps, {
      actorHumanId: STAFF_ID,
    });

    expect(result.items[0]).toMatchObject({ reporterName: null });
  });

  it("hydrates each subject type from its own repo (PLACE name/slug, HUMAN name + page slug, ORG name/slug)", async () => {
    const placeReport = makeReport({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" });
    const humanReport = makeReport({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      subjectType: "HUMAN",
      subjectId: HUMAN_SUBJECT_ID,
      reason: "IMPERSONATION",
    });
    const orgReport = makeReport({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      subjectType: "ORGANIZATION",
      subjectId: ORG_ID,
      reason: "SPAM",
    });
    const { deps } = buildDeps({
      items: [placeReport, humanReport, orgReport],
      humans: [{ id: HUMAN_SUBJECT_ID, name: "Fable Quartet" }],
      humanPages: [
        {
          ownerId: HUMAN_SUBJECT_ID,
          slug: "fable-quartet",
          displayName: "Fable Quartet (page)",
        },
      ],
      organizations: [
        { id: ORG_ID, name: "Dev QA Collective", slug: "dev-qa-collective" },
      ],
    });

    const result = await listEntityReports(deps, {
      actorHumanId: STAFF_ID,
    });

    expect(result.items[0]).toMatchObject({
      subjectName: "The Dive Bar",
      // PlaceRecord has no slug either — it comes from the PLACE entity page,
      // exactly like the HUMAN case below.
      subjectSlug: "the-dive-bar-a1b2c3d4",
    });
    // HumanRecord has no slug — it comes from the HUMAN entity page; the
    // record name wins over the page displayName when both exist.
    expect(result.items[1]).toMatchObject({
      subjectName: "Fable Quartet",
      subjectSlug: "fable-quartet",
    });
    expect(result.items[2]).toMatchObject({
      subjectName: "Dev QA Collective",
      subjectSlug: "dev-qa-collective",
    });
  });

  it("a human with no record name falls back to the page displayName", async () => {
    const humanReport = makeReport({
      subjectType: "HUMAN",
      subjectId: HUMAN_SUBJECT_ID,
      reason: "IMPERSONATION",
    });
    const { deps } = buildDeps({
      items: [humanReport],
      humans: [{ id: HUMAN_SUBJECT_ID, name: null }],
      humanPages: [
        { ownerId: HUMAN_SUBJECT_ID, slug: "mystery", displayName: "Mystery" },
      ],
    });

    const result = await listEntityReports(deps, {
      actorHumanId: STAFF_ID,
    });

    expect(result.items[0]).toMatchObject({
      subjectName: "Mystery",
      subjectSlug: "mystery",
    });
  });

  it("batches per subject type over DISTINCT ids only", async () => {
    const secondPlaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const items = [
      makeReport({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1" }),
      // Same place reported twice — must resolve ONCE.
      makeReport({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        reporterHumanId: STAFF_ID,
      }),
      makeReport({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        subjectId: secondPlaceId,
      }),
      makeReport({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
        subjectType: "HUMAN",
        subjectId: HUMAN_SUBJECT_ID,
        reason: "IMPERSONATION",
      }),
      makeReport({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
        subjectType: "ORGANIZATION",
        subjectId: ORG_ID,
        reason: "SPAM",
      }),
    ];
    const {
      deps,
      placesGetById,
      humansGetByIds,
      entityPagesGetByOwners,
      organizationsGetByIds,
    } = buildDeps({ items });

    await listEntityReports(deps, { actorHumanId: STAFF_ID });

    // PLACE has no batch accessor → one getById per DISTINCT id (2, not 3).
    expect(placesGetById).toHaveBeenCalledTimes(2);
    expect(placesGetById).toHaveBeenCalledWith(makeReport().subjectId);
    expect(placesGetById).toHaveBeenCalledWith(secondPlaceId);
    // ONE humans batch covering the HUMAN subject AND the distinct reporters
    // (REPORTER_ID appears on four reports, STAFF_ID on one — deduped).
    expect(humansGetByIds).toHaveBeenCalledTimes(1);
    const batchedHumanIds = humansGetByIds.mock.calls[0]![0] as string[];
    expect([...batchedHumanIds].sort()).toEqual(
      [HUMAN_SUBJECT_ID, REPORTER_ID, STAFF_ID].sort(),
    );
    // Entity pages resolve per owner type — one PLACE batch over the DISTINCT
    // place ids, one HUMAN batch over HUMAN SUBJECTS only (never reporters).
    expect(entityPagesGetByOwners).toHaveBeenCalledTimes(2);
    expect(entityPagesGetByOwners).toHaveBeenCalledWith("PLACE", [
      makeReport().subjectId,
      secondPlaceId,
    ]);
    expect(entityPagesGetByOwners).toHaveBeenCalledWith("HUMAN", [
      HUMAN_SUBJECT_ID,
    ]);
    expect(organizationsGetByIds).toHaveBeenCalledTimes(1);
    expect(organizationsGetByIds).toHaveBeenCalledWith([ORG_ID]);
  });

  it("skips subject repos for types absent from the page (humans batch still runs for reporters)", async () => {
    const { deps, humansGetByIds, entityPagesGetByOwners, organizationsGetByIds } =
      buildDeps({ items: [makeReport()] });

    await listEntityReports(deps, { actorHumanId: STAFF_ID });

    // Reporter resolution keeps the humans batch alive on an all-PLACE page…
    expect(humansGetByIds).toHaveBeenCalledTimes(1);
    expect(humansGetByIds).toHaveBeenCalledWith([REPORTER_ID]);
    // …the entity-page batch runs for the PLACE subjects and NOTHING else…
    expect(entityPagesGetByOwners).toHaveBeenCalledTimes(1);
    expect(entityPagesGetByOwners).toHaveBeenCalledWith("PLACE", [
      makeReport().subjectId,
    ]);
    // …and the org repo, with no ORGANIZATION subject on the page, stays put.
    expect(organizationsGetByIds).not.toHaveBeenCalled();
  });

  it("a missing subject row hydrates to null name + slug (report outlives its subject)", async () => {
    const { deps } = buildDeps({ place: null });

    const result = await listEntityReports(deps, {
      actorHumanId: STAFF_ID,
    });

    expect(result.items[0]).toMatchObject({
      subjectName: null,
      subjectSlug: null,
    });
  });

  it("a hydration repo failure NEVER fails the list — degraded nulls (incl. reporterName) + logger.error + guarded reportError; pendingCount intact", async () => {
    const hydrationError = new Error("places db down");
    const { deps, placesGetById, logger, reportError } = buildDeps({
      pendingCount: 4,
      humans: [{ id: REPORTER_ID, name: "Rey Porter" }],
    });
    placesGetById.mockRejectedValueOnce(hydrationError);

    const result = await listEntityReports(deps, {
      actorHumanId: STAFF_ID,
    });

    // Even the humans batch that SUCCEEDED degrades — a partial failure
    // nulls the whole page (one consistent fallback, no half-hydrated rows).
    expect(result.items[0]).toMatchObject({
      subjectName: null,
      subjectSlug: null,
      reporterName: null,
    });
    expect(result.pendingCount).toBe(4);
    expect(logger.error).toHaveBeenCalledWith(
      "entity_report.subject_hydration_failed",
      expect.objectContaining({ placeIds: 1, reporterIds: 1 }),
    );
    expect(reportError).toHaveBeenCalledWith(
      hydrationError,
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "list-entity-reports" }),
        extra: expect.objectContaining({ reporterIds: 1 }),
      }),
    );
  });

  it("a THROWING reporter still never fails the (degraded) list", async () => {
    const { deps, placesGetById, reportError } = buildDeps();
    placesGetById.mockRejectedValueOnce(new Error("places db down"));
    reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });

    const result = await listEntityReports(deps, {
      actorHumanId: STAFF_ID,
    });

    expect(reportError).toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
  });

  it("a clean list reports nothing", async () => {
    const { deps, reportError } = buildDeps();

    await listEntityReports(deps, { actorHumanId: STAFF_ID });

    expect(reportError).not.toHaveBeenCalled();
  });

  it("passes status / subjectType / cursor / limit through to listPaged and narrows countPending by subjectType", async () => {
    const { deps, listPaged, countPending } = buildDeps({
      items: [
        makeReport({
          subjectType: "HUMAN",
          subjectId: HUMAN_SUBJECT_ID,
          reason: "IMPERSONATION",
          status: "RESOLVED",
        }),
      ],
      humans: [{ id: HUMAN_SUBJECT_ID, name: "Fable Quartet" }],
    });

    await listEntityReports(deps, {
      actorHumanId: STAFF_ID,
      status: "RESOLVED",
      subjectType: "HUMAN",
      cursor: makeReport().id,
      limit: 10,
    });

    expect(listPaged).toHaveBeenCalledWith({
      status: "RESOLVED",
      subjectType: "HUMAN",
      cursor: makeReport().id,
      limit: 10,
    });
    // The badge count narrows with the queue filter so they can never
    // disagree (counting-twin port contract).
    expect(countPending).toHaveBeenCalledWith({ subjectType: "HUMAN" });
  });

  it("omitted filters stay omitted — the adapter owns the PENDING default", async () => {
    const { deps, listPaged, countPending } = buildDeps();

    await listEntityReports(deps, { actorHumanId: STAFF_ID });

    expect(listPaged).toHaveBeenCalledWith({ cursor: null });
    expect(countPending).toHaveBeenCalledWith(undefined);
  });

  it("rejects unknown keys (.strict())", async () => {
    const { deps } = buildDeps();

    await expect(
      listEntityReports(deps, {
        actorHumanId: STAFF_ID,
        direction: "forward",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("listEntityReports ARRIVAL_AREA (arrival-areas FR-011)", () => {
  const AREA_ID = "88888888-8888-4888-8888-888888888888";
  const EVENT_ID = "99999999-9999-4999-8999-999999999999";
  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    type: "ARRIVAL_AREA" as const,
    kind: "ACCESSIBLE_DROP_OFF" as const,
    label: "Side door drop-off",
    cost: "FREE" as const,
    priceText: null,
    note: null,
    geometry: {
      type: "LineString" as const,
      coordinates: [
        [-86.7291, 36.1862],
        [-86.7287, 36.1862],
      ] as [number, number][],
    },
    placeId: PLACE_ID,
    eventId: null,
    seenOnEventId: null,
    ...overrides,
  });

  it("names the area by its snapshot label and links the place page it hangs off", async () => {
    const report = makeReport({
      id: "r-place",
      subjectType: "ARRIVAL_AREA",
      subjectId: AREA_ID,
      reason: "INCORRECT_INFO",
      subjectSnapshot: snapshot(),
    });
    const { deps, placesGetById, eventsFindManyByIds } = buildDeps({ items: [report] });
    const out = await listEntityReports(deps, { actorHumanId: STAFF_ID });

    expect(out.items[0]).toMatchObject({
      subjectName: "Side door drop-off",
      subjectSlug: "the-dive-bar-a1b2c3d4",
      subjectParentType: "PLACE",
      subjectKind: "ACCESSIBLE_DROP_OFF",
      // Staff see what was reported, geometry included.
      subjectSnapshot: snapshot(),
    });
    // The area id is not a place id: no PLACE subject lookup for it.
    expect(placesGetById).not.toHaveBeenCalled();
    expect(eventsFindManyByIds).not.toHaveBeenCalled();
  });

  it("links the event page when it was seen on one (or is event-only), per report", async () => {
    const seen = makeReport({
      id: "r-seen",
      subjectType: "ARRIVAL_AREA",
      subjectId: AREA_ID,
      reason: "SPAM",
      subjectSnapshot: snapshot({ seenOnEventId: EVENT_ID }),
    });
    const onPlace = makeReport({
      id: "r-place-2",
      subjectType: "ARRIVAL_AREA",
      subjectId: AREA_ID,
      reason: "SPAM",
      subjectSnapshot: snapshot(),
    });
    const { deps, eventsFindManyByIds, arrivalAreasGetByIds } = buildDeps({
      items: [seen, onPlace],
      events: [{ id: EVENT_ID, slug: "open-mic-night" }],
    });
    const out = await listEntityReports(deps, { actorHumanId: STAFF_ID });
    // One batch read each, the repeated area id read once.
    expect(arrivalAreasGetByIds).toHaveBeenCalledTimes(1);
    expect(arrivalAreasGetByIds).toHaveBeenCalledWith([AREA_ID]);
    expect(eventsFindManyByIds).toHaveBeenCalledTimes(1);
    expect(eventsFindManyByIds).toHaveBeenCalledWith([EVENT_ID]);
    expect(out.items.map((i) => [i.id, i.subjectParentType, i.subjectSlug])).toEqual([
      ["r-seen", "EVENT", "open-mic-night"],
      ["r-place-2", "PLACE", "the-dive-bar-a1b2c3d4"],
    ]);
  });

  it("after a place merge moved the area, the report links the surviving place; the snapshot is unchanged", async () => {
    const SURVIVOR_ID = "77777777-7777-4777-8777-777777777777";
    const report = makeReport({
      id: "r-merged",
      subjectType: "ARRIVAL_AREA",
      subjectId: AREA_ID,
      reason: "SPAM",
      subjectSnapshot: snapshot(), // placeId: the merged (deleted) place
    });
    const { deps, entityPagesGetByOwners, arrivalAreasGetByIds } = buildDeps({
      items: [report],
      areas: [{ id: AREA_ID, placeId: SURVIVOR_ID, eventId: null }],
      placePages: [
        { ownerId: SURVIVOR_ID, slug: "the-survivor-0000", displayName: null },
      ],
    });
    const out = await listEntityReports(deps, { actorHumanId: STAFF_ID });
    expect(arrivalAreasGetByIds).toHaveBeenCalledWith([AREA_ID]);
    expect(entityPagesGetByOwners).toHaveBeenCalledWith("PLACE", [SURVIVOR_ID]);
    expect(out.items[0]).toMatchObject({
      subjectSlug: "the-survivor-0000",
      subjectParentType: "PLACE",
      subjectSnapshot: snapshot(),
    });
  });

  it("an area row that is gone falls back to the snapshot's parent", async () => {
    const report = makeReport({
      id: "r-gone",
      subjectType: "ARRIVAL_AREA",
      subjectId: AREA_ID,
      reason: "SPAM",
      subjectSnapshot: snapshot(),
    });
    const { deps, entityPagesGetByOwners } = buildDeps({ items: [report] });
    const out = await listEntityReports(deps, { actorHumanId: STAFF_ID });
    expect(entityPagesGetByOwners).toHaveBeenCalledWith("PLACE", [PLACE_ID]);
    expect(out.items[0]).toMatchObject({
      subjectSlug: "the-dive-bar-a1b2c3d4",
      subjectParentType: "PLACE",
    });
  });

  it("a failed area read degrades the page and is reported with the area and event counts", async () => {
    const report = makeReport({
      id: "r-fail",
      subjectType: "ARRIVAL_AREA",
      subjectId: AREA_ID,
      reason: "SPAM",
      subjectSnapshot: snapshot(),
    });
    const { deps, arrivalAreasGetByIds, reportError } = buildDeps({ items: [report] });
    arrivalAreasGetByIds.mockRejectedValueOnce(new Error("db down"));
    const out = await listEntityReports(deps, { actorHumanId: STAFF_ID });
    expect(out.items[0]).toMatchObject({
      subjectName: "Side door drop-off",
      subjectSlug: null,
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ areaIds: 1, eventIds: 0 }),
      }),
    );
  });

  it("an unreadable stored snapshot shows as none, reported, without failing the queue", async () => {
    const bad = makeReport({
      id: "r-bad",
      subjectType: "ARRIVAL_AREA",
      subjectId: AREA_ID,
      reason: "SPAM",
      subjectSnapshot: { type: "ARRIVAL_AREA", geometry: "nope" } as never,
    });
    const { deps, reportError, logger } = buildDeps({ items: [bad] });
    const out = await listEntityReports(deps, { actorHumanId: STAFF_ID });
    expect(out.items[0]).toMatchObject({
      subjectSnapshot: null,
      subjectName: null,
      subjectKind: null,
      subjectParentType: null,
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ area: "entity_report_snapshot" }),
        extra: { reportId: "r-bad", subjectType: "ARRIVAL_AREA" },
      }),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("nope");
  });

  it("the snapshot is behind the staff gate like everything else", async () => {
    const { deps, listPaged } = buildDeps({
      items: [makeReport({ subjectType: "ARRIVAL_AREA", subjectSnapshot: snapshot() })],
      rolesByHuman: { [REPORTER_ID]: [] },
    });
    await expect(
      listEntityReports(deps, { actorHumanId: REPORTER_ID }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(listPaged).not.toHaveBeenCalled();
  });
});
