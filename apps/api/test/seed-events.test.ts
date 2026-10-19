import { afterEach, describe, expect, it, vi } from "vitest";

const saveSpies = vi.hoisted(() => ({
  org: vi.fn(),
  human: vi.fn(),
}));

vi.mock("@th/core/use-cases/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveEventForOrg: saveSpies.org,
  saveEventForHuman: saveSpies.human,
}));
vi.mock("@th/adapters/db/prisma", () => ({ createPrismaRepos: () => ({}) }));
vi.mock("@th/adapters/authz/db-authz-adapter", () => ({
  createDbAuthZAdapter: () => ({}),
}));

import { ensureSeedPrimaryPayoutLine } from "../src/scripts/seed/finance";
import {
  fixtureTimezone,
  upsertEventWithTickets,
  upsertHumanEventWithTickets,
} from "../src/scripts/seed/events";
import {
  buildEventFixtures,
  HUMAN_EVENT_FIXTURES,
  PLACES,
  REGIONS,
} from "../src/scripts/seed/fixtures";
import {
  buildStartDateInZone,
  timezoneForRegionCode,
} from "../src/scripts/seed/utils";

describe("ensureSeedPrimaryPayoutLine", () => {
  it("updates an existing shared line instead of deleting and recreating it", async () => {
    const findFirst = vi.fn(async () => ({ id: "line-1" }));
    const update = vi.fn(async () => ({}));
    const create = vi.fn(async () => ({}));

    const prisma = {
      payoutTermsLine: {
        findFirst,
        update,
        create,
      },
    } as any;

    await ensureSeedPrimaryPayoutLine(prisma, "terms-1", "payee-1");

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          payoutTermsId: "terms-1",
          payeeId: "payee-1",
          ticketTypeId: null,
        }),
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "line-1" },
      data: {
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a valid 100% line when the agreement has none", async () => {
    const prisma = {
      payoutTermsLine: {
        findFirst: vi.fn(async () => null),
        update: vi.fn(async () => ({})),
        create: vi.fn(async () => ({})),
      },
    } as any;

    await ensureSeedPrimaryPayoutLine(prisma, "terms-2", "payee-2");

    expect(prisma.payoutTermsLine.update).not.toHaveBeenCalled();
    expect(prisma.payoutTermsLine.create).toHaveBeenCalledWith({
      data: {
        payoutTermsId: "terms-2",
        payeeId: "payee-2",
        percent: 100,
        floorCents: 0,
        capPercent: null,
        priority: 0,
        rounding: "FLOOR",
      },
    });
  });
});

