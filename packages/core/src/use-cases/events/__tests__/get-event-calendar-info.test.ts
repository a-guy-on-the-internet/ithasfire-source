import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";

import {
  getEventCalendarInfo,
  type GetEventCalendarInfoDeps,
} from "../get-event-calendar-info";

// F16 (2026-09-29): series names used to be returned for ANY 50 event ids.

const ACTOR = "71000000-0000-4000-8000-000000000001";
const ACTOR_ORG = "71000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "71000000-0000-4000-8000-0000000000a2";
const PUBLISHED = "71000000-0000-4000-8000-000000000011";
const OWN_DRAFT = "71000000-0000-4000-8000-000000000012";
const FOREIGN_DRAFT = "71000000-0000-4000-8000-000000000013";
const MISSING = "71000000-0000-4000-8000-000000000014";

function event(
  id: string,
  status: EventRecord["status"],
  orgId: string,
): EventRecord {
  return {
    id,
    status,
    orgId,
    humanId: null,
    stewardship: "OWNED",
    publishedAt: status === "PUBLISHED" ? new Date() : null,
  } as unknown as EventRecord;
}

function info(eventId: string) {
  return {
    eventId,
    seriesId: `series-${eventId}`,
    seriesName: `Series ${eventId.slice(-2)}`,
    occurrenceId: `occ-${eventId}`,
  };
}

function makeDeps() {
  const getCalendarInfoForEventIds = vi.fn(async (ids: string[]) =>
    ids.map(info),
  );
  const deps = {
    repos: {
      events: {
        findManyByIds: vi.fn(async () => [
          event(PUBLISHED, "PUBLISHED", OTHER_ORG),
          event(OWN_DRAFT, "DRAFT", ACTOR_ORG),
          event(FOREIGN_DRAFT, "DRAFT", OTHER_ORG),
        ]),
      },
      authz: {
        getOrgMembership: vi.fn(async ({ orgId }: { orgId: string }) =>
          orgId === ACTOR_ORG ? { role: "OWNER" } : null,
        ),
        getHumanDelegation: vi.fn(async () => null),
        getStaffRolesForHumanId: vi.fn(async () => []),
      },
      seriesOccurrences: { getCalendarInfoForEventIds },
    },
    authz: { hasStaffRole: async () => ({ allowed: false }) },
  } as unknown as GetEventCalendarInfoDeps;
  return { deps, getCalendarInfoForEventIds };
}

describe("getEventCalendarInfo", () => {
  it("returns series info only for events the actor may read", async () => {
    const { deps, getCalendarInfoForEventIds } = makeDeps();

    const out = await getEventCalendarInfo(deps, {
      actorHumanId: ACTOR,
      eventIds: [PUBLISHED, OWN_DRAFT, FOREIGN_DRAFT, MISSING],
    });

    expect(out.items.map((i) => i.eventId).sort()).toEqual(
      [OWN_DRAFT, PUBLISHED].sort(),
    );
    // The foreign draft and the unknown id never reach the series lookup.
    const queried = getCalendarInfoForEventIds.mock.calls[0]?.[0] ?? [];
    expect(queried).not.toContain(FOREIGN_DRAFT);
    expect(queried).not.toContain(MISSING);
  });

  it("returns nothing without querying series when no event is readable", async () => {
    const { deps, getCalendarInfoForEventIds } = makeDeps();

    const out = await getEventCalendarInfo(deps, {
      actorHumanId: ACTOR,
      eventIds: [FOREIGN_DRAFT],
    });
    // The repo mock returns all three rows; only ids that were ASKED for
    // and are readable count.
    expect(out.items).toEqual([]);
    expect(getCalendarInfoForEventIds).not.toHaveBeenCalled();
  });

  it("rejects more than 50 ids", async () => {
    const { deps } = makeDeps();
    await expect(
      getEventCalendarInfo(deps, {
        actorHumanId: ACTOR,
        eventIds: Array.from(
          { length: 51 },
          (_, i) => `71000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        ),
      }),
    ).rejects.toBeTruthy();
  });
});
