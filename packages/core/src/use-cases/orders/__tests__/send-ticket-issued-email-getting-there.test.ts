import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";
import type { ArrivalAreaRow } from "@th/types/repos/arrival-areas";

import { squareAt } from "../../arrival-areas/__tests__/arrival-area-world";

// The outer swallow is reached only by a failure that escapes the projection
// (which fails closed and reports on its own). A hoisted switch makes the
// real projection throw for the one test that needs it.
const projection = vi.hoisted(() => ({ throwNext: false }));
vi.mock("../../arrival-areas/list-arrival-areas-for-viewer", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../arrival-areas/list-arrival-areas-for-viewer")
    >();
  return {
    ...actual,
    listArrivalAreasForViewer: vi.fn(
      async (...args: Parameters<typeof actual.listArrivalAreasForViewer>) => {
        if (projection.throwNext) {
          projection.throwNext = false;
          throw new Error("projection exploded");
        }
        return actual.listArrivalAreasForViewer(...args);
      },
    ),
  };
});

import { sendTicketIssuedEmail } from "../send-ticket-issued-email";

// arrival-areas FR-010: the order email's one "Parking and drop-off: see the
// map" line. Only when the event has an area an anonymous visitor is shown,
// the recipient already gets the exact address in the email, and the
// `arrivalAreas` gate is on. Never breaks the email.

const ORDER_ID = "9f2c1d4e-77a1-4b3c-8d55-1122db21b2c3";
const HUMAN_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const PLACE_ID = "44444444-4444-4444-8444-444444444444";
const LAT = 36.16;
const LNG = -86.78;
const APP = "https://ithasfire.test";
const EVENT_URL = `${APP}/events/launch-party`;

const area = (overrides: Partial<ArrivalAreaRow> = {}): ArrivalAreaRow => ({
  id: "cccccccc-cccc-4ccc-8ccc-000000000001",
  placeId: PLACE_ID,
  eventId: null,
  kind: "PARKING",
  geometry: squareAt(LAT + 0.001, LNG),
  label: "Back lot",
  cost: "FREE",
  priceText: null,
  note: null,
  accessibleSpots: false,
  sortOrder: 0,
  disabledAt: null,
  createdByHumanId: null,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  updatedAt: new Date("2026-10-01T00:00:00.000Z"),
  ...overrides,
});

type Setup = {
  gateOn?: boolean;
  placeAreas?: ArrivalAreaRow[];
  /** The place withholds its address and the event has not revealed it. */
  withheld?: boolean;
  slug?: string | null;
  listForEventThrows?: boolean;
  /** An OBSCURED event whose reveal date has passed (the holder gets the street). */
  obscuredRevealed?: boolean;
  gateType?: string;
};

