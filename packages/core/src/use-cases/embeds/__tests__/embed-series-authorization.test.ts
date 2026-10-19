import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import type { PublicSeriesDateRecord } from "@th/types/repos/event-series";

import * as checkoutModule from "../../orders/create-checkout";
import {
  getEmbedEventDetail,
  type GetEmbedEventDetailDeps,
} from "../get-embed-event-detail";
import {
  createEmbedGuestCheckout,
  type CreateEmbedGuestCheckoutDeps,
} from "../create-embed-guest-checkout";
import {
  listEmbedAvailableSeats,
  type ListEmbedAvailableSeatsDeps,
} from "../list-embed-available-seats";
import type { Repos } from "@th/ports/repos";

// FR-003: the price resolver requires an injected instant. Frozen so these
// assertions describe a fixed moment, and set far enough in the past that no
// fixture's schedule (none of them have one) could flip under it.
const TEST_NOW = new Date("2026-01-01T00:00:00.000Z");
const testClock = { now: () => TEST_NOW };

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EMBED_ID = "00000000-0000-4000-8000-0000000000a0";
const EVENT_A = "00000000-0000-4000-8000-0000000000a1"; // pinned date
const EVENT_B = "00000000-0000-4000-8000-0000000000a2"; // published sibling
const EVENT_C = "00000000-0000-4000-8000-0000000000a3"; // unrelated event
const ORG_ID = "00000000-0000-4000-8000-0000000000a4";
const SERIES_ID = "00000000-0000-4000-8000-0000000000a5";
const SECTION_ID = "00000000-0000-4000-8000-0000000000a6";
const HUMAN_ID = "00000000-0000-4000-8000-0000000000a7";
const TICKET_TYPE_ID = "00000000-0000-4000-8000-0000000000a8";
const ORDER_FOR_EVENT_B = "00000000-0000-4000-8000-0000000000ff";
const ORDER_FOR_EVENT_C = "00000000-0000-4000-8000-0000000000fe";
const PLACE_ID = "00000000-0000-4000-8000-0000000000a9";
const SERIES_ID_2 = "00000000-0000-4000-8000-0000000000aa";
const OTHER_ORG_ID = "11111111-1111-4111-8111-111111111111";

/** Matches the fixtures' `domain` — the allowlisted embedding origin. */
const HOST_ORIGIN = "https://embedder.example.com";
const GUEST_EMAIL = "guest@example.com";
const GUEST_NAME = "Guest Buyer";

const eventEmbed = {
  id: EMBED_ID,
  domain: "embedder.example.com",
  subjectType: "event" as const,
  subjectId: EVENT_A,
  status: "ACTIVE" as const,
};

const orgEmbed = {
  id: EMBED_ID,
  domain: "embedder.example.com",
  subjectType: "organization" as const,
  subjectId: ORG_ID,
  status: "ACTIVE" as const,
};

const placeEmbed = {
  id: EMBED_ID,
  domain: "embedder.example.com",
  subjectType: "place" as const,
  subjectId: PLACE_ID,
  status: "ACTIVE" as const,
};

function publishedEvent(id: string, orgId = ORG_ID) {
  return {
    id,
    orgId,
    status: "PUBLISHED" as const,
    gateType: "NONE" as const,
    visibility: "PUBLIC" as const,
    title: "Tour Stop",
    slug: null,
    startsAt: new Date("2026-06-01T20:00:00Z"),
    endsAt: new Date("2026-06-01T23:00:00Z"),
    currency: "usd",
    admissionTaxRateBps: 0,
  };
}

function seriesDate(eventId: string): PublicSeriesDateRecord {
  return {
    occurrenceId: `occ-${eventId}`,
    eventId,
    slug: `slug-${eventId}`,
    title: "Tour Stop",
    startsAt: new Date("2026-06-01T20:00:00Z"),
    endsAt: new Date("2026-06-01T23:00:00Z"),
    timezone: "America/New_York",
  };
}

