import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import type {
  EventSeriesOccurrenceRecord,
  EventSeriesRecord,
} from "@th/types";

import { listEventTemplates } from "../../event-templates/list-event-templates";
import { listEventSeries } from "../list-event-series";
import { listSeriesOccurrences } from "../list-series-occurrences";

// ─────────────────────────────────────────────────────────────────────────────
// Place address withholding N4 (2026-09-25): templates and series carry a
// default location, and a FREEFORM one is a street + its true coordinates —
// for a DIY show, usually somebody's home. The list reads admit every org
// role but SCANNER, so below the EDIT roles (VIEWER, FINANCE) the freeform
// location comes back as `{ kind: "freeform", label }`: no street, no pin.
// Place / saved-location references are ids and pass through.
// ─────────────────────────────────────────────────────────────────────────────

const ORG_ID = "00000000-0000-4000-8000-00000000000a";
const ACTOR_ID = "00000000-0000-4000-8000-00000000000b";
const SERIES_ID = "00000000-0000-4000-8000-00000000000c";
const TEMPLATE_ID = "00000000-0000-4000-8000-00000000000d";
const PLACE_ID = "00000000-0000-4000-8000-00000000000e";
const OCC_ID = "00000000-0000-4000-8000-00000000000f";

const HOUSE = {
  kind: "freeform" as const,
  addressText: "901 Porter Rd, Nashville, TN 37206",
  lat: 36.1862,
  lng: -86.7291,
};

function expectNoStreetOrPin(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain("Porter");
  expect(json).not.toContain("36.1862");
  expect(json).not.toContain("-86.7291");
}

function series(defaultsLocation: unknown): EventSeriesRecord {
  return {
    id: SERIES_ID,
    ownerScope: "ORGANIZATION",
    ownerId: ORG_ID,
    name: "Porch Sessions",
    description: null,
    active: true,
    timezone: "America/Chicago",
    schedule: {
      kind: "RRULE",
      rrule: "FREQ=WEEKLY;BYDAY=FR",
      dtstart: "2026-10-02T23:00:00.000Z",
      until: null,
      dates: null,
      windowStart: null,
      windowEnd: null,
      maxOccurrencesPerExpand: 100,
    },
    templateId: null,
    defaults: { titlePrefix: "Porch", location: defaultsLocation },
    createdByHumanId: ACTOR_ID,
    updatedByHumanId: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    archivedAt: null,
  } as unknown as EventSeriesRecord;
}

function occurrence(overridesLocation: unknown): EventSeriesOccurrenceRecord {
  return {
    id: OCC_ID,
    seriesId: SERIES_ID,
    ordinal: 1,
    startsAt: new Date("2026-10-02T23:00:00.000Z"),
    endsAt: null,
    status: "PLANNED",
    eventId: null,
    overrides: { location: overridesLocation },
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  } as unknown as EventSeriesOccurrenceRecord;
}

function makeRepos(role: OrgRole, record: {
  series: EventSeriesRecord;
  occurrence: EventSeriesOccurrenceRecord;
  templateLocation: unknown;
}): Repos {
  const txRepos = {
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, name: "Porch Org" })),
    },
    humans: { getById: vi.fn(async () => ({ id: ACTOR_ID })) },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role,
      })),
    },
    series: {
      getById: vi.fn(async () => record.series),
      listByOwner: vi.fn(async () => ({
        items: [record.series],
        nextCursor: null,
      })),
    },
    seriesOccurrences: {
      listBySeries: vi.fn(async () => ({
        items: [record.occurrence],
        nextCursor: null,
      })),
    },
    eventTemplates: {
      list: vi.fn(async () => ({
        items: [
          {
            id: TEMPLATE_ID,
            ownerScope: "ORGANIZATION",
            ownerId: ORG_ID,
            name: "Porch show",
            description: null,
            active: true,
            defaults: { location: record.templateLocation },
            createdBy: ACTOR_ID,
            createdAt: new Date("2026-09-01T00:00:00.000Z"),
            updatedAt: new Date("2026-09-01T00:00:00.000Z"),
            archivedAt: null,
          },
        ],
      })),
    },
  };
  return {
    ...txRepos,
    tx: async <T>(fn: (tx: typeof txRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;
}

async function readAll(role: OrgRole, location: unknown) {
  const repos = makeRepos(role, {
    series: series(location),
    occurrence: occurrence(location),
    templateLocation: location,
  });
  const [templates, seriesList, occurrences] = await Promise.all([
    listEventTemplates(
      { repos },
      { actorHumanId: ACTOR_ID, ownerScope: "ORGANIZATION", ownerId: ORG_ID },
    ),
    listEventSeries(
      { repos },
      { actorHumanId: ACTOR_ID, ownerScope: "ORGANIZATION", ownerId: ORG_ID },
    ),
    listSeriesOccurrences(
      { repos },
      { actorHumanId: ACTOR_ID, seriesId: SERIES_ID },
    ),
  ]);
  return {
    template: templates.items[0]!.defaults?.location,
    series: seriesList.items[0]!.defaults?.location,
    occurrence: occurrences.items[0]!.overrides?.location,
    all: { templates, seriesList, occurrences },
  };
}

describe("N4 — a freeform template / series location below the edit roles", () => {
  it.each<OrgRole>(["VIEWER", "FINANCE"])(
    "%s gets { kind: freeform, label } — no street, no coordinates — on templates, series and occurrences",
    async (role) => {
      const read = await readAll(role, HOUSE);

      expect(read.template).toEqual({ kind: "freeform", label: null });
      expect(read.series).toEqual({ kind: "freeform", label: null });
      expect(read.occurrence).toEqual({ kind: "freeform", label: null });
      expectNoStreetOrPin(read.all);
    },
  );

  it.each<OrgRole>(["OWNER", "ADMIN", "EDITOR"])(
    "%s (an edit role) still reads the full freeform location",
    async (role) => {
      const read = await readAll(role, HOUSE);

      expect(read.template).toEqual(HOUSE);
      expect(read.series).toEqual(HOUSE);
      expect(read.occurrence).toEqual(HOUSE);
    },
  );

  it("a place reference is an id, not an address: passed through for a VIEWER", async () => {
    const placeRef = { kind: "place" as const, placeId: PLACE_ID };
    const read = await readAll("VIEWER", placeRef);

    expect(read.template).toEqual(placeRef);
    expect(read.series).toEqual(placeRef);
    expect(read.occurrence).toEqual(placeRef);
  });

  it("the label is the coarse locality/region when the stored location carries them", async () => {
    const { redactDraftFreeformLocation } = await import(
      "../../../lib/location/redact-draft-location"
    );
    expect(
      redactDraftFreeformLocation({
        ...HOUSE,
        locality: "Nashville",
        region: "TN",
      } as { kind: "freeform" }),
    ).toEqual({ kind: "freeform", label: "Nashville, TN" });
  });
});
