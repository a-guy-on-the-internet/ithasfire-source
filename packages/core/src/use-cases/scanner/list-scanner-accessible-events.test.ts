import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";
import type { OrganizationRecord } from "@th/ports/repos/organizations";
import type { EventRecord } from "@th/ports/repos/events";

import { listScannerAccessibleEvents } from "./list-scanner-accessible-events";

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const EVT_A1 = "00000000-0000-4000-8000-0000000000a2";
const EVT_A2 = "00000000-0000-4000-8000-0000000000a3";
const EVT_B1 = "00000000-0000-4000-8000-0000000000b2";

function org(id: string, name: string): OrganizationRecord {
  return {
    id,
    name,
    slug: name.toLowerCase(),
  } as unknown as OrganizationRecord;
}

function evt(
  id: string,
  orgId: string,
  title: string,
  startsAt: Date,
  status: EventRecord["status"] = "PUBLISHED",
  endsAt: Date | null = null,
): EventRecord {
  return {
    id,
    orgId,
    humanId: null,
    title,
    status,
    // Ungated (N5: a missing gate fails closed to label only).
    gateType: "NONE",
    startsAt,
    endsAt,
  } as unknown as EventRecord;
}

function makeDeps(opts: {
  memberships: OrgMembership[];
  orgs: OrganizationRecord[];
  eventsByOrg: Record<string, EventRecord[]>;
}) {
  const repos = {
    authz: {
      listOrgMembershipsByHumanId: vi.fn(async () => opts.memberships),
    },
    organizations: {
      getByIds: vi.fn(async (ids: string[]) =>
        opts.orgs.filter((o) => ids.includes(o.id)),
      ),
    },
    events: {
      listByOwner: vi.fn(async ({ ownerId }: { ownerId: string }) => ({
        items: opts.eventsByOrg[ownerId] ?? [],
        total: (opts.eventsByOrg[ownerId] ?? []).length,
        limit: 200,
        offset: 0,
      })),
    },
  };
  return { repos: repos as unknown as Repos, mocks: repos };
}

