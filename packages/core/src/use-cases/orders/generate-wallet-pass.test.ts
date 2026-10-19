import { describe, it, expect, beforeEach, vi } from "vitest";

import { formatOrderCode } from "@th/types/order-identifier";

import { generateWalletPass, lockedPassAddressNotice } from "./generate-wallet-pass";
import type { GenerateWalletPassDeps } from "./generate-wallet-pass";
import type {
  WalletPassPort,
  WalletPassType,
  WalletPassTicketData,
} from "@th/ports/wallet-pass.port";
import type { Repos } from "@th/ports/repos";
import type { ReporterPort } from "@th/ports/reporter";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ACTOR = "00000000-0000-4000-8000-000000000099";
const TICKET_ID = "00000000-0000-4000-8000-000000000010";
const EVENT_ID = "00000000-0000-4000-8000-000000000020";
const ORDER_ID = "00000000-0000-4000-8000-000000000030";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-000000000040";
const ORDER_ITEM_ID = "00000000-0000-4000-8000-000000000050";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTicket(
  overrides: Partial<{
    id: string;
    ownerHumanId: string;
    status: string;
    eventId: string;
    orderId: string | null;
    ticketTypeId: string | null;
    orderItemId: string | null;
    code: string;
  }> = {},
) {
  return {
    id: overrides.id ?? TICKET_ID,
    ownerHumanId: overrides.ownerHumanId ?? ACTOR_ID,
    status: overrides.status ?? "VALID",
    eventId: overrides.eventId ?? EVENT_ID,
    orderId: overrides.orderId ?? ORDER_ID,
    ticketTypeId: overrides.ticketTypeId ?? TICKET_TYPE_ID,
    orderItemId:
      overrides.orderItemId === undefined
        ? ORDER_ITEM_ID
        : overrides.orderItemId,
    code: overrides.code ?? "ABCD-1234-EFGH",
  };
}

/** The buyer's purchase snapshot: `OrderItem.unitPriceCents`. */
function makeOrderItem(unitPriceCents: number) {
  return {
    id: ORDER_ITEM_ID,
    orderId: ORDER_ID,
    kind: "ticket",
    ticketTypeId: TICKET_TYPE_ID,
    qty: 1,
    unitPriceCents,
    amountCents: unitPriceCents,
    meta: {},
    status: "active",
  };
}

/**
 * EXPLICITLY EXACT with no venue. The address gate (`resolveHolderAddress`)
 * fails closed on a missing `locationMode`, so a fixture that omitted it would
 * quietly run every test below through the LOCKED path.
 */
function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    title: "Test Concert",
    startsAt: new Date("2026-06-15T19:00:00Z"),
    endsAt: new Date("2026-06-15T23:00:00Z"),
    locationLabel: "Test Venue",
    addressText: "123 Test St",
    currency: "usd",
    timezone: "America/Chicago",
    locationMode: "EXACT",
    locationRadiusMeters: null,
    addressRevealAt: null,
    addressRevealPreset: null,
    placeId: null,
    locality: null,
    region: null,
    postalCode: null,
    lat: null,
    lng: null,
    ...overrides,
  };
}

function makeOrder() {
  return {
    id: ORDER_ID,
  };
}

/**
 * Captures the last `WalletPassTicketData` the use case handed the port, so a
 * test can assert on the pass PAYLOAD rather than only on the port's canned
 * return value.
 */
const passDataCaptures: WalletPassTicketData[] = [];

function makeWalletPassPort(
  overrides: Partial<{
    configured: boolean;
    result:
      | { type: "apple"; passBuffer: Buffer; filename: string }
      | { type: "google"; saveUrl: string };
  }> = {},
): WalletPassPort {
  const configured = overrides.configured ?? true;
  return {
    async isConfigured(_type: WalletPassType) {
      return configured;
    },
    async generate(_type: WalletPassType, _data: WalletPassTicketData) {
      passDataCaptures.push(_data);
      if (overrides.result) return overrides.result;
      if (_type === "apple") {
        return {
          type: "apple" as const,
          passBuffer: Buffer.from("fake-pkpass-bytes"),
          filename: "ithasfire-ORD-001.pkpass",
        };
      }
      return {
        type: "google" as const,
        saveUrl: "https://pay.google.com/gp/v/save/test-jwt",
      };
    },
  };
}

