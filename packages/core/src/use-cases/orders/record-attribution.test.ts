import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { EventHumanRecord } from "@th/ports/repos/event-humans";
import type { TicketAttributionRecord } from "@th/ports/repos/ticket-attributions";
import type { TxRepos } from "@th/ports/repos";

import { recordAttribution } from "./record-attribution";

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

const eventHumanFactory = (
  overrides: Partial<EventHumanRecord> = {},
): EventHumanRecord => ({
  id: overrides.id ?? randomUUID(),
  eventId: overrides.eventId ?? randomUUID(),
  humanId: overrides.humanId ?? randomUUID(),
  externalName: overrides.externalName ?? "DJ Example",
  externalUrl: overrides.externalUrl ?? null,
  role: overrides.role ?? "PERFORMER",
  customRoleLabel: overrides.customRoleLabel ?? null,
  sortOrder: overrides.sortOrder ?? 0,
  createdAt: overrides.createdAt ?? new Date(),
  updatedAt: overrides.updatedAt ?? new Date(),
});

const attributionRecordFactory = (
  overrides: Partial<TicketAttributionRecord> = {},
): TicketAttributionRecord => ({
  id: randomUUID(),
  eventId: overrides.eventId ?? randomUUID(),
  orderId: overrides.orderId ?? randomUUID(),
  idempotencyKey:
    overrides.idempotencyKey ??
    `ticket-attribution:v1:${randomUUID()}:${randomUUID()}`,
  attributedToEventHumanId: overrides.attributedToEventHumanId ?? null,
  attributedToHumanId: overrides.attributedToHumanId ?? null,
  source: overrides.source ?? "NONE",
  trackingConsent: overrides.trackingConsent ?? "UNKNOWN",
  refRaw: overrides.refRaw ?? null,
  refEventHumanId: overrides.refEventHumanId ?? null,
  utmSource: overrides.utmSource ?? null,
  utmMedium: overrides.utmMedium ?? null,
  utmCampaign: overrides.utmCampaign ?? null,
  fanHumanId: overrides.fanHumanId ?? null,
  fanCity: overrides.fanCity ?? null,
  fanState: overrides.fanState ?? null,
  fanCountry: overrides.fanCountry ?? null,
  checkoutArtistSelection: overrides.checkoutArtistSelection ?? null,
  createdAt: overrides.createdAt ?? new Date(),
  updatedAt: overrides.updatedAt ?? new Date(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_ID = randomUUID();
const ORDER_ID = randomUUID();
const BUYER_ID = randomUUID();
const EVENT_HUMAN_ID = randomUUID();
const HUMAN_ID = randomUUID();

function makeTx(overrides: {
  existingAttribution?: TicketAttributionRecord | null;
  eventHumanForRef?: EventHumanRecord | null;
  eventHumanForSelection?: EventHumanRecord | null;
}): TxRepos {
  const {
    existingAttribution = null,
    eventHumanForRef = null,
    eventHumanForSelection = null,
  } = overrides;

  return {
    ticketAttributions: {
      findByIdempotencyKey: vi.fn(async () => existingAttribution),
      create: vi.fn(async (input) => attributionRecordFactory(input as any)),
      findByEventAndOrder: vi.fn(async () => null),
      listByEvent: vi.fn(async () => []),
      listByAttributedHuman: vi.fn(async () => []),
    },
    eventHumans: {
      getById: vi.fn(async (id: string) => {
        if (id === (eventHumanForRef?.id ?? null))
          return eventHumanForRef ?? null;
        if (id === (eventHumanForSelection?.id ?? null))
          return eventHumanForSelection ?? null;
        return null;
      }),
    } as any,
    audit: {
      log: vi.fn(async () => {}),
    } as any,
  } as unknown as TxRepos;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("recordAttribution", () => {
  it("writes REF_LINK attribution when a valid ref is provided", async () => {
    const performer = eventHumanFactory({
      id: EVENT_HUMAN_ID,
      eventId: EVENT_ID,
      humanId: HUMAN_ID,
      role: "PERFORMER",
    });
    const tx = makeTx({ eventHumanForRef: performer });

    await recordAttribution(tx, {
      eventId: EVENT_ID,
      orderId: ORDER_ID,
      buyerHumanId: BUYER_ID,
      ref: EVENT_HUMAN_ID,
      utmSource: "instagram",
      utmMedium: "story",
      utmCampaign: "summer-tour",
    });

    const createCall = vi.mocked(tx.ticketAttributions.create).mock
      .calls[0]![0];
    expect(createCall.source).toBe("REF_LINK");
    expect(createCall.attributedToEventHumanId).toBe(EVENT_HUMAN_ID);
    expect(createCall.attributedToHumanId).toBe(HUMAN_ID);
    expect(createCall.refEventHumanId).toBe(EVENT_HUMAN_ID);
    expect(createCall.utmSource).toBe("instagram");
    expect(createCall.fanHumanId).toBe(BUYER_ID);
  });

  it("writes NONE when ref belongs to a different event", async () => {
    const otherEventId = randomUUID();
    const performer = eventHumanFactory({
      id: EVENT_HUMAN_ID,
      eventId: otherEventId, // different event
      humanId: HUMAN_ID,
      role: "PERFORMER",
    });
    const tx = makeTx({ eventHumanForRef: performer });

    await recordAttribution(tx, {
      eventId: EVENT_ID,
      orderId: ORDER_ID,
      buyerHumanId: BUYER_ID,
      ref: EVENT_HUMAN_ID,
    });

    const createCall = vi.mocked(tx.ticketAttributions.create).mock
      .calls[0]![0];
    expect(createCall.source).toBe("NONE");
    expect(createCall.attributedToEventHumanId).toBeNull();
  });

  it("writes NONE when ref belongs to a non-performer role", async () => {
    const stageHand = eventHumanFactory({
      id: EVENT_HUMAN_ID,
      eventId: EVENT_ID,
      humanId: HUMAN_ID,
      role: "ORGANIZER" as any, // not a performer role
    });
    const tx = makeTx({ eventHumanForRef: stageHand });

    await recordAttribution(tx, {
      eventId: EVENT_ID,
      orderId: ORDER_ID,
      buyerHumanId: BUYER_ID,
      ref: EVENT_HUMAN_ID,
    });

    const createCall = vi.mocked(tx.ticketAttributions.create).mock
      .calls[0]![0];
    expect(createCall.source).toBe("NONE");
    expect(createCall.attributedToEventHumanId).toBeNull();
  });

  it("is idempotent — skips write if attribution already exists for this order", async () => {
    const existing = attributionRecordFactory({
      idempotencyKey: `ticket-attribution:v1:${EVENT_ID}:${ORDER_ID}`,
    });
    const tx = makeTx({ existingAttribution: existing });

    await recordAttribution(tx, {
      eventId: EVENT_ID,
      orderId: ORDER_ID,
      buyerHumanId: BUYER_ID,
    });

    expect(vi.mocked(tx.ticketAttributions.create)).not.toHaveBeenCalled();
    expect(vi.mocked(tx.audit.log)).not.toHaveBeenCalled();
  });

  it("falls back to CHECKOUT_SELECT when no ref but a valid artist selection is provided", async () => {
    const selectionEventHumanId = randomUUID();
    const performer = eventHumanFactory({
      id: selectionEventHumanId,
      eventId: EVENT_ID,
      humanId: HUMAN_ID,
      role: "DJ",
    });
    const tx = makeTx({ eventHumanForSelection: performer });
    // make getById route to the right mock
    vi.mocked(tx.eventHumans.getById).mockImplementation(async (id: string) => {
      if (id === selectionEventHumanId) return performer;
      return null;
    });

    await recordAttribution(tx, {
      eventId: EVENT_ID,
      orderId: ORDER_ID,
      buyerHumanId: BUYER_ID,
      checkoutArtistSelection: selectionEventHumanId,
    });

    const createCall = vi.mocked(tx.ticketAttributions.create).mock
      .calls[0]![0];
    expect(createCall.source).toBe("CHECKOUT_SELECT");
    expect(createCall.attributedToEventHumanId).toBe(selectionEventHumanId);
  });

  it("writes NONE when no ref and selection is a sentinel value (ALL_OF_THEM)", async () => {
    const tx = makeTx({});

    await recordAttribution(tx, {
      eventId: EVENT_ID,
      orderId: ORDER_ID,
      buyerHumanId: BUYER_ID,
      checkoutArtistSelection: "ALL_OF_THEM",
    });

    const createCall = vi.mocked(tx.ticketAttributions.create).mock
      .calls[0]![0];
    expect(createCall.source).toBe("NONE");
    expect(createCall.checkoutArtistSelection).toBe("ALL_OF_THEM");
  });

  it("REF_LINK wins over CHECKOUT_SELECT when both are provided", async () => {
    const refPerformer = eventHumanFactory({
      id: EVENT_HUMAN_ID,
      eventId: EVENT_ID,
      humanId: HUMAN_ID,
      role: "PERFORMER",
    });
    const selectionEventHumanId = randomUUID();
    const selectionPerformer = eventHumanFactory({
      id: selectionEventHumanId,
      eventId: EVENT_ID,
      role: "DJ",
    });

    const tx = makeTx({});
    vi.mocked(tx.eventHumans.getById).mockImplementation(async (id: string) => {
      if (id === EVENT_HUMAN_ID) return refPerformer;
      if (id === selectionEventHumanId) return selectionPerformer;
      return null;
    });

    await recordAttribution(tx, {
      eventId: EVENT_ID,
      orderId: ORDER_ID,
      buyerHumanId: BUYER_ID,
      ref: EVENT_HUMAN_ID,
      checkoutArtistSelection: selectionEventHumanId,
    });

    const createCall = vi.mocked(tx.ticketAttributions.create).mock
      .calls[0]![0];
    expect(createCall.source).toBe("REF_LINK");
    expect(createCall.attributedToEventHumanId).toBe(EVENT_HUMAN_ID);
    // selection is still stored as metadata but didn't drive attribution
    expect(createCall.checkoutArtistSelection).toBe(selectionEventHumanId);
  });
});
