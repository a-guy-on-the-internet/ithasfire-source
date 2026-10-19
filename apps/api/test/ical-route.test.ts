import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

const createPrismaReposMock = vi.fn();
const withGuardedReposMock = vi.fn((repos) => repos);
const logAndReportMock = vi.fn(async () => undefined);
const captureExceptionMock = vi.fn();

// The public feeds run for real (`@th/core/use-cases/events/public-calendar-feeds`
// against the repo fakes below). Volunteering is out of scope here.
vi.mock("@th/core/use-cases/volunteering", () => ({
  exportMyVolunteeringIcs: vi.fn(),
}));

vi.mock("@th/adapters/db/prisma-repos", () => ({
  createPrismaRepos: createPrismaReposMock,
}));

vi.mock("@th/adapters/decorators/with-dependency-guard", () => ({
  withGuardedRepos: withGuardedReposMock,
}));

vi.mock("@th/adapters/infra/discord-alerts", () => ({
  logAndReport: logAndReportMock,
}));

vi.mock("@th/db", () => ({
  prisma: {},
}));

vi.mock("../src/instrument", () => ({
  Sentry: {
    captureException: captureExceptionMock,
  },
}));

function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(
      async (_name: string, fn: () => Promise<unknown>) => await fn(),
    ),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return logger;
}

