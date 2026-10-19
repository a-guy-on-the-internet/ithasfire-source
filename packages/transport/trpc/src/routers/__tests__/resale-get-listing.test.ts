import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { resaleRouter } from "../resale";
import { createCaller } from "./test-helpers";

/**
 * `resale.getListing` backs the direct listing link, which is how a holder
 * passes a ticket on. Owner ruling 2026-10-13 ("Link works"): the event's
 * PASSWORD / APPLICATION gate does not apply. What the use case does enforce
 * (on-sale status, an event checkout sells for, no seller or ticket id) needs
 * the viewer, which must come from the SESSION: a client cannot name itself
 * the seller.
 *
 * Through the REAL router and use case; only the repos and `authn` are fakes.
 */

const LISTING_ID = "90000000-0000-4000-8000-000000000009";
const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const SELLER_ID = "11111111-1111-4111-8111-111111111111";
const TICKET_ID = "91000000-0000-4000-8000-000000000009";
const BUYER_ID = "22222222-2222-4222-8222-222222222222";
const BUYER_ORDER_ID = "92000000-0000-4000-8000-000000000009";

const buildRepos = (status: "ACTIVE" | "CANCELLED" | "SOLD") => {
  const listing = {
    id: LISTING_ID,
    ticketId: TICKET_ID,
    eventId: EVENT_ID,
    sellerHumanId: SELLER_ID,
    askPriceCents: 4500,
    processingPassThroughCents: 0,
    faceValueCents: 4000,
    currency: "usd",
    status,
    expiresAt: null,
    source: "internal",
    buyerOrderId: status === "SOLD" ? BUYER_ORDER_ID : null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
  };
  const event = {
    id: EVENT_ID,
    title: "Members night",
    slug: "members-night",
    startsAt: new Date("2026-11-01T02:00:00.000Z"),
    locationLabel: null,
    status: "PUBLISHED",
    publishedAt: new Date("2026-10-01T00:00:00.000Z"),
    ownerBanned: false,
    // Gated: the link still works (owner ruling 2026-10-13).
    gateType: "APPLICATION",
  };
  const repos = {
    resaleListings: { getById: vi.fn(async () => listing) },
    events: { getById: vi.fn(async () => event) },
    tickets: { getById: vi.fn(async () => null) },
    orders: {
      getById: vi.fn(async (id: string) =>
        id === BUYER_ORDER_ID ? { id, buyerHumanId: BUYER_ID } : null,
      ),
    },
  };
  return repos as unknown as Ctx["repos"];
};

const anonymous = (repos: Ctx["repos"]) => ({
  repos,
  actorHumanId: null,
  auth: null,
  authToken: null,
  cookieHeader: null,
});

const signedIn = (repos: Ctx["repos"], humanId: string) => ({
  repos,
  actorHumanId: null,
  auth: null,
  authToken: "session-token",
  authn: {
    getProviderUserId: vi.fn(async () => ({
      providerUserId: "provider-user-1",
      sessionId: undefined,
    })),
    ensureAuthedHuman: vi.fn(async () => ({ humanId })),
  } as unknown as Ctx["authn"],
  cookieHeader: null,
});

describe("resale.getListing", () => {
  it("an anonymous viewer reads an ACTIVE listing of a gated event, without the seller's or ticket's id", async () => {
    const { caller } = createCaller(resaleRouter, anonymous(buildRepos("ACTIVE")));

    const result = await caller.getListing({ listingId: LISTING_ID });

    expect(result).toMatchObject({
      id: LISTING_ID,
      status: "ACTIVE",
      isOwnListing: false,
    });
    expect(JSON.stringify(result)).not.toContain(SELLER_ID);
    expect(JSON.stringify(result)).not.toContain(TICKET_ID);
  });

  it("a client cannot name itself the seller: a viewerHumanId in the request is ignored", async () => {
    const { caller } = createCaller(
      resaleRouter,
      anonymous(buildRepos("CANCELLED")),
    );

    await expect(
      caller.getListing({
        listingId: LISTING_ID,
        viewerHumanId: SELLER_ID,
      } as never),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the signed-in seller reads their own CANCELLED listing", async () => {
    const { caller } = createCaller(
      resaleRouter,
      signedIn(buildRepos("CANCELLED"), SELLER_ID),
    );

    await expect(
      caller.getListing({ listingId: LISTING_ID }),
    ).resolves.toMatchObject({ status: "CANCELLED", isOwnListing: true });
  });

  it("the signed-in buyer reads the SOLD listing they bought, through the session", async () => {
    const { caller } = createCaller(
      resaleRouter,
      signedIn(buildRepos("SOLD"), BUYER_ID),
    );

    await expect(
      caller.getListing({ listingId: LISTING_ID }),
    ).resolves.toMatchObject({ status: "SOLD", isOwnListing: false });
  });

  it("a SOLD listing is not found to an anonymous viewer", async () => {
    const { caller } = createCaller(resaleRouter, anonymous(buildRepos("SOLD")));

    await expect(
      caller.getListing({ listingId: LISTING_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
