import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  getEmbedForWidget,
  type GetEmbedForWidgetDeps,
} from "../get-embed-for-widget";
import {
  getEmbedCalendarEvents,
  type GetEmbedCalendarEventsDeps,
} from "../get-embed-calendar-events";
import {
  getEmbedEventDetail,
  type GetEmbedEventDetailDeps,
} from "../get-embed-event-detail";
import {
  listEmbedAvailableSeats,
  type ListEmbedAvailableSeatsDeps,
} from "../list-embed-available-seats";
import {
  getBookingWidget,
  type GetBookingWidgetDeps,
} from "../get-booking-widget";
import {
  createBookingInquiry,
  type CreateBookingInquiryDeps,
} from "../create-booking-inquiry";

/**
 * Wiring test: every public embed READ procedure's use case enforces the
 * domain allowlist via `assertEmbedOriginAllowed` (rule-level coverage lives
 * in assert-embed-origin-allowed.test.ts; the checkout path is covered in
 * create-embed-guest-checkout.test.ts).
 */

const EMBED_ID = "00000000-0000-4000-8000-0000000000b0";
const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const EVENT_ID = "00000000-0000-4000-8000-0000000000b2";
const SECTION_ID = "00000000-0000-4000-8000-0000000000b3";

const DOMAIN = "embedder.example.com";
const MATCHING_ORIGIN = "https://embedder.example.com";
const WRONG_ORIGIN = "https://attacker.example.net";
const PUBLIC_APP_URL = "http://localhost:3000";

const orgEmbed = {
  id: EMBED_ID,
  domain: DOMAIN,
  subjectType: "organization",
  subjectId: ORG_ID,
  status: "ACTIVE",
  requireAuth: false,
  linkOut: false,
  defaultView: "list",
  viewToggle: false,
};

const emptySearch = () => ({
  autocomplete: vi.fn(async () => ({
    ok: true as const,
    value: { suggestions: [], latencyMs: 1 },
  })),
});

function widgetDeps(): GetEmbedForWidgetDeps {
  return {
    repos: {
      embeds: { getById: vi.fn(async () => orgEmbed) },
      organizations: {
        getById: vi.fn(async () => ({
          id: ORG_ID,
          name: "Demo Org",
          slug: "demo-org",
        })),
      },
      places: { listOwnedBySubject: vi.fn(async () => []) },
      events: {},
    } as unknown as GetEmbedForWidgetDeps["repos"],
    search: emptySearch() as unknown as GetEmbedForWidgetDeps["search"],
    publicAppUrl: PUBLIC_APP_URL,
    logger: createTestLogger(),
  };
}