function setup(options: Setup = {}) {
  const {
    gateOn = true,
    placeAreas = [area()],
    withheld = false,
    slug = "launch-party",
    listForEventThrows = false,
    obscuredRevealed = false,
    gateType = "NONE",
  } = options;
  const event = {
    id: EVENT_ID,
    orgId: "org-1",
    humanId: null,
    title: "Launch Party",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType,
    stewardship: "OWNED",
    locationMode: withheld || obscuredRevealed ? "OBSCURED" : "EXACT",
    locationRadiusMeters: withheld || obscuredRevealed ? 800 : null,
    locationLabel: withheld || obscuredRevealed ? "East Nashville" : null,
    addressRevealAt: obscuredRevealed ? new Date("2020-01-01T00:00:00.000Z") : null,
    addressRevealPreset: withheld ? "NEVER" : null,
    startsAt: new Date("2030-02-01T00:00:00.000Z"),
    endsAt: null,
    placeId: PLACE_ID,
    addressText: "123 Test St",
    locality: "Nashville",
    region: "TN",
    countryCode: "US",
    lat: LAT,
    lng: LNG,
    slug,
    publishedAt: new Date("2026-01-22T00:00:00.000Z"),
    venueConfirmedAt: null,
    venueConfirmationWithdrawnAt: null,
    venueConfirmedPlaceId: null,
    venueConfirmedStartsAt: null,
  };
  const place = {
    id: PLACE_ID,
    name: "Test Place",
    slug: "test-place",
    formattedAddress: "123 Test St, Nashville, TN 37206",
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: LAT,
    lng: LNG,
    status: "ACTIVE",
    orgIdsWithAccess: ["org-1"],
    humanIdsWithAccess: [],
    locationMode: withheld ? "OBSCURED" : "EXACT",
    locationRadiusMeters: withheld ? 800 : null,
    locationLabel: withheld ? "East Nashville" : null,
  };
  const mailer: MailerPort = {
    send: vi.fn().mockResolvedValue({ result: { success: true, id: "email_1" } }),
    sendBatch: vi.fn(),
    health: vi.fn(),
  };
  const repos = {
    orders: {
      getById: vi.fn().mockResolvedValue({
        id: ORDER_ID,
        eventId: EVENT_ID,
        buyerHumanId: HUMAN_ID,
        status: "SUCCEEDED",
        source: "PRIMARY",
        currency: "usd",
        items: [],
      }),
    },
    humans: {
      getByIdWithIdentity: vi.fn().mockResolvedValue({
        human: { id: HUMAN_ID, name: "Buyer" },
        identity: { email: "buyer@example.com" },
      }),
      listAuthAccounts: vi
        .fn()
        .mockResolvedValue([{ id: "acct_1", providerId: "credential" }]),
    },
    events: { getById: vi.fn().mockResolvedValue(event) },
    places: { getById: vi.fn().mockResolvedValue(place) },
    tickets: {
      hasActiveTicketForEvent: vi.fn().mockResolvedValue(true),
      listByOrderId: vi.fn().mockResolvedValue([
        { id: "t1", code: "TICKET-CODE", seatId: null },
      ]),
      viewerHoldsActiveTicketForEvent: vi.fn().mockResolvedValue(true),
    },
    platformSettings: {
      getAll: vi.fn(async () =>
        gateOn ? [{ key: "feature:arrivalAreas", value: "true" }] : [],
      ),
    },
    arrivalAreas: {
      listForPlace: vi.fn(async () => placeAreas),
      listHidesForEvent: vi.fn(async () => []),
      listForEvent: vi.fn(async () => {
        if (listForEventThrows) throw new Error("db down");
        return [];
      }),
    },
    eventHumans: { listByEvent: vi.fn(async () => []) },
    eventRsvps: { existsForUser: vi.fn(async () => false) },
    eventDateRsvps: { existsForUserOnEvent: vi.fn(async () => false) },
    authz: {
      getOrgMembership: vi.fn(async () => null),
      getHumanDelegation: vi.fn(async () => null),
    },
  } as unknown as Repos;
  const reportError = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { repos, mailer, reportError, logger };
}

async function send(s: ReturnType<typeof setup>) {
  return sendTicketIssuedEmail(
    {
      repos: s.repos,
      mailer: s.mailer,
      reportError: s.reportError,
      logger: s.logger as never,
    },
    { orderId: ORDER_ID, publicAppUrl: `${APP}/`, supportUrl: `${APP}/help` },
  );
}

function variables(s: ReturnType<typeof setup>): Record<string, unknown> {
  const call = vi.mocked(s.mailer.send).mock.calls[0]?.[0] as {
    template: { variables: Record<string, unknown> };
  };
  return call.template.variables;
}