function makeDeps(
  overrides: Partial<{
    ticket: ReturnType<typeof makeTicket> | null;
    event: ReturnType<typeof makeEvent> | null;
    order: ReturnType<typeof makeOrder> | null;
    ticketType: { id: string; name: string; priceCents: number } | null;
    human: { id: string; name: string } | null;
    walletPass: WalletPassPort;
    /** `OrderItem.unitPriceCents` — what the buyer actually paid. */
    purchasedUnitPriceCents: number;
    /** Force `orderItems.getById` to miss (legacy / fixture ticket). */
    orderItemMissing: boolean;
    reportError: ReporterPort;
    /** The event's venue row, served by `places.getById`. */
    place: Record<string, unknown> | null;
  }> = {},
): GenerateWalletPassDeps {
  const ticket =
    overrides.ticket === undefined ? makeTicket() : overrides.ticket;
  const event = overrides.event === undefined ? makeEvent() : overrides.event;
  const order = overrides.order === undefined ? makeOrder() : overrides.order;
  const ticketType =
    overrides.ticketType === undefined
      ? { id: TICKET_TYPE_ID, name: "GA", priceCents: 2500 }
      : overrides.ticketType;
  const human =
    overrides.human === undefined
      ? { id: ACTOR_ID, name: "Test User" }
      : overrides.human;

  return {
    repos: {
      tickets: {
        getById: async () => ticket,
        getTicketTypeById: async () => ticketType,
      },
      orderItems: {
        getById: async () =>
          overrides.orderItemMissing
            ? null
            : makeOrderItem(overrides.purchasedUnitPriceCents ?? 2500),
      },
      orders: {
        getById: async () => order,
      },
      events: {
        getById: async () => event,
      },
      humans: {
        getById: async () => human,
      },
      places: {
        getById: async () => overrides.place ?? null,
      },
    } as unknown as Repos,
    walletPass: overrides.walletPass ?? makeWalletPassPort(),
    logger: undefined,
    ...(overrides.reportError ? { reportError: overrides.reportError } : {}),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("generateWalletPass", () => {
  // ── Happy paths ──────────────────────────────────────────────────────────

  it("generates Apple pass: returns base64 + filename", async () => {
    const deps = makeDeps();
    const result = await generateWalletPass(deps, {
      actorHumanId: ACTOR_ID,
      ticketId: TICKET_ID,
      passType: "apple",
    });

    expect(result.passType).toBe("apple");
    expect(result.passBase64).toBeTruthy();
    expect(result.filename).toBe("ithasfire-ORD-001.pkpass");
    expect(result.saveUrl).toBeNull();
  });

  it("generates Google pass: returns saveUrl", async () => {
    const deps = makeDeps();
    const result = await generateWalletPass(deps, {
      actorHumanId: ACTOR_ID,
      ticketId: TICKET_ID,
      passType: "google",
    });

    expect(result.passType).toBe("google");
    expect(result.saveUrl).toBe("https://pay.google.com/gp/v/save/test-jwt");
    expect(result.passBase64).toBeNull();
    expect(result.filename).toBeNull();
  });

  // ── Ownership / auth ─────────────────────────────────────────────────────

  it("throws not_found when ticket does not exist", async () => {
    const deps = makeDeps({ ticket: null });

    await expect(
      generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      }),
    ).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" });
  });

  it("throws not_found when actor does not own the ticket", async () => {
    const deps = makeDeps({
      ticket: makeTicket({ ownerHumanId: OTHER_ACTOR }),
    });

    await expect(
      generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      }),
    ).rejects.toMatchObject({ code: "TICKET_NOT_FOUND" });
  });

  // ── Ticket status ────────────────────────────────────────────────────────

  it("throws conflict when ticket is not VALID", async () => {
    const deps = makeDeps({
      ticket: makeTicket({ status: "USED" }),
    });

    await expect(
      generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      }),
    ).rejects.toMatchObject({ code: "TICKET_NOT_VALID" });
  });

  // ── Adapter not configured ───────────────────────────────────────────────

  it("throws not_configured when adapter is not configured", async () => {
    const deps = makeDeps({
      walletPass: makeWalletPassPort({ configured: false }),
    });

    await expect(
      generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      }),
    ).rejects.toMatchObject({ code: "WALLET_PASS_NOT_CONFIGURED" });
  });

  // ── Input validation ─────────────────────────────────────────────────────

  it("throws invalid_input for bad ticketId", async () => {
    const deps = makeDeps();

    await expect(
      generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: "not-a-uuid",
        passType: "apple",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("throws invalid_input for unsupported passType", async () => {
    const deps = makeDeps();

    await expect(
      generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "samsung",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  // ── Order reference on the pass ──────────────────────────────────────────
  //
  // The pass used to carry `Order.shortId`, a random 10-char base-36 code that
  // matched NOTHING an admin or the buyer could see anywhere else. It now
  // carries `orderRef` — the one platform order code — derived through
  // `formatOrderCode` so it cannot drift from the order page or admin search.

  describe("orderRef", () => {
    beforeEach(() => {
      passDataCaptures.length = 0;
    });

    it("is the formatted order code, derived from the resolved order id", async () => {
      const deps = makeDeps();

      await generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      });

      const data = passDataCaptures.at(-1)!;
      expect(data.orderId).toBe(ORDER_ID);
      expect(data.orderRef).toBe(formatOrderCode(ORDER_ID));
      // Pinned literally as well as by round trip: the pass must show exactly
      // what `#{order.id.slice(-8).toUpperCase()}` shows.
      expect(data.orderRef).toBe("00000030");
    });

    it("falls back to the ticket's orderId when the order row is missing", async () => {
      // Same resolved id as `orderId`, so the pass and the order page agree
      // even when the order lookup came back empty.
      const deps = makeDeps({ order: null });

      await generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      });

      const data = passDataCaptures.at(-1)!;
      expect(data.orderId).toBe(ORDER_ID);
      expect(data.orderRef).toBe(formatOrderCode(ORDER_ID));
    });

    it("is null — never an empty string — when no order id can be resolved", async () => {
      // NOTE `makeTicket({ orderId: null })` cannot express this — the helper
      // uses `??`, so null falls back to ORDER_ID. Override after the fact.
      const deps = makeDeps({
        order: null,
        ticket: { ...makeTicket(), orderId: null as unknown as string },
      });

      await generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      });

      const data = passDataCaptures.at(-1)!;
      expect(data.orderId).toBe("");
      expect(data.orderRef).toBeNull();
    });
  });

  // ── FR-002: the pass shows the price PAID ────────────────────────────────
  //
  // The pass used to read `TicketType.priceCents`, so re-issuing a pass after
  // the organizer edited the price rewrote the number on the buyer's phone.
  // It now reads the purchase snapshot on `OrderItem.unitPriceCents`.

  describe("priceCents", () => {
    beforeEach(() => {
      passDataCaptures.length = 0;
    });

    it("is the price paid, not the live ticket-type price", async () => {
      // Bought at $12 early-bird; organizer has since raised the type to $20.
      const deps = makeDeps({
        ticketType: { id: TICKET_TYPE_ID, name: "GA", priceCents: 2000 },
        purchasedUnitPriceCents: 1200,
      });

      await generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      });

      const data = passDataCaptures.at(-1)!;
      expect(data.priceCents).toBe(1200);
      expect(data.priceCents).not.toBe(2000);
      // The type is still the source for the display NAME.
      expect(data.ticketTypeName).toBe("GA");
    });

    it("re-issuing after a price change reproduces the original price", async () => {
      const before = makeDeps({
        ticketType: { id: TICKET_TYPE_ID, name: "GA", priceCents: 1200 },
        purchasedUnitPriceCents: 1200,
      });
      await generateWalletPass(before, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      });
      const firstIssue = passDataCaptures.at(-1)!.priceCents;

      const after = makeDeps({
        ticketType: { id: TICKET_TYPE_ID, name: "GA", priceCents: 2000 },
        purchasedUnitPriceCents: 1200,
      });
      await generateWalletPass(after, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      });
      const reIssue = passDataCaptures.at(-1)!.priceCents;

      expect(reIssue).toBe(firstIssue);
      expect(reIssue).toBe(1200);
    });

    it("is 0 for a comp ticket — its OrderItem is snapshotted at 0", async () => {
      const deps = makeDeps({
        ticketType: { id: TICKET_TYPE_ID, name: "GA", priceCents: 2500 },
        purchasedUnitPriceCents: 0,
      });

      await generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      });

      expect(passDataCaptures.at(-1)!.priceCents).toBe(0);
    });

    it("degrades to 0 and reports when no purchase snapshot is reachable", async () => {
      const reportError = vi.fn();
      const deps = makeDeps({
        ticketType: { id: TICKET_TYPE_ID, name: "GA", priceCents: 2500 },
        orderItemMissing: true,
        reportError,
      });

      await generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      });

      // Never the live 2500.
      expect(passDataCaptures.at(-1)!.priceCents).toBe(0);
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: { useCase: "generateWalletPass" },
          extra: expect.objectContaining({ ticketId: TICKET_ID }),
        }),
      );
    });

    it("still issues the pass when the reporter throws", async () => {
      const reportError = vi.fn(() => {
        throw new Error("sentry exploded");
      });
      const deps = makeDeps({ orderItemMissing: true, reportError });

      const result = await generateWalletPass(deps, {
        actorHumanId: ACTOR_ID,
        ticketId: TICKET_ID,
        passType: "apple",
      });

      expect(result.passType).toBe("apple");
      expect(passDataCaptures.at(-1)!.priceCents).toBe(0);
    });
  });
});