describe("seed event timezones", () => {
  it("maps region codes to the zone of their state", () => {
    expect(timezoneForRegionCode("ca-sf")).toBe("America/Los_Angeles");
    expect(timezoneForRegionCode("ca-oak")).toBe("America/Los_Angeles");
    expect(timezoneForRegionCode("ny-nyc")).toBe("America/New_York");
    expect(timezoneForRegionCode("tx-aus")).toBe("America/Chicago");
    expect(timezoneForRegionCode("il-chi")).toBe("America/Chicago");
    expect(() => timezoneForRegionCode("zz-nowhere")).toThrow();
  });

  it("gives every seeded fixture a zone that matches its region", () => {
    for (const region of REGIONS) timezoneForRegionCode(region.code);
    const byTitle = new Map(
      [...buildEventFixtures(), ...HUMAN_EVENT_FIXTURES].map((f) => [
        f.title,
        fixtureTimezone(f),
      ]),
    );
    expect(byTitle.get("Brooklyn Open Mic Night")).toBe("America/New_York");
    expect(byTitle.get("Dolores Park Fitness Bootcamp")).toBe(
      "America/Los_Angeles",
    );
    expect(byTitle.get("Rooftop BBQ Hangout")).toBe("America/Los_Angeles");
    expect(byTitle.get("Pilsen Open Mic")).toBe("America/Chicago");
  });

  it("uses a linked place's own zone", () => {
    const place = PLACES.find((p) => p.region === "CA");
    expect(fixtureTimezone({ regionCode: "tx-aus", placeId: place?.id })).toBe(
      place?.timezone,
    );
  });

  it("builds the wall-clock hour in the event's zone", () => {
    // 2026-03-01T12:00Z, +10 days = 2026-03-11 (PDT already in force).
    const now = Date.UTC(2026, 2, 1, 12);
    expect(
      buildStartDateInZone(10, 19, "America/Los_Angeles", now).toISOString(),
    ).toBe("2026-03-12T02:00:00.000Z");
    expect(
      buildStartDateInZone(10, 19, "America/New_York", now).toISOString(),
    ).toBe("2026-03-11T23:00:00.000Z");
    // Calendar day is read in the zone: 03:00Z is still the evening before in LA.
    expect(
      buildStartDateInZone(0, 19, "America/Los_Angeles", Date.UTC(2026, 5, 2, 3)).toISOString(),
    ).toBe("2026-06-02T02:00:00.000Z");
  });

  it("keeps the calendar day across a DST change near local midnight", () => {
    // 2026-03-07 23:30 PST (07:30Z Mar 8); +1 day must be Mar 8 at 19:00 PDT.
    const now = Date.UTC(2026, 2, 8, 7, 30);
    expect(
      buildStartDateInZone(1, 19, "America/Los_Angeles", now).toISOString(),
    ).toBe("2026-03-09T02:00:00.000Z");
    // Fall back: 2026-10-31 23:30 PDT (06:30Z Nov 1); +1 day = Nov 1 19:00 PST.
    expect(
      buildStartDateInZone(
        1,
        19,
        "America/Los_Angeles",
        Date.UTC(2026, 10, 1, 6, 30),
      ).toISOString(),
    ).toBe("2026-11-02T03:00:00.000Z");
  });

  it("resolves a nonexistent spring-forward hour forward", () => {
    // 02:00 on 2026-03-08 does not exist in LA; 03:00 PDT = 10:00Z.
    expect(
      buildStartDateInZone(
        1,
        2,
        "America/Los_Angeles",
        Date.UTC(2026, 2, 7, 20),
      ).toISOString(),
    ).toBe("2026-03-08T10:00:00.000Z");
  });
});

describe("seed passes the event zone to the save use cases", () => {
  afterEach(() => {
    vi.useRealTimers();
    saveSpies.org.mockReset();
    saveSpies.human.mockReset();
  });

  const prisma = {
    event: { findUnique: vi.fn(async () => null), delete: vi.fn() },
  } as any;

  it("org fixture: Brooklyn Open Mic gets America/New_York and a 7-ish PM New York start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    const fixture = buildEventFixtures().find(
      (f) => f.title === "Brooklyn Open Mic Night",
    )!;
    saveSpies.org.mockRejectedValue(new Error("stop after save"));
    await expect(
      upsertEventWithTickets(prisma, fixture, {
        categoryId: "cat",
        orgPayeeMap: { [fixture.orgId!]: { payeeId: "p", agreementId: "a" } },
        fixtureIndex: 0,
      }),
    ).rejects.toThrow("stop after save");
    const input = saveSpies.org.mock.calls[0]![1];
    expect(input.timezone).toBe("America/New_York");
    expect(input.startsAt).toBe(
      buildStartDateInZone(
        fixture.daysFromNow,
        fixture.startHour,
        "America/New_York",
      ).toISOString(),
    );
  });

  it("human fixture: Rooftop BBQ Hangout gets America/Los_Angeles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T12:00:00Z"));
    const fixture = HUMAN_EVENT_FIXTURES.find(
      (f) => f.title === "Rooftop BBQ Hangout",
    )!;
    saveSpies.human.mockRejectedValue(new Error("stop after save"));
    await expect(
      upsertHumanEventWithTickets(prisma, fixture, {
        actorHumanId: "h",
        categoryId: "cat",
        payeeId: "p",
        fixtureIndex: 0,
      }),
    ).rejects.toThrow("stop after save");
    const input = saveSpies.human.mock.calls[0]![1];
    expect(input.timezone).toBe("America/Los_Angeles");
    expect(input.startsAt).toBe(
      buildStartDateInZone(
        fixture.daysFromNow,
        fixture.startHour,
        "America/Los_Angeles",
      ).toISOString(),
    );
  });
});