/**
 * seriesOccurrences mock where EVENT_A belongs to a series whose published
 * sibling dates are EVENT_A and EVENT_B (EVENT_C / unpublished siblings are
 * simply absent). Pass `hasSeries: false` to model a pinned event with no
 * series.
 */
function seriesOccurrencesMock({ hasSeries = true } = {}) {
  return {
    findSeriesIdByEventId: vi.fn(async (eventId: string) => {
      if (hasSeries && eventId === EVENT_A) {
        return { seriesId: SERIES_ID, seriesName: "Spring Tour" };
      }
      // Adversarial: EVENT_C is itself the root of a DIFFERENT series. A
      // correct helper resolves the series from the PINNED event (EVENT_A),
      // never from input.eventId, so this branch must never authorize EVENT_C.
      if (eventId === EVENT_C) {
        return { seriesId: SERIES_ID_2, seriesName: "Rival Tour" };
      }
      return null;
    }),
    listPublishedDatesBySeriesId: vi.fn(async (seriesId: string) => {
      if (seriesId === SERIES_ID) {
        return [seriesDate(EVENT_A), seriesDate(EVENT_B)];
      }
      if (seriesId === SERIES_ID_2) {
        return [seriesDate(EVENT_C)];
      }
      return [];
    }),
  };
}

// ── get-embed-event-detail ──────────────────────────────────────────────────

function buildDetailDeps(
  eventsById: Record<string, ReturnType<typeof publishedEvent>>,
  seriesOccurrences: ReturnType<typeof seriesOccurrencesMock>,
): GetEmbedEventDetailDeps {
  // Ensure the pinned event is loadable for the sibling org-match check unless
  // a test overrides it explicitly.
  const events = { [EVENT_A]: publishedEvent(EVENT_A), ...eventsById };
  return {
    repos: {
      embeds: { getById: vi.fn(async () => eventEmbed) },
      events: {
        getById: vi.fn(async (id: string) => events[id] ?? null),
        listTicketTypes: vi.fn(async () => []),
        getContent: vi.fn(async () => null),
      },
      eventHumans: { listByEvent: vi.fn(async () => []) },
      tags: { getEventTags: vi.fn(async () => []) },
      seriesOccurrences,
    } as unknown as GetEmbedEventDetailDeps["repos"],
    clock: testClock,
    logger: createTestLogger(),
  };
}