describe("sendTicketIssuedEmail: the arrival-areas line (FR-010)", () => {
  beforeEach(() => {
    projection.throwNext = false;
  });

  it("a public parking area at a published address: the line links to the event page", async () => {
    const s = setup();
    await send(s);
    expect(variables(s).gettingThereUrl).toBe(EVENT_URL);
    expect(variables(s).venueAddress).toBeDefined();
    expect(s.reportError).not.toHaveBeenCalled();
  });

  it("a multi-segment slug keeps its slashes: the link is the real route, not %2F", async () => {
    const s = setup({ slug: "org/us/general/my-event--ab12" });
    await send(s);
    expect(variables(s).gettingThereUrl).toBe(
      `${APP}/events/org/us/general/my-event--ab12`,
    );
  });

  it("an obscured event past its reveal: the buyer gets the street, but an anonymous visitor sees no areas, so no line", async () => {
    const s = setup({ obscuredRevealed: true });
    await send(s);
    expect(variables(s)).toHaveProperty("venueAddress");
    expect(variables(s)).not.toHaveProperty("gettingThereUrl");
  });

  it("a password-gated event with a public parking area: no line (the gate hides the page from nobody-in-particular)", async () => {
    const s = setup({ gateType: "PASSWORD" });
    await send(s);
    expect(variables(s)).not.toHaveProperty("gettingThereUrl");
  });

  it("gate off: no line, and the areas are never read", async () => {
    const s = setup({ gateOn: false });
    await send(s);
    expect(variables(s)).not.toHaveProperty("gettingThereUrl");
    expect(s.repos.arrivalAreas.listForPlace).not.toHaveBeenCalled();
  });

  it("only load-in drawn: no line (an anonymous visitor is shown none of it)", async () => {
    const s = setup({ placeAreas: [area({ kind: "LOAD_IN" })] });
    await send(s);
    expect(variables(s)).not.toHaveProperty("gettingThereUrl");
  });

  it("only a switched-off area: no line", async () => {
    const s = setup({ placeAreas: [area({ disabledAt: new Date("2026-10-02") })] });
    await send(s);
    expect(variables(s)).not.toHaveProperty("gettingThereUrl");
  });

  it("no areas: no line", async () => {
    const s = setup({ placeAreas: [] });
    await send(s);
    expect(variables(s)).not.toHaveProperty("gettingThereUrl");
  });

  it("the email withholds the address: no line, and the areas are never read", async () => {
    const s = setup({ withheld: true });
    await send(s);
    expect(variables(s)).not.toHaveProperty("venueAddress");
    expect(variables(s)).not.toHaveProperty("gettingThereUrl");
    expect(s.repos.arrivalAreas.listForPlace).not.toHaveBeenCalled();
    expect(s.repos.platformSettings.getAll).not.toHaveBeenCalled();
  });

  it("a slugless event: no line (nothing to link to)", async () => {
    const s = setup({ slug: null });
    await send(s);
    expect(variables(s)).not.toHaveProperty("gettingThereUrl");
  });

  it("a repo failure inside the projection: the email still goes, no line, reported", async () => {
    const s = setup({ listForEventThrows: true });
    const result = await send(s);
    expect(result.ok).toBe(true);
    expect(s.mailer.send).toHaveBeenCalledTimes(1);
    expect(variables(s)).not.toHaveProperty("gettingThereUrl");
    expect(s.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({ useCase: "listArrivalAreasForViewer" }),
      }),
    );
  });

  it("a failure that escapes the projection: the email still goes, no line, reported with the email's tags", async () => {
    const s = setup();
    projection.throwNext = true;
    const result = await send(s);
    expect(result.ok).toBe(true);
    expect(s.mailer.send).toHaveBeenCalledTimes(1);
    expect(variables(s)).not.toHaveProperty("gettingThereUrl");
    expect(s.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "projection exploded" }),
      {
        tags: { useCase: "sendTicketIssuedEmail", step: "gettingThere" },
        extra: { orderId: ORDER_ID, eventId: EVENT_ID },
      },
    );
    // NFR-002: the log line carries ids, never a shape or a point.
    const logged = JSON.stringify(s.logger.error.mock.calls);
    expect(logged).not.toContain(String(LAT));
  });

  it("a throwing reporter changes nothing", async () => {
    const s = setup();
    projection.throwNext = true;
    s.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    const result = await send(s);
    expect(result.ok).toBe(true);
    expect(variables(s)).not.toHaveProperty("gettingThereUrl");
  });
});
