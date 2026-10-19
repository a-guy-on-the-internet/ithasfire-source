import { describe, expect, it, vi } from "vitest";

import { createFakeBookingRequestActs } from "@th/test-utils/fakes/booking-request-acts";

import type { Ctx } from "../../context";
import { eventHumansRouter } from "../event-humans";
import { createCaller } from "./test-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// eventHumans.bookingSuggestions (lineup-booking-requests v2, FR-006): tagged
// acts on the originating booking's bill not yet on the event's lineup.
// ─────────────────────────────────────────────────────────────────────────────

const EDITOR_ID = "30303030-3030-4303-8303-303030303030";
const OUTSIDER_ID = "31313131-3131-4313-8313-313131313131";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const AGREEMENT_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const PENDING_ID = "32323232-3232-4323-8323-323232323232";
const DECLINED_ID = "34343434-3434-4343-8343-343434343434";

async function buildRepos() {
  const acts = createFakeBookingRequestActs();
  await acts.addActs(REQUEST_ID, [
    { source: "TAGGED", actOwnerType: "human", actOwnerId: PENDING_ID, sortOrder: 0 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: DECLINED_ID, sortOrder: 1 },
  ]);
  await acts.setActConfirmation({
    bookingRequestId: REQUEST_ID,
    actOwnerType: "human",
    actOwnerId: DECLINED_ID,
    expectedFrom: "PENDING",
    to: "DECLINED",
    respondedAt: new Date("2026-06-05T00:00:00.000Z"),
  });
  const agreements = {
    findByLinkedEventId: vi.fn(async () => ({ id: AGREEMENT_ID })),
  };
  return {
    agreements,
    repos: {
      events: {
        getById: vi.fn(async (id: string) =>
          id === EVENT_ID
            ? { id, orgId: ORG_ID, humanId: null, stewardship: "OWNED" }
            : null,
        ),
      },
      eventHumans: { listByEvent: vi.fn(async () => []) },
      agreements,
      bookingRequests: {
        findByAgreementId: vi.fn(async () => ({
          id: REQUEST_ID,
          direction: "TO_VENUE",
        })),
        listActsForRequests: acts.listActsForRequests,
      },
      humans: {
        getByIds: vi.fn(async (ids: string[]) =>
          ids.map((id) => ({ id, name: "Pending Pat", status: "ACTIVE" })),
        ),
      },
      organizations: { getByIds: vi.fn(async () => []) },
      entityPages: { getByOwners: vi.fn(async () => []) },
      authz: {
        getOrgMembership: vi.fn(async ({ humanId }: { humanId: string }) =>
          humanId === EDITOR_ID ? { orgId: ORG_ID, humanId, role: "ADMIN" } : null,
        ),
      },
    } as unknown as Ctx["repos"],
  };
}

describe("eventHumansRouter.bookingSuggestions (lineup v2, FR-006)", () => {
  it("an editor sees the pending tagged act — never the declined one — and the output parses", async () => {
    const { repos } = await buildRepos();
    const { caller } = createCaller(eventHumansRouter, {
      repos,
      actorHumanId: EDITOR_ID,
    });

    const result = await caller.bookingSuggestions({ eventId: EVENT_ID });

    expect(result).toEqual({
      bookingRequestId: REQUEST_ID,
      suggestions: [
        expect.objectContaining({
          humanId: PENDING_ID,
          displayName: "Pending Pat",
          confirmation: "PENDING",
          href: null,
        }),
      ],
    });
  });

  it("a non-member is FORBIDDEN before any booking read", async () => {
    const { repos, agreements } = await buildRepos();
    const { caller } = createCaller(eventHumansRouter, {
      repos,
      actorHumanId: OUTSIDER_ID,
    });

    await expect(
      caller.bookingSuggestions({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(agreements.findByLinkedEventId).not.toHaveBeenCalled();
  });

  it("strict input: the actor is never client-supplied", async () => {
    const { repos } = await buildRepos();
    const { caller } = createCaller(eventHumansRouter, {
      repos,
      actorHumanId: OUTSIDER_ID,
    });
    await expect(
      caller.bookingSuggestions({ eventId: EVENT_ID, actorHumanId: EDITOR_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