describe("listScannerAccessibleEvents", () => {
  it("returns events from all scanner-eligible orgs sorted by startAt", async () => {
    const start1 = new Date("2026-07-01T18:00:00Z");
    const start2 = new Date("2026-07-15T18:00:00Z");
    const start3 = new Date("2026-08-01T18:00:00Z");
    const { repos, mocks } = makeDeps({
      memberships: [
        { orgId: ORG_A, humanId: ACTOR, role: "ADMIN" },
        { orgId: ORG_B, humanId: ACTOR, role: "SCANNER" },
      ],
      orgs: [org(ORG_A, "Alpha"), org(ORG_B, "Bravo")],
      eventsByOrg: {
        [ORG_A]: [
          evt(EVT_A1, ORG_A, "A-Late", start3),
          evt(EVT_A2, ORG_A, "A-Early", start1),
        ],
        [ORG_B]: [evt(EVT_B1, ORG_B, "B-Mid", start2)],
      },
    });

    const result = await listScannerAccessibleEvents(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR },
    );

    expect(result.events.map((e) => e.eventName)).toEqual([
      "A-Early",
      "B-Mid",
      "A-Late",
    ]);
    expect(result.events[0]).toMatchObject({
      eventId: EVT_A2,
      orgId: ORG_A,
      orgName: "Alpha",
      role: "ADMIN",
      status: "PUBLISHED",
    });
    expect(result.events[1]).toMatchObject({ orgId: ORG_B, role: "SCANNER" });
    expect(mocks.authz.listOrgMembershipsByHumanId).toHaveBeenCalledWith({
      humanId: ACTOR,
      roles: ["OWNER", "ADMIN", "SCANNER"],
    });
  });

  it("filters out ARCHIVED and CANCELLED events", async () => {
    const start = new Date("2026-07-01T18:00:00Z");
    const { repos } = makeDeps({
      memberships: [{ orgId: ORG_A, humanId: ACTOR, role: "OWNER" }],
      orgs: [org(ORG_A, "Alpha")],
      eventsByOrg: {
        [ORG_A]: [
          evt(EVT_A1, ORG_A, "Live", start, "PUBLISHED"),
          evt(EVT_A2, ORG_A, "Cancelled", start, "CANCELLED"),
        ],
      },
    });

    // The repo's status filter would normally exclude these; we belt-and-suspender
    // them in the use case to defend against fake/looser repo implementations.
    const result = await listScannerAccessibleEvents(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR },
    );
    expect(result.events.map((e) => e.eventName)).toEqual(["Live"]);
  });

  it("throws forbidden when actor has no scanner-eligible memberships", async () => {
    const { repos } = makeDeps({
      memberships: [],
      orgs: [],
      eventsByOrg: {},
    });

    await expect(
      listScannerAccessibleEvents(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  // The platform-ADMIN override needs a second factor. An ADMIN with none,
  // and no membership of their own, is refused under a code that says why,
  // before any org or event is read.
  it("throws SECOND_FACTOR_REQUIRED for a platform ADMIN with no second factor and no memberships", async () => {
    const { repos, mocks } = makeDeps({
      memberships: [],
      orgs: [],
      eventsByOrg: {},
    });
    const authz = {
      hasStaffRole: vi.fn(async () => ({
        allowed: false,
        secondFactorRequired: true as const,
      })),
    };

    await expect(
      listScannerAccessibleEvents(
        { repos, authz: authz as unknown as AuthZPort },
        { actorHumanId: ACTOR },
      ),
    ).rejects.toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
    expect(authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN"],
    });
    expect(mocks.events.listByOwner).not.toHaveBeenCalled();
  });

  it("rejects invalid input", async () => {
    const { repos } = makeDeps({
      memberships: [],
      orgs: [],
      eventsByOrg: {},
    });

    await expect(
      listScannerAccessibleEvents(
        { repos, authz: denyingAuthz },
        { actorHumanId: "not-a-uuid" },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("dedupes orgs with multiple memberships, preferring higher-priority role", async () => {
    const start = new Date("2026-07-01T18:00:00Z");
    const { repos } = makeDeps({
      memberships: [
        { orgId: ORG_A, humanId: ACTOR, role: "SCANNER" },
        { orgId: ORG_A, humanId: ACTOR, role: "OWNER" },
      ],
      orgs: [org(ORG_A, "Alpha")],
      eventsByOrg: {
        [ORG_A]: [evt(EVT_A1, ORG_A, "A1", start)],
      },
    });

    const result = await listScannerAccessibleEvents(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR },
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.role).toBe("OWNER");
  });
});

// ── M4: the picker's coordinates are the PUBLIC projection, for every role ──
describe("listScannerAccessibleEvents — location (M4)", () => {
  const HOUSE_LAT = 36.1775;
  const HOUSE_LNG = -86.7412;
  const VENUE_ID = "00000000-0000-4000-8000-0000000000c1";
  const start = new Date("2026-07-01T18:00:00Z");

  function located(
    id: string,
    overrides: Partial<EventRecord>,
  ): EventRecord {
    return {
      ...evt(id, ORG_A, `Event ${id.slice(-2)}`, start),
      ...overrides,
    } as EventRecord;
  }

  const freeformObscured = located(EVT_A1, {
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    addressText: "1417 Shelby Ave, Nashville, TN 37206",
    lat: HOUSE_LAT,
    lng: HOUSE_LNG,
  } as Partial<EventRecord>);
  const atWithheldVenue = located(EVT_A2, {
    placeId: VENUE_ID,
    locationMode: "EXACT",
    addressText: "1417 Shelby Ave, Nashville, TN 37206",
    lat: HOUSE_LAT,
    lng: HOUSE_LNG,
  } as Partial<EventRecord>);
  const exactEvent = located(EVT_B1, {
    orgId: ORG_A,
    locationMode: "EXACT",
    addressText: "1 Broadway",
    lat: 36.16,
    lng: -86.77,
  } as Partial<EventRecord>);

  const VENUE = {
    id: VENUE_ID,
    name: "The Shelby House",
    locationMode: "OBSCURED",
    locationRadiusMeters: null, // fully hidden
    city: "Nashville",
    region: "TN",
    lat: HOUSE_LAT,
    lng: HOUSE_LNG,
  };

  function depsWith(
    role: OrgMembership["role"],
    getById: (id: string) => Promise<unknown>,
  ) {
    const { repos } = makeDeps({
      memberships: [{ orgId: ORG_A, humanId: ACTOR, role }],
      orgs: [org(ORG_A, "Alpha")],
      eventsByOrg: { [ORG_A]: [freeformObscured, atWithheldVenue, exactEvent] },
    });
    (repos as unknown as { places: unknown }).places = {
      getById: vi.fn(getById),
    };
    return repos;
  }

  it.each(["OWNER", "ADMIN", "SCANNER"] as const)(
    "%s: a withheld location never yields its true point",
    async (role) => {
      const repos = depsWith(role, async () => VENUE);
      const result = await listScannerAccessibleEvents(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR },
      );
      const byId = new Map(result.events.map((e) => [e.eventId, e]));

      const freeform = byId.get(EVT_A1)!;
      // Keyed circle centre — present, but not the house.
      expect(freeform.lat).not.toBeNull();
      expect(freeform.lat).not.toBe(HOUSE_LAT);
      expect(freeform.lng).not.toBe(HOUSE_LNG);

      // Fully-hidden venue floors the stale EXACT row: no position at all.
      expect(byId.get(EVT_A2)).toMatchObject({ lat: null, lng: null });

      // A public EXACT event keeps its pin.
      expect(byId.get(EVT_B1)).toMatchObject({ lat: 36.16, lng: -86.77 });
    },
  );

  it("a failed venue read degrades to hidden AND is reported", async () => {
    const boom = new Error("place read failed");
    const reportError = vi.fn();
    const repos = depsWith("SCANNER", async () => {
      throw boom;
    });

    const result = await listScannerAccessibleEvents(
      { repos, authz: denyingAuthz, reportError },
      { actorHumanId: ACTOR },
    );

    expect(
      result.events.find((e) => e.eventId === EVT_A2),
    ).toMatchObject({ lat: null, lng: null });
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: {
        useCase: "listScannerAccessibleEvents",
        step: "resolvePlaceLocations",
      },
      extra: { placeId: VENUE_ID },
    });
  });
});