// ── The address on the pass ──────────────────────────────────────────────────
//
// The pass used to print `event.addressText` with no mode, reveal-date or
// NEVER check. A pass is OFF-PLATFORM and never rewritten after it is saved,
// so whatever it carries at issue time is what it says for good.

describe("generateWalletPass — address reveal gate", () => {
  const PLACE_ID = "00000000-0000-4000-8000-0000000000b1";
  const VENUE_ORG = "00000000-0000-4000-8000-0000000000c1";
  const STRANGER_ORG = "00000000-0000-4000-8000-0000000000c2";
  const HOUR = 60 * 60 * 1000;

  /** Owned by VENUE_ORG, which also owns the projection event below. */
  const withheldPlace = {
    id: PLACE_ID,
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: true,
    name: "The Blue Door House",
    formattedAddress: "901 Porter Rd",
    addressLine1: "901 Porter Rd",
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37206",
    countryCode: "US",
    lat: 36.1862,
    lng: -86.7291,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    locationLabel: "East Nashville",
  };

  /** Part 1's storage for an event at that venue: a PUBLIC projection. */
  const projectionOverrides = {
    orgId: VENUE_ORG,
    humanId: null,
    stewardship: "OWNED",
    placeId: PLACE_ID,
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    addressRevealPreset: "DAY_BEFORE",
    locationLabel: "East Nashville",
    addressText: "East Nashville",
    locality: "Nashville",
    region: "TN",
    lat: 36.18,
    lng: -86.75,
  };

  beforeEach(() => {
    passDataCaptures.length = 0;
  });

  async function issue(deps: GenerateWalletPassDeps) {
    await generateWalletPass(deps, {
      actorHumanId: ACTOR_ID,
      ticketId: TICKET_ID,
      passType: "apple",
    });
    return passDataCaptures.at(-1)!;
  }

  it("EXACT: unchanged — the organizer's label and the stored street", async () => {
    const data = await issue(makeDeps());
    expect(data.venueName).toBe("Test Venue");
    expect(data.venueAddress).toBe("123 Test St");
    expect(data.addressLocked).toBe(false);
  });

  it("NEVER: no street, ever — a label and 'not sharing' in the address slot", async () => {
    const data = await issue(
      makeDeps({
        event: makeEvent({
          locationMode: "OBSCURED",
          addressRevealPreset: "NEVER",
          addressRevealAt: null,
          locality: "Nashville",
          region: "TN",
        }) as ReturnType<typeof makeEvent>,
      }),
    );
    expect(data.venueName).toBe("Nashville, TN");
    expect(data.venueAddress).toBe("The organizer isn't sharing this address.");
    // Tells the Google adapter to keep this pass off the event's shared class.
    expect(data.addressLocked).toBe(true);
    expect(JSON.stringify(data)).not.toContain("123 Test St");
  });

  it("before the reveal: the email's notice, with the date in the event's zone", async () => {
    // 2026-06-14T19:00Z = 2:00 PM CDT on Sunday, June 14, 2026.
    const revealAt = new Date("2026-06-14T19:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
    try {
      const data = await issue(
        makeDeps({
          event: makeEvent({
            locationMode: "OBSCURED",
            addressRevealPreset: "DAY_BEFORE",
            addressRevealAt: revealAt,
            locality: "Nashville",
            region: "TN",
          }) as ReturnType<typeof makeEvent>,
        }),
      );
      expect(data.venueName).toBe("Nashville, TN");
      // Whitespace-normalised: some ICU builds put U+202F before "PM".
      expect(data.venueAddress?.replace(/\s/g, " ")).toBe(
        "The exact address will be shared on Sunday, June 14, 2026 at 2:00 PM. We'll send you a reminder.",
      );
      expect(JSON.stringify(data)).not.toContain("123 Test St");
    } finally {
      vi.useRealTimers();
    }
  });

  it("before the reveal at a Los Angeles event: the reveal date reads in Pacific time", async () => {
    // 22:30 PDT Sun Jun 14 = 05:30Z Mon Jun 15.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
    try {
      const data = await issue(
        makeDeps({
          event: makeEvent({
            locationMode: "OBSCURED",
            addressRevealPreset: "DAY_BEFORE",
            addressRevealAt: new Date("2026-06-15T05:30:00.000Z"),
            locality: "Los Angeles",
            region: "CA",
            timezone: "America/Los_Angeles",
          }) as ReturnType<typeof makeEvent>,
        }),
      );
      expect(data.venueAddress?.replace(/\s/g, " ")).toBe(
        "The exact address will be shared on Sunday, June 14, 2026 at 10:30 PM. We'll send you a reminder.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("locked with no coarse label: 'Place TBA', so Google still renders the notice", async () => {
    const data = await issue(
      makeDeps({
        event: makeEvent({
          locationMode: "OBSCURED",
          addressRevealPreset: null,
          addressRevealAt: null,
          locationLabel: null,
        }) as ReturnType<typeof makeEvent>,
      }),
    );
    expect(data.venueName).toBe("Place TBA");
    expect(data.venueAddress).toBe("The exact address hasn't been shared yet.");
  });

  it("after the reveal at a withheld venue: the Place's TRUE street, not the Event projection", async () => {
    const data = await issue(
      makeDeps({
        event: makeEvent({
          ...projectionOverrides,
          addressRevealAt: new Date(Date.now() - HOUR),
        }) as ReturnType<typeof makeEvent>,
        place: withheldPlace,
      }),
    );
    expect(data.venueAddress).toBe("901 Porter Rd");
    expect(data.venueAddress).not.toBe(projectionOverrides.addressText);
  });

  it("before the reveal at a withheld venue: neither the street nor the venue name is on the pass", async () => {
    const data = await issue(
      makeDeps({
        event: makeEvent({
          ...projectionOverrides,
          addressRevealAt: new Date(Date.now() + 24 * HOUR),
        }) as ReturnType<typeof makeEvent>,
        place: withheldPlace,
      }),
    );
    expect(data.venueName).toBe("Nashville, TN");
    expect(data.venueAddress).toMatch(/^The exact address will be shared on /);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("Porter");
    expect(serialized).not.toContain("Blue Door");
  });

  it("locked with a whitespace-only label: still 'Place TBA'", async () => {
    const data = await issue(
      makeDeps({
        event: makeEvent({
          locationMode: "OBSCURED",
          addressRevealPreset: null,
          addressRevealAt: null,
          locationLabel: "   ",
        }) as ReturnType<typeof makeEvent>,
      }),
    );
    expect(data.venueName).toBe("Place TBA");
  });

  it("an EXACT event row at a withheld venue (published before it hid) is locked", async () => {
    const data = await issue(
      makeDeps({
        // The venue's own show, so the only lock is the missing reveal date.
        event: makeEvent({
          placeId: PLACE_ID,
          orgId: VENUE_ORG,
        }) as ReturnType<typeof makeEvent>,
        place: withheldPlace,
      }),
    );
    expect(data.venueAddress).toBe("The exact address hasn't been shared yet.");
    expect(JSON.stringify(data)).not.toContain("123 Test St");
  });

  it("C1: a stranger's UNCONFIRMED event at the house (IMMEDIATELY, valid ticket): locked for good, 'ask the organizer'", async () => {
    const data = await issue(
      makeDeps({
        event: makeEvent({
          ...projectionOverrides,
          orgId: STRANGER_ORG,
          addressRevealPreset: "IMMEDIATELY",
          addressRevealAt: new Date(Date.now() - HOUR),
        }) as ReturnType<typeof makeEvent>,
        place: withheldPlace,
      }),
    );
    expect(data.addressLocked).toBe(true);
    expect(data.venueName).toBe("Nashville, TN");
    expect(data.venueAddress).toBe(
      "The place shares its address with events it has confirmed. Ask the organizer where to go.",
    );
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("Porter");
    expect(serialized).not.toContain("Blue Door");
    expect(serialized).not.toContain("36.1862");
  });

  it("C1: a community listing the house accepts by blanket consent: locked", async () => {
    const data = await issue(
      makeDeps({
        event: makeEvent({
          ...projectionOverrides,
          orgId: null,
          stewardship: "COMMUNITY",
          addressRevealPreset: "IMMEDIATELY",
          addressRevealAt: new Date(Date.now() - HOUR),
        }) as ReturnType<typeof makeEvent>,
        place: withheldPlace,
      }),
    );
    expect(data.addressLocked).toBe(true);
    expect(JSON.stringify(data)).not.toContain("Porter");
  });
});

describe("lockedPassAddressNotice", () => {
  const base = { locked: true as const, label: null, never: false };

  it("never / venueUnconfirmed / no date / dated", () => {
    expect(
      lockedPassAddressNotice({ ...base, reason: "never", revealAt: null, never: true }, null),
    ).toBe("The organizer isn't sharing this address.");
    expect(
      lockedPassAddressNotice({ ...base, reason: "venueUnconfirmed", revealAt: null }, null),
    ).toBe(
      "The place shares its address with events it has confirmed. Ask the organizer where to go.",
    );
    expect(
      lockedPassAddressNotice({ ...base, reason: "notYetRevealed", revealAt: null }, null),
    ).toBe("The exact address hasn't been shared yet.");
    // An unreadable venue is not the venue's "no": no "ask the organizer",
    // and no date promised on a pass that is never rewritten.
    expect(
      lockedPassAddressNotice({ ...base, reason: "placeUnavailable", revealAt: null }, null),
    ).toBe(
      "The address isn't available right now. Check your order page for updates.",
    );
    expect(
      lockedPassAddressNotice(
        {
          ...base,
          reason: "notYetRevealed",
          revealAt: new Date("2026-06-14T19:00:00.000Z"),
        },
        "America/Chicago",
      ).replace(/\s/g, " "),
    ).toBe(
      "The exact address will be shared on Sunday, June 14, 2026 at 2:00 PM. We'll send you a reminder.",
    );
  });

  // 22:30 PDT on Sun Jun 14 is 05:30Z on Mon Jun 15: the server's zone (UTC
  // on Cloud Run) or Chicago would both print the wrong day or hour.
  it("dates the reveal in the event's own zone", () => {
    expect(
      lockedPassAddressNotice(
        {
          ...base,
          reason: "notYetRevealed",
          revealAt: new Date("2026-06-15T05:30:00.000Z"),
        },
        "America/Los_Angeles",
      ).replace(/\s/g, " "),
    ).toBe(
      "The exact address will be shared on Sunday, June 14, 2026 at 10:30 PM. We'll send you a reminder.",
    );
  });

  // 03:30Z Mon Jun 15 is 10:30 PM CDT Sun Jun 14. The old fallback was UTC
  // and printed Monday.
  it.each([null, undefined, "", "Not/AZone"])(
    "a missing or unknown zone (%s) reads in the platform default, not UTC",
    (zone) => {
      expect(
        lockedPassAddressNotice(
          {
            ...base,
            reason: "notYetRevealed",
            revealAt: new Date("2026-06-15T03:30:00.000Z"),
          },
          zone,
        ).replace(/\s/g, " "),
      ).toBe(
        "The exact address will be shared on Sunday, June 14, 2026 at 10:30 PM. We'll send you a reminder.",
      );
    },
  );
});
