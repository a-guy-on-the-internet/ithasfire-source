import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import { publishEvent } from "../publish-event";
import type { PublishEventDeps } from "../publish-event";

// FR-003 (community-managed-event-listings): RSVP events never route through
// publishEvent — COMMUNITY listings are created directly PUBLISHED. The
// fail-fast guard is defense-in-depth so the currency/tax/attestation/ticket
// stamping never has to branch on attendance mode.

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";

const NOW = new Date("2026-07-01T12:00:00.000Z");

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeStubEventRecord({
    id: EVENT_ID,
    // Human-owned so ensureEventAccessible passes without org membership.
    orgId: null,
    humanId: ACTOR_ID,
    status: "DRAFT",
    timezone: "America/Chicago",
    // Left null on purpose: a TICKETED event sails past the RSVP guard and
    // fails on the NEXT gate (EVENT_CATEGORY_MISSING), proving the guard
    // fired first for RSVP and not at all for TICKETED.
    categoryId: null,
    ...overrides,
  });
}

function makeDeps(event: EventRecord): PublishEventDeps {
  const txRepos = {
    events: {
      getById: vi.fn(async (id: string) => (id === event.id ? event : null)),
      // Publish row-locks the event before re-reading it in the tx.
      lockRows: vi.fn(async () => undefined),
    },
  } as unknown as TxRepos;

  return {
    repos: {
      // The root bag answers the pre-transaction read too (the W1 manager
      // probe looks up the event's place before the tx opens).
      ...txRepos,
      tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
    } as unknown as Repos,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => NOW },
    authz: { canManagePlace: vi.fn(async () => ({ allowed: false })) },
  };
}

function makeInput() {
  return {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    clientKey: "client-key-12345",
  };
}

describe("publishEvent RSVP guard", () => {
  it("fails fast with EVENT_NOT_TICKETED for an RSVP event", async () => {
    const deps = makeDeps(makeEvent({ attendanceMode: "RSVP" }));

    await expect(publishEvent(deps, makeInput())).rejects.toMatchObject({
      code: "EVENT_NOT_TICKETED",
    });
  });

  it("does not block a TICKETED event (fails later on EVENT_CATEGORY_MISSING)", async () => {
    const deps = makeDeps(makeEvent({ attendanceMode: "TICKETED" }));

    await expect(publishEvent(deps, makeInput())).rejects.toMatchObject({
      code: "EVENT_CATEGORY_MISSING",
    });
  });

  it("rejects an ALREADY-PUBLISHED RSVP event too (guard precedes the idempotent return)", async () => {
    // Re-publishing an already-PUBLISHED RSVP event must yield
    // EVENT_NOT_TICKETED — never a success-shaped idempotent echo.
    const deps = makeDeps(
      makeEvent({
        attendanceMode: "RSVP",
        status: "PUBLISHED",
        publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );

    await expect(publishEvent(deps, makeInput())).rejects.toMatchObject({
      code: "EVENT_NOT_TICKETED",
    });
  });
});