describe("getEmbedEventDetail — series authorization", () => {
  it("allows a published sibling date of the pinned event's series", async () => {
    const series = seriesOccurrencesMock();
    const deps = buildDetailDeps(
      { [EVENT_B]: publishedEvent(EVENT_B) },
      series,
    );

    const result = await getEmbedEventDetail(deps, {
      embedId: EMBED_ID,
      hostOrigin: HOST_ORIGIN,
      eventId: EVENT_B,
    });

    expect(result.event.id).toBe(EVENT_B);
    // Series resolved from the PINNED event, not the requested one.
    expect(series.findSeriesIdByEventId).toHaveBeenCalledWith(EVENT_A);
  });

  it("allows the pinned event itself without consulting the series", async () => {
    const series = seriesOccurrencesMock();
    const deps = buildDetailDeps(
      { [EVENT_A]: publishedEvent(EVENT_A) },
      series,
    );

    const result = await getEmbedEventDetail(deps, {
      embedId: EMBED_ID,
      hostOrigin: HOST_ORIGIN,
      eventId: EVENT_A,
    });

    expect(result.event.id).toBe(EVENT_A);
    expect(series.findSeriesIdByEventId).not.toHaveBeenCalled();
  });

  it("rejects an unrelated event not in the series", async () => {
    const series = seriesOccurrencesMock();
    const deps = buildDetailDeps(
      { [EVENT_C]: publishedEvent(EVENT_C) },
      series,
    );

    await expect(
      getEmbedEventDetail(deps, {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        eventId: EVENT_C,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects a sibling date when the pinned event has no series", async () => {
    const series = seriesOccurrencesMock({ hasSeries: false });
    const deps = buildDetailDeps(
      { [EVENT_B]: publishedEvent(EVENT_B) },
      series,
    );

    await expect(
      getEmbedEventDetail(deps, {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        eventId: EVENT_B,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});

// ── create-embed-guest-checkout (money path) ──────────────────────────────────

function buildCheckoutDeps(
  eventsById: Record<string, ReturnType<typeof publishedEvent>>,
  seriesOccurrences: ReturnType<typeof seriesOccurrencesMock>,
  embed: typeof eventEmbed | typeof orgEmbed = eventEmbed,
): CreateEmbedGuestCheckoutDeps {
  const events = { [EVENT_A]: publishedEvent(EVENT_A), ...eventsById };
  return {
    repos: {
      embeds: { getById: vi.fn(async () => embed) },
      events: {
        getById: vi.fn(async (id: string) => events[id] ?? null),
        listTicketTypes: vi.fn(async () => [
          { id: TICKET_TYPE_ID, name: "General Admission" },
        ]),
      },
      // The use case reads the confirmation's lines back from the order the
      // mocked createCheckout "persisted": one 1000¢ ticket on the event the
      // test checks out (orderId → event, as the mocks below return them).
      orders: {
        getById: vi.fn(async (id: string) => ({
          id,
          eventId: { [ORDER_FOR_EVENT_B]: EVENT_B, [ORDER_FOR_EVENT_C]: EVENT_C }[id],
          buyerHumanId: HUMAN_ID,
          items: [
            {
              id: "item-1",
              kind: "ticket",
              ticketTypeId: TICKET_TYPE_ID,
              qty: 1,
              unitPriceCents: 1000,
              amountCents: 1000,
            },
          ],
        })),
      },
      humans: {
        ensureGuestHuman: vi.fn(async () => ({
          humanId: HUMAN_ID,
          created: true,
        })),
        update: vi.fn(async (id: string, u: any) => ({ id, ...u })),
      },
      seriesOccurrences,
    } as unknown as Repos,
    payments: {} as never,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => new Date("2026-05-01T18:00:00Z") },
    clock: testClock,
    logger: createTestLogger(),
  };
}

describe("createEmbedGuestCheckout — series authorization", () => {
  it("allows checkout for a published sibling date of the series", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({
        orderId: ORDER_FOR_EVENT_B,
        clientSecret: "pi_secret",
        amountGrossCents: 1000,
        feesPlatformCents: 50,
        buyerFeesCents: 50,
        processorFeeCents: 59,
        taxAmountCents: 0,
        holdExpiresAt: null,
      } as never);

    const series = seriesOccurrencesMock();
    const deps = buildCheckoutDeps(
      { [EVENT_B]: publishedEvent(EVENT_B) },
      series,
    );

    try {
      await createEmbedGuestCheckout(deps, {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        eventId: EVENT_B,
        guestName: GUEST_NAME,
        guestEmail: GUEST_EMAIL,
        clientKey: "guest-client-key-0000000-sibling",
        refundPolicyAccepted: true,
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
      });

      expect(series.findSeriesIdByEventId).toHaveBeenCalledWith(EVENT_A);
      expect(createCheckoutSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventId: EVENT_B }),
        // Server-only third argument: the embed the order is made through,
        // and the receipt secret's hash.
        {
          embedId: EMBED_ID,
          receiptSecretHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      );
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("rejects checkout for an unrelated event before creating a guest", async () => {
    const createCheckoutSpy = vi.spyOn(checkoutModule, "createCheckout");
    const series = seriesOccurrencesMock();
    const deps = buildCheckoutDeps(
      { [EVENT_C]: publishedEvent(EVENT_C) },
      series,
    );

    try {
      await expect(
        createEmbedGuestCheckout(deps, {
          embedId: EMBED_ID,
          hostOrigin: HOST_ORIGIN,
          eventId: EVENT_C,
          guestName: GUEST_NAME,
          guestEmail: GUEST_EMAIL,
          clientKey: "guest-client-key-0000000-unrelated",
          refundPolicyAccepted: true,
          items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
        }),
      ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });

      expect(deps.repos.humans.ensureGuestHuman).not.toHaveBeenCalled();
      expect(createCheckoutSpy).not.toHaveBeenCalled();
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("rejects a sibling when the pinned event has no series", async () => {
    const series = seriesOccurrencesMock({ hasSeries: false });
    const deps = buildCheckoutDeps(
      { [EVENT_B]: publishedEvent(EVENT_B) },
      series,
    );

    await expect(
      createEmbedGuestCheckout(deps, {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        eventId: EVENT_B,
        guestName: GUEST_NAME,
        guestEmail: GUEST_EMAIL,
        clientKey: "guest-client-key-0000000-noseries",
        refundPolicyAccepted: true,
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("leaves organization embeds unchanged (regression guard)", async () => {
    const createCheckoutSpy = vi
      .spyOn(checkoutModule, "createCheckout")
      .mockResolvedValue({
        orderId: ORDER_FOR_EVENT_C,
        clientSecret: "pi_secret",
        amountGrossCents: 1000,
        feesPlatformCents: 50,
        buyerFeesCents: 50,
        processorFeeCents: 59,
        taxAmountCents: 0,
        holdExpiresAt: null,
      } as never);

    const series = seriesOccurrencesMock();
    const deps = buildCheckoutDeps(
      { [EVENT_C]: publishedEvent(EVENT_C, ORG_ID) },
      series,
      orgEmbed,
    );

    try {
      await createEmbedGuestCheckout(deps, {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        eventId: EVENT_C,
        guestName: GUEST_NAME,
        guestEmail: GUEST_EMAIL,
        clientKey: "guest-client-key-0000000-org",
        refundPolicyAccepted: true,
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
      });

      // Org events are authorized by orgId; the series repo is never consulted.
      expect(series.findSeriesIdByEventId).not.toHaveBeenCalled();
      expect(createCheckoutSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventId: EVENT_C }),
        // Server-only third argument: the embed the order is made through,
        // and the receipt secret's hash.
        {
          embedId: EMBED_ID,
          receiptSecretHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      );
    } finally {
      createCheckoutSpy.mockRestore();
    }
  });

  it("rejects an org-mismatched event for organization embeds", async () => {
    const series = seriesOccurrencesMock();
    const deps = buildCheckoutDeps(
      {
        [EVENT_C]: publishedEvent(
          EVENT_C,
          "11111111-1111-4111-8111-111111111111",
        ),
      },
      series,
      orgEmbed,
    );

    await expect(
      createEmbedGuestCheckout(deps, {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        eventId: EVENT_C,
        guestName: GUEST_NAME,
        guestEmail: GUEST_EMAIL,
        clientKey: "guest-client-key-0000000-org-mismatch",
        refundPolicyAccepted: true,
        items: [{ ticketTypeId: TICKET_TYPE_ID, qty: 1 }],
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});

// ── list-embed-available-seats ────────────────────────────────────────────────

function buildSeatsDeps(
  eventsById: Record<string, ReturnType<typeof publishedEvent>>,
  seriesOccurrences: ReturnType<typeof seriesOccurrencesMock>,
  embed: typeof eventEmbed | typeof orgEmbed | typeof placeEmbed = eventEmbed,
): ListEmbedAvailableSeatsDeps {
  const events = { [EVENT_A]: publishedEvent(EVENT_A), ...eventsById };
  return {
    repos: {
      embeds: { getById: vi.fn(async () => embed) },
      events: { getById: vi.fn(async (id: string) => events[id] ?? null) },
      seats: {
        getSectionById: vi.fn(async () => ({
          id: SECTION_ID,
          name: "Floor",
          type: "RESERVED",
          capacity: 50,
        })),
        listAvailableBySection: vi.fn(async () => []),
      },
      payoutTerms: {
        listByEvent: vi.fn(async () => []),
        listLines: vi.fn(async () => []),
      },
      feePolicies: {
        getById: vi.fn(async () => null),
        resolveEffective: vi.fn(async () => null),
      },
      seriesOccurrences,
    } as unknown as ListEmbedAvailableSeatsDeps["repos"],
    clock: testClock,
    logger: createTestLogger(),
  };
}

describe("listEmbedAvailableSeats — series authorization", () => {
  it("allows a published sibling date of the series", async () => {
    const series = seriesOccurrencesMock();
    const deps = buildSeatsDeps({ [EVENT_B]: publishedEvent(EVENT_B) }, series);

    const result = await listEmbedAvailableSeats(deps, {
      embedId: EMBED_ID,
      hostOrigin: HOST_ORIGIN,
      eventId: EVENT_B,
      seatSectionId: SECTION_ID,
    });

    expect(result.section.id).toBe(SECTION_ID);
    expect(series.findSeriesIdByEventId).toHaveBeenCalledWith(EVENT_A);
  });

  it("rejects an unrelated event not in the series", async () => {
    const series = seriesOccurrencesMock();
    const deps = buildSeatsDeps({ [EVENT_C]: publishedEvent(EVENT_C) }, series);

    await expect(
      listEmbedAvailableSeats(deps, {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        eventId: EVENT_C,
        seatSectionId: SECTION_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects a sibling when the pinned event has no series", async () => {
    const series = seriesOccurrencesMock({ hasSeries: false });
    const deps = buildSeatsDeps({ [EVENT_B]: publishedEvent(EVENT_B) }, series);

    await expect(
      listEmbedAvailableSeats(deps, {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        eventId: EVENT_B,
        seatSectionId: SECTION_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("fails closed for an unsupported (place) subject type", async () => {
    // Regression: a place-type embed must NOT authorize seat enumeration for
    // any published event. The helper has no silent-allow path.
    const series = seriesOccurrencesMock();
    const deps = buildSeatsDeps(
      { [EVENT_C]: publishedEvent(EVENT_C) },
      series,
      placeEmbed,
    );

    await expect(
      listEmbedAvailableSeats(deps, {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        eventId: EVENT_C,
        seatSectionId: SECTION_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(series.findSeriesIdByEventId).not.toHaveBeenCalled();
  });

  it("rejects a cross-org sibling even when it is in the pinned series", async () => {
    // Defense-in-depth: requested event is a published member of the pinned
    // event's series but belongs to a DIFFERENT org than the pinned event.
    const series = seriesOccurrencesMock();
    const deps = buildSeatsDeps(
      {
        [EVENT_A]: publishedEvent(EVENT_A, ORG_ID),
        [EVENT_B]: publishedEvent(EVENT_B, OTHER_ORG_ID),
      },
      series,
    );

    await expect(
      listEmbedAvailableSeats(deps, {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        eventId: EVENT_B,
        seatSectionId: SECTION_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("resolves the series from the pinned event, not an adversarial second series", async () => {
    // EVENT_C is itself the root of a rival series (SERIES_ID_2). The helper
    // must resolve the series from the PINNED event (EVENT_A) and reject
    // EVENT_C, never pivot off input.eventId.
    const series = seriesOccurrencesMock();
    const deps = buildSeatsDeps({ [EVENT_C]: publishedEvent(EVENT_C) }, series);

    await expect(
      listEmbedAvailableSeats(deps, {
        embedId: EMBED_ID,
        hostOrigin: HOST_ORIGIN,
        eventId: EVENT_C,
        seatSectionId: SECTION_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });

    expect(series.findSeriesIdByEventId).toHaveBeenCalledWith(EVENT_A);
    expect(series.findSeriesIdByEventId).not.toHaveBeenCalledWith(EVENT_C);
  });
});