describe("ical route observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createPrismaReposMock.mockReturnValue({});
  });

  it("returns 500 and reports venue feed failures through the wrapper", async () => {
    createPrismaReposMock.mockReturnValue({
      places: {
        getById: vi.fn(async () => {
          throw new Error("calendar exploded");
        }),
      },
    });

    const { default: icalRoutes } = await import("../src/routes/ical");

    const app = Fastify({ logger: false });
    app.decorate("deps", {
      logger: makeLogger(),
    } as any);

    await app.register(icalRoutes as any);

    const response = await app.inject({
      method: "GET",
      url: "/api/venues/00000000-0000-4000-8000-000000000123/calendar.ics",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_error" });
    expect(logAndReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "ical_venue_feed_error",
        extra: expect.objectContaining({
          placeId: "00000000-0000-4000-8000-000000000123",
          error: "calendar exploded",
        }),
        report: expect.objectContaining({
          captureException: captureExceptionMock,
          error: expect.any(Error),
        }),
      }),
    );

    await app.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B1 — calendar feeds are anonymous, cached, and copied into other people's
// calendars: a non-EXACT event (own mode, floored by its venue) carries its
// coarse label and NO `GEO`; there is no ticket-holder reveal here.
// ─────────────────────────────────────────────────────────────────────────────

describe("ical route location privacy", () => {
  const STREET = "1417 Shelby Ave, Nashville, TN 37206";
  const CLUB_STREET = "1 Broadway, Nashville, TN 37203";
  const HOUSE_ID = "00000000-0000-4000-8000-0000000000a1";
  const CLUB_ID = "00000000-0000-4000-8000-0000000000a2";
  const ORG_ID = "00000000-0000-4000-8000-0000000000b1";

  const ev = (id: string, overrides: Record<string, unknown>) => ({
    id,
    title: `Show ${id.slice(-2)}`,
    slug: `show-${id.slice(-2)}`,
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "NONE",
    startsAt: new Date("2099-06-01T20:00:00.000Z"),
    endsAt: null,
    placeId: null,
    locationMode: "EXACT",
    locationRadiusMeters: null,
    locationLabel: null,
    addressText: STREET,
    locality: "Nashville",
    region: "TN",
    lat: 36.1775,
    lng: -86.7412,
    ...overrides,
  });

  const OBSCURED = ev("00000000-0000-4000-8000-000000000001", {
    locationMode: "OBSCURED",
    locationRadiusMeters: 500,
  });
  const STALE_AT_HOUSE = ev("00000000-0000-4000-8000-000000000002", {
    placeId: HOUSE_ID,
  });
  const AT_CLUB = ev("00000000-0000-4000-8000-000000000003", {
    placeId: CLUB_ID,
    addressText: CLUB_STREET,
    lat: 36.16,
    lng: -86.77,
  });
  // M5: EXACT events a stranger may not see in full.
  const PRIVATE_EXACT = ev("00000000-0000-4000-8000-000000000004", {
    visibility: "PRIVATE",
  });
  const PASSWORD_EXACT = ev("00000000-0000-4000-8000-000000000005", {
    gateType: "PASSWORD",
  });
  const APPLICATION_EXACT = ev("00000000-0000-4000-8000-000000000006", {
    gateType: "APPLICATION",
  });
  const DRAFT_EXACT = ev("00000000-0000-4000-8000-000000000007", {
    status: "DRAFT",
  });

  const places: Record<string, unknown> = {
    [HOUSE_ID]: {
      id: HOUSE_ID,
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
      orgIdsWithAccess: [ORG_ID],
      humanIdsWithAccess: [],
      name: "The Shelby House",
      locationMode: "OBSCURED",
      locationRadiusMeters: 800,
      formattedAddress: STREET,
      city: "Nashville",
      region: "TN",
      lat: 36.1775,
      lng: -86.7412,
    },
    [CLUB_ID]: {
      id: CLUB_ID,
      name: "The Club",
      locationMode: "EXACT",
      locationRadiusMeters: null,
      formattedAddress: CLUB_STREET,
      city: "Nashville",
      region: "TN",
      lat: 36.16,
      lng: -86.77,
    },
  };
  const events = [
    OBSCURED,
    STALE_AT_HOUSE,
    AT_CLUB,
    PRIVATE_EXACT,
    PASSWORD_EXACT,
    APPLICATION_EXACT,
    DRAFT_EXACT,
  ];
  /** What `listByOwner({ status: PUBLISHED, visibility: PUBLIC })` returns. */
  const publicListed = events.filter(
    (e) => e.status === "PUBLISHED" && e.visibility === "PUBLIC",
  );

  async function appWithRepos() {
    const { configureLocationObfuscation } = await import(
      "@th/core/lib/location/obfuscation-key"
    );
    configureLocationObfuscation({ secret: "test-only-location-obfuscation-secret" });
    createPrismaReposMock.mockReturnValue({
      events: {
        getById: vi.fn(async (id: string) => events.find((e) => e.id === id) ?? null),
        findManyByIds: vi.fn(async (ids: string[]) =>
          events.filter((e) => ids.includes(e.id)),
        ),
        listByOwner: vi.fn(async (input: { status?: string[] }) => ({
          items: publicListed.filter((e) => input.status?.includes(e.status) ?? true),
        })),
        listPublishedByPlace: vi.fn(
          async (input: { placeId: string; statuses?: string[] }) => {
            // The real read windows on the next 90 days; pull the 2099
            // fixtures into it.
            const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            const items = input.statuses?.includes("CANCELLED")
              ? []
              : publicListed
                  .filter((e) => e.placeId === input.placeId)
                  .map((e) => ({ ...e, startsAt: soon }));
            return { items, pageInfo: { total: items.length, limit: 20, offset: 0, count: items.length } };
          },
        ),
      },
      eventDates: { listByEventIds: vi.fn(async () => []) },
      bans: { listWithheldOwners: vi.fn(async () => ({ humanIds: [], orgIds: [] })) },
      places: { getById: vi.fn(async (id: string) => places[id] ?? null) },
      organizations: {
        getById: vi.fn(async () => ({ id: ORG_ID, name: "Org", status: "ACTIVE" })),
      },
    });
    const { default: icalRoutes } = await import("../src/routes/ical");
    const app = Fastify({ logger: false });
    app.decorate("deps", { logger: makeLogger() } as any);
    await app.register(icalRoutes as any);
    return app;
  }

  /** The VEVENT block for one event uid. */
  const vevent = (ics: string, id: string) => {
    const start = ics.indexOf(`UID:${id}@ithasfire.com`);
    expect(start).toBeGreaterThanOrEqual(0);
    return ics.slice(start, ics.indexOf("END:VEVENT", start));
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("single event, OBSCURED → label only, no GEO, no street", async () => {
    const app = await appWithRepos();
    const res = await app.inject({
      method: "GET",
      url: `/api/events/${OBSCURED.id}/event.ics`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("LOCATION:Nashville\\, TN");
    expect(res.body).not.toContain("GEO:");
    expect(res.body).not.toContain("Shelby");
    await app.close();
  });

  it("single event at a WITHHELD venue (stale EXACT row) → label only, no GEO, no venue name", async () => {
    const app = await appWithRepos();
    const res = await app.inject({
      method: "GET",
      url: `/api/events/${STALE_AT_HOUSE.id}/event.ics`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("GEO:");
    expect(res.body).not.toContain("Shelby");
    await app.close();
  });

  it("M5: single event that is PRIVATE, gated (password / application) or a draft → the SAME 404, nothing leaked", async () => {
    const app = await appWithRepos();
    const bodies = new Set<string>();
    for (const e of [PRIVATE_EXACT, PASSWORD_EXACT, APPLICATION_EXACT, DRAFT_EXACT]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/events/${e.id}/event.ics`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("Shelby");
      expect(res.body).not.toContain("BEGIN:VCALENDAR");
      bodies.add(res.body);
    }
    // One uniform answer: the route is no oracle for WHICH gate an id hit.
    const missing = await app.inject({
      method: "GET",
      url: "/api/events/00000000-0000-4000-8000-0000000000ff/event.ics",
    });
    bodies.add(missing.body);
    expect(bodies.size).toBe(1);
    await app.close();
  });

  it("M5: a GATED event in the org feed carries no LOCATION and no GEO", async () => {
    const app = await appWithRepos();
    const res = await app.inject({
      method: "GET",
      url: `/api/orgs/${ORG_ID}/calendar.ics`,
    });
    expect(res.statusCode).toBe(200);
    for (const e of [PASSWORD_EXACT, APPLICATION_EXACT]) {
      const block = vevent(res.body, e.id);
      expect(block).not.toContain("LOCATION:");
      expect(block).not.toContain("GEO:");
      expect(block).not.toContain("Shelby");
    }
    await app.close();
  });

  it("single EXACT event at a publishing venue → unchanged: venue address + GEO", async () => {
    const app = await appWithRepos();
    const res = await app.inject({
      method: "GET",
      url: `/api/events/${AT_CLUB.id}/event.ics`,
    });
    expect(res.body).toContain("LOCATION:1 Broadway\\, Nashville\\, TN 37203");
    expect(res.body).toContain("GEO:36.16;-86.77");
    await app.close();
  });

  it("org feed: obscured and withheld-venue events carry no GEO and no street", async () => {
    const app = await appWithRepos();
    const res = await app.inject({
      method: "GET",
      url: `/api/orgs/${ORG_ID}/calendar.ics`,
    });
    expect(res.statusCode).toBe(200);
    for (const e of [OBSCURED, STALE_AT_HOUSE]) {
      const block = vevent(res.body, e.id);
      expect(block).not.toContain("GEO:");
      expect(block).not.toContain("Shelby");
    }
    expect(vevent(res.body, AT_CLUB.id)).toContain("GEO:36.16;-86.77");
    await app.close();
  });

  it("venue feed of a WITHHELD venue: no GEO, no street", async () => {
    const app = await appWithRepos();
    const res = await app.inject({
      method: "GET",
      url: `/api/venues/${HOUSE_ID}/calendar.ics`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`UID:${STALE_AT_HOUSE.id}@ithasfire.com`);
    expect(res.body).toContain("LOCATION:Nashville\\, TN");
    expect(res.body).not.toContain("GEO:");
    expect(res.body).not.toContain("Shelby Ave");
    await app.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anonymous org/human feeds list ONLY what a stranger sees on the public web:
// PUBLISHED + PUBLIC. The filter is pushed into the query (the repo fake below
// honours it the way the adapter does), so private rows never reach the feed
// and never crowd its page limit.
// ─────────────────────────────────────────────────────────────────────────────

describe("ical org/human feeds — public events only", () => {
  const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
  const HUMAN_ID = "00000000-0000-4000-8000-0000000000c1";
  const row = (id: string, status: string, visibility: string) => ({
    id,
    title: `${status} ${visibility} show`,
    slug: `show-${id.slice(-2)}`,
    status,
    visibility,
    startsAt: new Date("2099-06-01T20:00:00.000Z"),
    endsAt: null,
    placeId: null,
    locationMode: "EXACT",
    locationRadiusMeters: null,
    addressText: "1 Broadway, Nashville, TN",
    lat: 36.16,
    lng: -86.77,
  });
  const CORPUS = [
    row("00000000-0000-4000-8000-000000000011", "PUBLISHED", "PUBLIC"),
    row("00000000-0000-4000-8000-000000000012", "PUBLISHED", "PRIVATE"),
    row("00000000-0000-4000-8000-000000000013", "DRAFT", "PUBLIC"),
    row("00000000-0000-4000-8000-000000000014", "COMPLETED", "PUBLIC"),
  ];

  async function feedFor(url: string) {
    const listByOwner = vi.fn(
      async (input: { status?: string[]; visibility?: string[] }) => ({
        items: CORPUS.filter(
          (e) =>
            (!input.status?.length || input.status.includes(e.status)) &&
            (!input.visibility?.length ||
              input.visibility.includes(e.visibility)),
        ),
      }),
    );
    createPrismaReposMock.mockReturnValue({
      events: { listByOwner },
      eventDates: { listByEventIds: vi.fn(async () => []) },
      bans: { listWithheldOwners: vi.fn(async () => ({ humanIds: [], orgIds: [] })) },
      places: { getById: vi.fn(async () => null) },
      organizations: {
        getById: vi.fn(async () => ({ id: ORG_ID, name: "Org", status: "ACTIVE" })),
      },
      humans: {
        getById: vi.fn(async () => ({ id: HUMAN_ID, name: "Host", status: "ACTIVE" })),
      },
    });
    const { default: icalRoutes } = await import("../src/routes/ical");
    const app = Fastify({ logger: false });
    app.decorate("deps", { logger: makeLogger() } as any);
    await app.register(icalRoutes as any);
    const res = await app.inject({ method: "GET", url });
    await app.close();
    return { res, listByOwner };
  }

  for (const [label, url] of [
    ["org", `/api/orgs/${ORG_ID}/calendar.ics`],
    ["human", `/api/humans/${HUMAN_ID}/calendar.ics`],
  ] as const) {
    it(`${label} feed: PUBLIC + PUBLISHED only — PRIVATE, DRAFT and COMPLETED excluded`, async () => {
      const { res, listByOwner } = await feedFor(url);
      expect(res.statusCode).toBe(200);
      expect(listByOwner).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ["PUBLISHED"],
          visibility: ["PUBLIC"],
        }),
      );
      expect(res.body).toContain("SUMMARY:PUBLISHED PUBLIC show");
      expect(res.body).not.toContain("PRIVATE show");
      expect(res.body).not.toContain("DRAFT PUBLIC show");
      expect(res.body).not.toContain("COMPLETED PUBLIC show");
      expect(res.body.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Feed correctness: uniform 404s that report nothing, one UID per night,
// called-off shows kept as STATUS:CANCELLED outside the live cap.
// ─────────────────────────────────────────────────────────────────────────────

describe("ical feeds — 404 mapping, UIDs, cancelled shows", () => {
  const PLACE_ID = "00000000-0000-4000-8000-0000000000d1";
  const ORG_ID = "00000000-0000-4000-8000-0000000000d2";
  const HUMAN_ID = "00000000-0000-4000-8000-0000000000d3";
  const DAY = 24 * 60 * 60 * 1000;
  let n = 0;
  const id = () =>
    `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

  const place = (overrides: Record<string, unknown> = {}) => ({
    id: PLACE_ID,
    name: "The Room",
    status: "ACTIVE",
    verificationStatus: "VERIFIED",
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [],
    locationMode: "EXACT",
    locationRadiusMeters: null,
    formattedAddress: "1 Room St, Nashville, TN",
    city: "Nashville",
    region: "TN",
    lat: 36.16,
    lng: -86.77,
    ...overrides,
  });

  const event = (overrides: Record<string, unknown> = {}) => {
    const eventId = id();
    return {
      id: eventId,
      orgId: ORG_ID,
      humanId: null,
      title: `Show ${eventId.slice(-3)}`,
      slug: `show-${eventId.slice(-3)}`,
      status: "PUBLISHED",
      visibility: "PUBLIC",
      gateType: "NONE",
      placeId: PLACE_ID,
      locationMode: "EXACT",
      locationRadiusMeters: null,
      locationLabel: null,
      addressText: null,
      locality: "Nashville",
      region: "TN",
      lat: 36.16,
      lng: -86.77,
      startsAt: new Date(Date.now() + 3 * DAY),
      endsAt: null,
      publishedAt: new Date(Date.now() - 10 * DAY),
      cancelledFromStatus: null as string | null,
      updatedAt: new Date("2026-10-01T10:00:00Z"),
      ...overrides,
    };
  };
  type Ev = ReturnType<typeof event>;
  type Night = { id: string; eventId: string; startsAt: Date; endsAt: null; status: string; updatedAt: Date };
  const night = (eventId: string, inDays: number, status = "SCHEDULED"): Night => ({
    id: id(),
    eventId,
    startsAt: new Date(Date.now() + inDays * DAY),
    endsAt: null,
    status,
    updatedAt: new Date("2026-10-02T10:00:00Z"),
  });

  /** Repo fakes honouring status / visibility / cancelledWhilePublished / date arm / limit. */
  function repos(opts: {
    placeRow?: Record<string, unknown> | null;
    placeThrows?: Error;
    events?: Ev[];
    nights?: Night[];
    org?: Record<string, unknown> | null;
    human?: Record<string, unknown> | null;
  }) {
    const events = opts.events ?? [];
    const nights = opts.nights ?? [];
    const admits = (
      e: Ev,
      input: {
        statuses?: string[];
        status?: string[];
        cancelledWhilePublished?: boolean;
        dateOccurrenceStatuses?: string[];
        from?: Date;
        matchDateOccurrencesOnly?: boolean;
        includeRunning?: boolean;
      },
      statuses: string[],
    ) => {
      const from = input.from ?? new Date(0);
      return (
        statuses.includes(e.status) &&
        e.visibility === "PUBLIC" &&
        (!input.cancelledWhilePublished || e.cancelledFromStatus === "PUBLISHED") &&
        ((!input.matchDateOccurrencesOnly &&
          (e.startsAt >= from ||
            (input.includeRunning === true && e.endsAt !== null && (e.endsAt as Date) >= from))) ||
          nights.some(
            (d) =>
              d.eventId === e.id &&
              (input.dateOccurrenceStatuses ?? ["SCHEDULED"]).includes(d.status) &&
              d.startsAt >= from,
          ))
      );
    };
    const page = (items: Ev[], limit: number) => {
      const sorted = [...items].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      const taken = sorted.slice(0, limit);
      return { items: taken, pageInfo: { total: sorted.length, limit, offset: 0, count: taken.length } };
    };
    const listPublishedByPlace = vi.fn(async (input: any) =>
      page(
        events.filter(
          (e) => e.placeId === input.placeId && admits(e, input, input.statuses ?? ["PUBLISHED"]),
        ),
        input.limit ?? 20,
      ),
    );
    const listByOwner = vi.fn(async (input: any) =>
      page(
        events.filter(
          (e) =>
            (input.ownerType === "HUMAN" ? e.humanId : e.orgId) === input.ownerId &&
            admits(e, { ...input, from: input.dateRange?.from }, input.status),
        ),
        input.limit ?? 50,
      ),
    );
    const placesGetById = vi.fn(async (pid: string) => {
      if (opts.placeThrows) throw opts.placeThrows;
      const row = opts.placeRow === undefined ? place() : opts.placeRow;
      return row && row.id === pid ? row : null;
    });
    const orgGetById = vi.fn(async () =>
      opts.org === undefined ? { id: ORG_ID, name: "Cobra Org", status: "ACTIVE" } : opts.org,
    );
    const humanGetById = vi.fn(async () =>
      opts.human === undefined ? { id: HUMAN_ID, name: "Dana", status: "ACTIVE" } : opts.human,
    );
    createPrismaReposMock.mockReturnValue({
      events: { listPublishedByPlace, listByOwner },
      eventDates: {
        listByEventIds: vi.fn(async (input: { eventIds: string[]; statuses?: string[] }) =>
          nights.filter(
            (d) => input.eventIds.includes(d.eventId) && (!input.statuses || input.statuses.includes(d.status)),
          ),
        ),
      },
      bans: { listWithheldOwners: vi.fn(async () => ({ humanIds: [], orgIds: [] })) },
      places: { getById: placesGetById },
      organizations: { getById: orgGetById },
      humans: { getById: humanGetById },
    });
    return { listPublishedByPlace, listByOwner, orgGetById, humanGetById, placesGetById };
  }

  async function get(url: string) {
    const { default: icalRoutes } = await import("../src/routes/ical");
    const app = Fastify({ logger: false });
    app.decorate("deps", { logger: makeLogger() } as any);
    await app.register(icalRoutes as any);
    const res = await app.inject({ method: "GET", url });
    await app.close();
    return res;
  }

  const blocks = (ics: string) =>
    ics.replace(/\r\n /g, "").split("BEGIN:VEVENT").slice(1).map((b) => b.split("END:VEVENT")[0]!);
  const prop = (block: string, name: string) =>
    block.split("\r\n").find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);

  beforeEach(async () => {
    vi.clearAllMocks();
    const { configureLocationObfuscation } = await import("@th/core/lib/location/obfuscation-key");
    configureLocationObfuscation({ secret: "test-only-location-obfuscation-secret" });
  });

  // ── V2: 404 mapping ──────────────────────────────────────────────────────

  it.each([
    ["unknown place (PLACE_NOT_FOUND)", { placeRow: null }, PLACE_ID],
    ["unverified place (PLACE_NOT_VERIFIED)", { placeRow: place({ verificationStatus: "PENDING" }) }, PLACE_ID],
    ["inactive place (PLACE_NOT_ACTIVE)", { placeRow: place({ status: "ARCHIVED" }) }, PLACE_ID],
    ["malformed place id (invalid_input)", {}, "not-a-uuid"],
  ])("place feed: %s → uniform 404, nothing reported", async (_label, opts, placeId) => {
    const r = repos(opts);
    const res = await get(`/api/venues/${placeId}/calendar.ics`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "venue_not_found" });
    expect(logAndReportMock).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    if (placeId === "not-a-uuid") expect(r.placesGetById).not.toHaveBeenCalled();
  });

  it.each([
    ["org", "/api/orgs/not-a-uuid/calendar.ics", "org_not_found"],
    ["human", "/api/humans/12345/calendar.ics", "host_not_found"],
    ["single event", "/api/events/not-a-uuid/event.ics", "event_not_found"],
  ])("%s with a malformed id → 404 without touching the DB or reporting", async (_l, url, error) => {
    const r = repos({});
    const res = await get(url);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error });
    expect(r.orgGetById).not.toHaveBeenCalled();
    expect(r.humanGetById).not.toHaveBeenCalled();
    expect(logAndReportMock).not.toHaveBeenCalled();
  });

  it("org / host that is not ACTIVE → 404, nothing reported", async () => {
    repos({ org: { id: ORG_ID, name: "x", status: "SUSPENDED" }, human: null });
    const org = await get(`/api/orgs/${ORG_ID}/calendar.ics`);
    const human = await get(`/api/humans/${HUMAN_ID}/calendar.ics`);
    expect([org.statusCode, human.statusCode]).toEqual([404, 404]);
    expect(org.json()).toEqual({ error: "org_not_found" });
    expect(human.json()).toEqual({ error: "host_not_found" });
    expect(logAndReportMock).not.toHaveBeenCalled();
  });

  it("a real failure is still a reported 500", async () => {
    repos({ placeThrows: new Error("db down") });
    const res = await get(`/api/venues/${PLACE_ID}/calendar.ics`);
    expect(res.statusCode).toBe(500);
    expect(logAndReportMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "ical_venue_feed_error" }),
    );
  });

  // ── V1: one UID per night ────────────────────────────────────────────────

  it("V1 regression: a 3-night listing is 3 VEVENTs with 3 distinct UIDs (was 3 × the same UID)", async () => {
    const listing = event({ title: "Wednesday Open Mic", startsAt: new Date(Date.now() + 1 * DAY) });
    const nights = [night(listing.id, 1), night(listing.id, 8), night(listing.id, 15)];
    repos({ events: [listing], nights });

    for (const url of [
      `/api/venues/${PLACE_ID}/calendar.ics`,
      `/api/orgs/${ORG_ID}/calendar.ics`,
    ]) {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      const uids = blocks(res.body).map((b) => prop(b, "UID"));
      expect(uids).toEqual(nights.map((d) => `${listing.id}-${d.id}@ithasfire.com`));
    }
  });

  // ── Q6 / V3: cancelled shows ─────────────────────────────────────────────

  it("place feed: a taken-down listing and a called-off night appear as STATUS:CANCELLED with their real titles", async () => {
    const takenDown = event({ title: "Thursday Jam", status: "CANCELLED", cancelledFromStatus: "PUBLISHED", startsAt: new Date(Date.now() - 2 * DAY) });
    const tdNights = [night(takenDown.id, -2), night(takenDown.id, 5, "CANCELLED"), night(takenDown.id, 12, "CANCELLED")];
    const live = event({ title: "Open Mic", startsAt: new Date(Date.now() + 1 * DAY) });
    const liveNights = [night(live.id, 1), night(live.id, 8, "CANCELLED")];
    const neverLive = event({ title: "Never went live", status: "CANCELLED", cancelledFromStatus: "DRAFT", publishedAt: null });
    // Owner ruling 10-17: published, unpublished, edited, then cancelled as a
    // draft. publishedAt is still set, and the show stays out.
    const unpublishedFirst = event({
      title: "Renamed while private",
      status: "CANCELLED",
      cancelledFromStatus: "DRAFT",
      addressText: "12 Secret Lane",
    });
    repos({ events: [takenDown, live, neverLive, unpublishedFirst], nights: [...tdNights, ...liveNights] });

    const res = await get(`/api/venues/${PLACE_ID}/calendar.ics`);
    const rows = blocks(res.body).map((b) => [prop(b, "SUMMARY"), prop(b, "STATUS"), prop(b, "UID")]);
    expect(rows).toEqual([
      ["Open Mic", "CONFIRMED", `${live.id}-${liveNights[0]!.id}@ithasfire.com`],
      ["Thursday Jam", "CANCELLED", `${takenDown.id}-${tdNights[1]!.id}@ithasfire.com`],
      ["Open Mic", "CANCELLED", `${live.id}-${liveNights[1]!.id}@ithasfire.com`],
      ["Thursday Jam", "CANCELLED", `${takenDown.id}-${tdNights[2]!.id}@ithasfire.com`],
    ]);
    // SEQUENCE is a non-negative int32 derived from LAST-MODIFIED.
    for (const b of blocks(res.body)) {
      const sequence = Number(prop(b, "SEQUENCE"));
      expect(Number.isInteger(sequence) && sequence > 0 && sequence < 2 ** 31).toBe(true);
    }
    expect(res.body).not.toContain("Never went live");
    expect(res.body).not.toContain("Renamed while private");
    expect(res.body).not.toContain("12 Secret Lane");
  });

  it("?lang=es writes Spanish text; ?lang=xx and no param stay English", async () => {
    const live = event({ title: "Open Mic", startsAt: new Date(Date.now() + 1 * DAY) });
    const hosted = event({
      title: "Solo Night",
      orgId: null,
      humanId: HUMAN_ID,
      startsAt: new Date(Date.now() + 1 * DAY),
    });
    repos({
      events: [live, hosted],
      nights: [night(live.id, 1), night(live.id, 8, "CANCELLED"), night(hosted.id, 1)],
    });
    const text = async (url: string) => {
      const res = await get(url);
      expect(res.statusCode).toBe(200);
      return res.body.replace(/\r\n /g, "");
    };
    const placeUrl = `/api/venues/${PLACE_ID}/calendar.ics`;
    expect(await text(`${placeUrl}?lang=es`)).toContain("DESCRIPTION:Cancelado.");
    for (const url of [`${placeUrl}?lang=xx`, placeUrl, `${placeUrl}?lang=a&lang=b`]) {
      expect(await text(url)).toContain("DESCRIPTION:Cancelled.");
    }
    for (const base of [`/api/orgs/${ORG_ID}`, `/api/humans/${HUMAN_ID}`]) {
      const es = await text(`${base}/calendar.ics?lang=es`);
      expect(es).toMatch(/DESCRIPTION:(Cancelado\.\\n)?Organiza: /);
      expect(es).not.toContain("Hosted by");
      const en = await text(`${base}/calendar.ics?lang=xx`);
      expect(en).toMatch(/DESCRIPTION:(Cancelled\.\\n)?Hosted by /);
    }
  });

  it("place + org feeds: a called-off LAST night (pin re-pinned to the past) still shows CANCELLED", async () => {
    const listing = event({ title: "Last Wednesday", startsAt: new Date(Date.now() - 1 * DAY) });
    const nights = [night(listing.id, -8), night(listing.id, 6, "CANCELLED")];
    repos({ events: [listing], nights });
    for (const url of [`/api/venues/${PLACE_ID}/calendar.ics`, `/api/orgs/${ORG_ID}/calendar.ics`]) {
      const res = await get(url);
      const upcoming = blocks(res.body).filter((b) => prop(b, "UID") === `${listing.id}-${nights[1]!.id}@ithasfire.com`);
      expect(upcoming).toHaveLength(1);
      expect(prop(upcoming[0]!, "STATUS")).toBe("CANCELLED");
    }
  });

  it("org feed: a show still running (started 60 days ago, ends in 40) stays listed; reads exclude banned owners", async () => {
    const exhibition = event({
      title: "Long Exhibition",
      startsAt: new Date(Date.now() - 60 * DAY),
      endsAt: new Date(Date.now() + 40 * DAY),
    });
    const r = repos({ events: [exhibition] });
    const res = await get(`/api/orgs/${ORG_ID}/calendar.ics`);
    expect(res.body).toContain("SUMMARY:Long Exhibition");
    for (const [input] of r.listByOwner.mock.calls) {
      expect(input).toMatchObject({ excludeBannedOwners: true });
    }
  });

  it("org + host feeds: an owner-cancelled upcoming show is STATUS:CANCELLED", async () => {
    const off = event({ title: "Owner Cancelled", status: "CANCELLED", cancelledFromStatus: "PUBLISHED", humanId: HUMAN_ID });
    repos({ events: [off] });
    for (const url of [`/api/orgs/${ORG_ID}/calendar.ics`, `/api/humans/${HUMAN_ID}/calendar.ics`]) {
      const [block] = blocks((await get(url)).body);
      expect(prop(block!, "SUMMARY")).toBe("Owner Cancelled");
      expect(prop(block!, "STATUS")).toBe("CANCELLED");
      expect(prop(block!, "UID")).toBe(`${off.id}@ithasfire.com`);
    }
  });

  it("cap independence: 20 live shows fill the live limit, cancelled ones are listed on top", async () => {
    const live = Array.from({ length: 24 }, (_, i) => event({ startsAt: new Date(Date.now() + (i + 1) * DAY) }));
    const cancelled = [
      event({ title: "Off A", status: "CANCELLED", cancelledFromStatus: "PUBLISHED", startsAt: new Date(Date.now() + 2 * DAY) }),
      event({ title: "Off B", status: "CANCELLED", cancelledFromStatus: "PUBLISHED", startsAt: new Date(Date.now() + 40 * DAY) }),
    ];
    const r = repos({ events: [...live, ...cancelled] });

    const res = await get(`/api/venues/${PLACE_ID}/calendar.ics`);
    const all = blocks(res.body);
    expect(all.filter((b) => prop(b, "STATUS") === "CONFIRMED")).toHaveLength(20);
    expect(all.filter((b) => prop(b, "STATUS") === "CANCELLED").map((b) => prop(b, "SUMMARY"))).toEqual([
      "Off A",
      "Off B",
    ]);
    expect(r.listPublishedByPlace).toHaveBeenCalledTimes(3);
  });

  it("event links use the configured web origin and every line is CRLF-terminated and ≤ 75 octets", async () => {
    repos({ events: [event({ slug: "a-very-long-slug-".repeat(6) + "end", title: "Música en vivo 🎸 ".repeat(8) })] });
    const res = await get(`/api/venues/${PLACE_ID}/calendar.ics`);
    expect(res.body).toContain("URL:http://localhost:3000/events/");
    expect(res.body).not.toContain("https://ithasfire.com/events/");
    expect(res.body.endsWith("\r\n")).toBe(true);
    for (const line of res.body.slice(0, -2).split("\r\n")) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
  });
});
