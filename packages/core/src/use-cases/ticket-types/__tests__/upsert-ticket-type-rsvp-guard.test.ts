import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { upsertTicketType } from "../upsert-ticket-type";
import type { UpsertTicketTypeDeps } from "../upsert-ticket-type";

// FR-003 (community-managed-event-listings): RSVP events never carry ticket
// types — creation is rejected before authz/pricing work.

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const TICKET_TYPE_ID = "33333333-3333-4333-8333-333333333333";

const NOW = new Date("2026-07-01T12:00:00.000Z");

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    // Human-owned so the authz path is the simple owner equality check.
    orgId: null,
    humanId: ACTOR_ID,
    status: "DRAFT",
    timezone: "America/Chicago",
    ...overrides,
  });
}

function makeDeps(event: EventRecord): {
  deps: UpsertTicketTypeDeps;
  createTicketType: ReturnType<typeof vi.fn>;
} {
  const createTicketType = vi.fn(async (input: Record<string, unknown>) => ({
    id: TICKET_TYPE_ID,
    eventId: EVENT_ID,
    name: input.name as string,
    priceCents: input.priceCents as number,
    capacity: input.capacity as number,
    status: input.status as "DRAFT" | "ACTIVE",
  }));

  const txRepos = {
    events: {
      getById: vi.fn(async (id: string) => (id === event.id ? event : null)),
      // Sales lock read (ticket-sales-lock): no sales on this event.
      getPopularityStats: vi.fn(async () => []),
    },
    tickets: {
      findTicketTypeByName: vi.fn(async () => null),
      createTicketType,
    },
    audit: {
      log: vi.fn(async () => {}),
    },
  } as unknown as TxRepos;

  return {
    deps: {
      repos: {
        tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
      } as unknown as Repos,
      idempotency: createFakeIdempotencyPort(),
      clock: { now: () => NOW },
    },
    createTicketType,
  };
}

function makeInput() {
  return {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    name: "General Admission",
    priceCents: 0,
    capacity: 50,
    clientKey: "client-key-12345",
  };
}

describe("upsertTicketType RSVP guard", () => {
  it("rejects ticket-type creation against an RSVP event with EVENT_NOT_TICKETED", async () => {
    const { deps, createTicketType } = makeDeps(
      makeEvent({ attendanceMode: "RSVP" }),
    );

    await expect(upsertTicketType(deps, makeInput())).rejects.toMatchObject({
      code: "EVENT_NOT_TICKETED",
    });
    expect(createTicketType).not.toHaveBeenCalled();
  });

  it("creates a ticket type on a TICKETED event unaffected", async () => {
    const { deps, createTicketType } = makeDeps(
      makeEvent({ attendanceMode: "TICKETED" }),
    );

    const result = await upsertTicketType(deps, makeInput());
    expect(result.ticketTypeId).toBe(TICKET_TYPE_ID);
    expect(result.status).toBe("DRAFT");
    expect(createTicketType).toHaveBeenCalledTimes(1);
  });
});