describe("embed origin enforcement wiring", () => {
  it("getEmbedForWidget allows a matching host origin", async () => {
    const result = await getEmbedForWidget(widgetDeps(), {
      embedId: EMBED_ID,
      hostOrigin: MATCHING_ORIGIN,
    });
    expect(result.embed.id).toBe(EMBED_ID);
  });

  it("getEmbedForWidget allows our own web origin (preview / direct view)", async () => {
    const result = await getEmbedForWidget(widgetDeps(), {
      embedId: EMBED_ID,
      hostOrigin: PUBLIC_APP_URL,
    });
    expect(result.embed.id).toBe(EMBED_ID);
  });

  it("getEmbedForWidget rejects a mismatched host origin before loading data", async () => {
    const deps = widgetDeps();
    await expect(
      getEmbedForWidget(deps, { embedId: EMBED_ID, hostOrigin: WRONG_ORIGIN }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(deps.repos.organizations.getById).not.toHaveBeenCalled();
  });

  it("getEmbedForWidget rejects a null host origin (fail closed)", async () => {
    await expect(
      getEmbedForWidget(widgetDeps(), { embedId: EMBED_ID, hostOrigin: null }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
  });

  it("getEmbedCalendarEvents rejects a mismatched host origin", async () => {
    const deps = {
      repos: {
        embeds: { getById: vi.fn(async () => orgEmbed) },
        organizations: { getById: vi.fn() },
        events: {},
      } as unknown as GetEmbedCalendarEventsDeps["repos"],
      search: { autocomplete: vi.fn() } as unknown as GetEmbedCalendarEventsDeps["search"],
      clock: { now: () => new Date() },
      publicAppUrl: PUBLIC_APP_URL,
      logger: createTestLogger(),
    };
    await expect(
      getEmbedCalendarEvents(deps, {
        embedId: EMBED_ID,
        hostOrigin: WRONG_ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(deps.repos.organizations.getById).not.toHaveBeenCalled();
  });

  it("getEmbedEventDetail rejects a mismatched host origin", async () => {
    const deps = {
      repos: {
        embeds: { getById: vi.fn(async () => orgEmbed) },
        events: { getById: vi.fn() },
      } as unknown as GetEmbedEventDetailDeps["repos"],
      publicAppUrl: PUBLIC_APP_URL,
      logger: createTestLogger(),
    };
    await expect(
      getEmbedEventDetail(deps, {
        embedId: EMBED_ID,
        eventId: EVENT_ID,
        hostOrigin: WRONG_ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(deps.repos.events.getById).not.toHaveBeenCalled();
  });

  it("listEmbedAvailableSeats rejects a mismatched host origin", async () => {
    const deps = {
      repos: {
        embeds: { getById: vi.fn(async () => orgEmbed) },
        events: { getById: vi.fn() },
        seats: { getSectionById: vi.fn(), listAvailableBySection: vi.fn() },
      } as unknown as ListEmbedAvailableSeatsDeps["repos"],
      publicAppUrl: PUBLIC_APP_URL,
      logger: createTestLogger(),
    };
    await expect(
      listEmbedAvailableSeats(deps, {
        embedId: EMBED_ID,
        eventId: EVENT_ID,
        seatSectionId: SECTION_ID,
        hostOrigin: WRONG_ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(deps.repos.events.getById).not.toHaveBeenCalled();
  });

  it("getBookingWidget rejects a mismatched host origin", async () => {
    const deps = {
      repos: {
        embeds: {
          getById: vi.fn(async () => ({
            ...orgEmbed,
            subjectType: "place",
          })),
        },
        places: { getById: vi.fn() },
      } as unknown as GetBookingWidgetDeps["repos"],
      publicAppUrl: PUBLIC_APP_URL,
      logger: createTestLogger(),
    };
    await expect(
      getBookingWidget(deps, { embedId: EMBED_ID, hostOrigin: WRONG_ORIGIN }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(deps.repos.places.getById).not.toHaveBeenCalled();
  });

  it("getBookingWidget rejects a null host origin (fail closed)", async () => {
    const deps = {
      repos: {
        embeds: {
          getById: vi.fn(async () => ({
            ...orgEmbed,
            subjectType: "place",
          })),
        },
        places: { getById: vi.fn() },
      } as unknown as GetBookingWidgetDeps["repos"],
      publicAppUrl: PUBLIC_APP_URL,
      logger: createTestLogger(),
    };
    await expect(
      getBookingWidget(deps, { embedId: EMBED_ID, hostOrigin: null }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(deps.repos.places.getById).not.toHaveBeenCalled();
  });

  function inquiryDeps(): CreateBookingInquiryDeps {
    return {
      repos: {
        embeds: {
          getById: vi.fn(async () => ({ ...orgEmbed, subjectType: "place" })),
        },
        places: { getById: vi.fn() },
        bookingRequests: {
          findOpenByContactEmailAndPlace: vi.fn(),
          create: vi.fn(),
        },
        audit: { log: vi.fn() },
        tx: vi.fn(),
      } as unknown as CreateBookingInquiryDeps["repos"],
      clock: { now: () => new Date("2026-07-13T12:00:00Z") },
      publicAppUrl: PUBLIC_APP_URL,
      logger: createTestLogger(),
    };
  }

  const inquiryInput = {
    embedId: EMBED_ID,
    contactName: "Jo Doe",
    contactEmail: "jo@example.com",
    actName: "The Basement Tapes",
    message: "We'd love to play a Friday night slot.",
    preferredDates: ["2026-08-14"],
  };

  it("createBookingInquiry rejects a mismatched host origin (write path fails closed)", async () => {
    const deps = inquiryDeps();
    await expect(
      createBookingInquiry(deps, {
        ...inquiryInput,
        hostOrigin: WRONG_ORIGIN,
      }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(deps.repos.places.getById).not.toHaveBeenCalled();
    expect(deps.repos.tx).not.toHaveBeenCalled();
  });

  it("createBookingInquiry rejects a null host origin (fail closed)", async () => {
    const deps = inquiryDeps();
    await expect(
      createBookingInquiry(deps, { ...inquiryInput, hostOrigin: null }),
    ).rejects.toMatchObject({ code: "EMBED_ORIGIN_NOT_ALLOWED" });
    expect(deps.repos.places.getById).not.toHaveBeenCalled();
    expect(deps.repos.tx).not.toHaveBeenCalled();
  });
});
