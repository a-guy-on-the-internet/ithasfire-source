/**
 * `cancelLegacyResaleListings` (organiser-resale-share FR-015): live listings
 * priced under the removed markup split are cancelled with a notice to the
 * seller to list again. Driven against a small stateful world whose
 * `cancel` has the adapter's ACTIVE → CANCELLED compare-and-swap semantics.
 *
 * The late-webhook side (a payment that lands on an order priced under the
 * markup split) is pinned where finalize lives:
 * finalize-resale-seller-credit.test.ts and resolve-resale-seller-split.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

import type { ResaleListingRecord } from "@th/types/repos/resale-listings";

import { cancelLegacyResaleListings } from "../cancel-legacy-resale-listings";

const ADMIN_ID = "a0000000-0000-4000-8000-000000000001";
const SELLER_A = "b0000000-0000-4000-8000-000000000001";
const SELLER_B = "b0000000-0000-4000-8000-000000000002";
const EVENT_ID = "e0000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-13T12:00:00Z");

const LEGACY_ACTIVE = "10000000-0000-4000-8000-000000000001";
const LEGACY_HELD = "10000000-0000-4000-8000-000000000002";
const LEGACY_ACTIVE_2 = "10000000-0000-4000-8000-000000000003";
const SHARE_ACTIVE = "10000000-0000-4000-8000-000000000004";

function listing(
  id: string,
  overrides: Partial<ResaleListingRecord> = {},
): ResaleListingRecord {
  return {
    id,
    ticketId: `ticket-${id.slice(-1)}`,
    eventId: EVENT_ID,
    sellerHumanId: SELLER_A,
    askPriceCents: 5000,
    faceValueCents: 4000,
    processingPassThroughCents: 175,
    processingFeeConfigRef: "fee-policy-1",
    saleCutoffAt: null,
    payoutReleaseAt: null,
    currency: "usd",
    status: "ACTIVE",
    expiresAt: null,
    source: "internal",
    externalRef: null,
    resalePayoutTermsId: null,
    eventShareCents: null,
    sharePayer: null,
    buyerOrderId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeWorld(opts: {
  listings?: ResaleListingRecord[];
  staff?: { allowed: boolean; secondFactorRequired?: boolean };
  /** Listing ids whose transaction throws. */
  failingTx?: string[];
  /** Flip these to HELD right before their cancel CAS (a buyer got there first). */
  heldBeforeCas?: string[];
  mailThrows?: boolean;
} = {}) {
  const listings = new Map(
    (
      opts.listings ?? [
        listing(LEGACY_ACTIVE),
        listing(LEGACY_HELD, { status: "HELD", sellerHumanId: SELLER_B }),
        listing(SHARE_ACTIVE, { eventShareCents: 500, sharePayer: "SELLER" }),
      ]
    ).map((l) => [l.id, { ...l }]),
  );
  const ticketStatus = new Map<string, string>(
    [...listings.values()].map((l) => [l.ticketId, "LISTED"]),
  );

  const resaleListings = {
    listLiveWithoutShare: vi.fn(
      async ({ limit, afterId }: { limit: number; afterId?: string | null }) =>
        [...listings.values()]
          .filter(
            (l) =>
              (l.status === "ACTIVE" || l.status === "HELD") &&
              l.eventShareCents == null &&
              (!afterId || l.id > afterId),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((l) => ({ ...l })),
    ),
    getById: vi.fn(async (id: string) => {
      const l = listings.get(id);
      return l ? { ...l } : null;
    }),
    cancel: vi.fn(async (id: string, sellerHumanId: string) => {
      const l = listings.get(id)!;
      if (opts.heldBeforeCas?.includes(id)) l.status = "HELD";
      if (l.status !== "ACTIVE" || l.sellerHumanId !== sellerHumanId) {
        return false;
      }
      l.status = "CANCELLED";
      return true;
    }),
  };
  const tickets = {
    getByIdForUpdate: vi.fn(async (id: string) => ({
      id,
      orderItemId: `item-${id}`,
    })),
    getById: vi.fn(async (id: string) => ({ id, orderItemId: `item-${id}` })),
    setStatus: vi.fn(
      async (
        id: string,
        status: string,
        guard: { expectedStatus: string },
      ) => {
        if (ticketStatus.get(id) !== guard.expectedStatus) return false;
        ticketStatus.set(id, status);
        return true;
      },
    ),
  };
  const orderItems = {
    getById: vi.fn(async (id: string) => ({ id, orderId: "purchase-order" })),
    setResaleListingId: vi.fn(async () => {}),
  };
  const orders = {
    getById: vi.fn(async (id: string) => ({ id, source: "PRIMARY" })),
  };
  const audit = { log: vi.fn(async () => {}) };
  const notifications = { create: vi.fn(async () => ({ id: "n-1" })) };
  const events = {
    getById: vi.fn(async () => ({ id: EVENT_ID, title: "Sunset Sessions" })),
  };
  const humans = {
    getByIdWithIdentity: vi.fn(async (id: string) => ({
      human: { id, locale: id === SELLER_B ? "es" : "en" },
      identity: { email: `${id}@example.test` },
    })),
  };

  const txRepos = {
    resaleListings,
    tickets,
    orderItems,
    orders,
    audit,
    notifications,
    events,
  };
  let currentListingId: string | null = null;
  const tx = vi.fn(async (fn: (t: typeof txRepos) => Promise<unknown>) => {
    // Snapshot for rollback, as a real transaction would.
    const listingsBefore = new Map(
      [...listings].map(([k, v]) => [k, { ...v }]),
    );
    const ticketsBefore = new Map(ticketStatus);
    const auditCalls = audit.log.mock.calls.length;
    const noticeCalls = notifications.create.mock.calls.length;
    try {
      const out = await fn(txRepos);
      if (currentListingId && opts.failingTx?.includes(currentListingId)) {
        throw new Error("tx_commit_failed");
      }
      return out;
    } catch (err) {
      listings.clear();
      for (const [k, v] of listingsBefore) listings.set(k, v);
      ticketStatus.clear();
      for (const [k, v] of ticketsBefore) ticketStatus.set(k, v);
      audit.log.mock.calls.length = auditCalls;
      notifications.create.mock.calls.length = noticeCalls;
      throw err;
    }
  });
  // Learn which listing a transaction is for from its first read.
  const getById = resaleListings.getById;
  resaleListings.getById = vi.fn(async (id: string) => {
    currentListingId = id;
    return getById(id);
  });

  const reportError = vi.fn();
  const mailer = {
    send: vi.fn(async () => {
      if (opts.mailThrows) throw new Error("smtp down");
      return { id: "mail-1" };
    }),
  };
  const authz = {
    hasStaffRole: vi.fn(async () => opts.staff ?? { allowed: true }),
  };

  const deps = {
    repos: { ...txRepos, humans, tx } as never,
    authz,
    clock: { now: () => NOW },
    mailer: mailer as never,
    publicAppUrl: "https://ithas.fire/",
    reportError,
  };

  return {
    deps,
    listings,
    ticketStatus,
    resaleListings,
    tickets,
    orderItems,
    audit,
    notifications,
    mailer,
    reportError,
    authz,
    tx,
  };
}

const apply = { actorHumanId: ADMIN_ID, dryRun: false };

describe("cancelLegacyResaleListings", () => {
  it("is platform ADMIN only, and reads nothing for anyone else", async () => {
    const w = makeWorld({ staff: { allowed: false } });

    await expect(cancelLegacyResaleListings(w.deps, apply)).rejects.toMatchObject({
      code: "STAFF_ONLY",
    });
    expect(w.authz.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ADMIN_ID,
      requiredRoles: ["ADMIN"],
    });
    expect(w.resaleListings.listLiveWithoutShare).not.toHaveBeenCalled();
  });

  it("refuses an admin without a second factor", async () => {
    const w = makeWorld({
      staff: { allowed: false, secondFactorRequired: true },
    });
    // Refused either way. The precise code depends on `requirePlatformStaff`:
    // STAFF_ONLY today, SECOND_FACTOR_REQUIRED once it surfaces the reason.
    // The `platformJobs.*` transport gate requires the second factor too.
    await expect(cancelLegacyResaleListings(w.deps, apply)).rejects.toMatchObject({
      code: expect.stringMatching(/^(STAFF_ONLY|SECOND_FACTOR_REQUIRED)$/),
    });
  });

  it("is a dry run by default: reports what it would do and writes nothing", async () => {
    const w = makeWorld();

    const out = await cancelLegacyResaleListings(w.deps, {
      actorHumanId: ADMIN_ID,
    });

    expect(out).toEqual({
      dryRun: true,
      examinedCount: 2,
      cancelledListingIds: [LEGACY_ACTIVE],
      heldListingIds: [LEGACY_HELD],
      changedListingIds: [],
      failedListingIds: [],
      hasMore: false,
    });
    expect(w.tx).not.toHaveBeenCalled();
    expect(w.resaleListings.cancel).not.toHaveBeenCalled();
    expect(w.audit.log).not.toHaveBeenCalled();
    expect(w.notifications.create).not.toHaveBeenCalled();
    expect(w.mailer.send).not.toHaveBeenCalled();
  });

  it("cancels an ACTIVE legacy listing: ticket back to VALID, pointer cleared, audited, seller notified in-app and by email", async () => {
    const w = makeWorld();

    const out = await cancelLegacyResaleListings(w.deps, apply);

    expect(out.cancelledListingIds).toEqual([LEGACY_ACTIVE]);
    expect(w.listings.get(LEGACY_ACTIVE)!.status).toBe("CANCELLED");
    // The same cancel a seller's own cancel runs.
    expect(w.resaleListings.cancel).toHaveBeenCalledWith(LEGACY_ACTIVE, SELLER_A);
    expect(w.tickets.setStatus).toHaveBeenCalledWith("ticket-1", "VALID", {
      expectedStatus: "LISTED",
    });
    expect(w.ticketStatus.get("ticket-1")).toBe("VALID");
    expect(w.orderItems.setResaleListingId).toHaveBeenCalledWith(
      "item-ticket-1",
      null,
    );

    expect(w.audit.log).toHaveBeenCalledTimes(1);
    expect(w.audit.log).toHaveBeenCalledWith({
      entity: "resale_listing",
      entityId: LEGACY_ACTIVE,
      action: "cancelled_markup_split_removed",
      data: {
        ticketId: "ticket-1",
        eventId: EVENT_ID,
        sellerHumanId: SELLER_A,
        actorHumanId: ADMIN_ID,
        askPriceCents: 5000,
        reason: "resale_markup_split_removed",
      },
      at: NOW,
    });

    expect(w.notifications.create).toHaveBeenCalledTimes(1);
    expect(w.notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: SELLER_A,
        title: "Your resale listing was closed",
        body: expect.stringContaining(
          "We closed your listing for Sunset Sessions at $50.00.",
        ),
        metadata: { variant: "resale.listing-closed-relist" },
        action: { label: "List it again", href: "https://ithas.fire/sell/listings/new?orderId=purchase-order" },
        template: expect.objectContaining({
          key: "resale.listing-closed-relist",
          variables: {
            listingId: LEGACY_ACTIVE,
            eventTitle: "Sunset Sessions",
            askPriceCents: 5000,
            currency: "usd",
            resaleUrl: "https://ithas.fire/sell/listings/new?orderId=purchase-order",
          },
        }),
      }),
    );

    expect(w.mailer.send).toHaveBeenCalledTimes(1);
    expect(w.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: { to: `${SELLER_A}@example.test` },
        subject: "Your resale listing for Sunset Sessions was closed",
        text: expect.stringContaining(
          "List it again: https://ithas.fire/sell/listings/new?orderId=purchase-order",
        ),
        idempotencyKey: `resale-listing-closed-relist:${LEGACY_ACTIVE}`,
      }),
    );
    expect(w.reportError).not.toHaveBeenCalled();
  });

  it("emails the seller in their stored language", async () => {
    const w = makeWorld({
      listings: [listing(LEGACY_ACTIVE_2, { sellerHumanId: SELLER_B })],
    });

    await cancelLegacyResaleListings(w.deps, apply);

    expect(w.mailer.send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Cerramos tu anuncio de reventa para Sunset Sessions",
        text: expect.stringMatching(
          /^Cerramos tu anuncio para Sunset Sessions por \$50\.00\.[\s\S]*Publícala de nuevo: https:\/\/ithas\.fire\/sell\/listings\/new\?orderId=purchase-order[\s\S]*Soporte de Ithas Fire$/,
        ),
      }),
    );
  });

  it("never touches a listing priced under the share", async () => {
    const w = makeWorld();
    await cancelLegacyResaleListings(w.deps, apply);
    expect(w.listings.get(SHARE_ACTIVE)!.status).toBe("ACTIVE");
    expect(w.resaleListings.cancel).not.toHaveBeenCalledWith(
      SHARE_ACTIVE,
      expect.anything(),
    );
  });

  it("is idempotent: a second run cancels, audits, notifies and emails nothing more", async () => {
    const w = makeWorld();
    await cancelLegacyResaleListings(w.deps, apply);

    const second = await cancelLegacyResaleListings(w.deps, apply);

    expect(second.cancelledListingIds).toEqual([]);
    expect(second.heldListingIds).toEqual([LEGACY_HELD]);
    expect(w.audit.log).toHaveBeenCalledTimes(1);
    expect(w.notifications.create).toHaveBeenCalledTimes(1);
    expect(w.mailer.send).toHaveBeenCalledTimes(1);
  });

  it("leaves a HELD listing alone: a buyer is mid-checkout with a live PaymentIntent", async () => {
    const w = makeWorld();

    const out = await cancelLegacyResaleListings(w.deps, apply);

    expect(out.heldListingIds).toEqual([LEGACY_HELD]);
    expect(w.listings.get(LEGACY_HELD)!.status).toBe("HELD");
    // Not even attempted: cancelling under a hold would put the ticket back
    // to VALID while the buyer's payment can still land.
    expect(w.resaleListings.cancel).not.toHaveBeenCalledWith(
      LEGACY_HELD,
      expect.anything(),
    );
    expect(w.ticketStatus.get("ticket-2")).toBe("LISTED");
    expect(w.notifications.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ humanId: SELLER_B }),
    );
  });

  it("a listing a buyer holds between the read and the cancel is counted as held, and nothing is written for it", async () => {
    const w = makeWorld({
      listings: [listing(LEGACY_ACTIVE)],
      heldBeforeCas: [LEGACY_ACTIVE],
    });

    const out = await cancelLegacyResaleListings(w.deps, apply);

    expect(out.heldListingIds).toEqual([LEGACY_ACTIVE]);
    expect(out.cancelledListingIds).toEqual([]);
    expect(w.tickets.setStatus).not.toHaveBeenCalled();
    expect(w.audit.log).not.toHaveBeenCalled();
    expect(w.notifications.create).not.toHaveBeenCalled();
    expect(w.mailer.send).not.toHaveBeenCalled();
  });

  it("a cancel that throws is rolled back and reported, and the run carries on", async () => {
    const w = makeWorld({
      listings: [
        listing(LEGACY_ACTIVE),
        listing(LEGACY_ACTIVE_2, { sellerHumanId: SELLER_B }),
      ],
      failingTx: [LEGACY_ACTIVE],
    });

    const out = await cancelLegacyResaleListings(w.deps, apply);

    expect(out.failedListingIds).toEqual([LEGACY_ACTIVE]);
    expect(out.cancelledListingIds).toEqual([LEGACY_ACTIVE_2]);
    expect(w.listings.get(LEGACY_ACTIVE)!.status).toBe("ACTIVE");
    expect(w.ticketStatus.get("ticket-1")).toBe("LISTED");
    expect(w.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "tx_commit_failed" }),
      expect.objectContaining({
        tags: {
          useCase: "resale.cancelLegacyResaleListings",
          reason: "cancel_failed",
        },
        extra: { listingId: LEGACY_ACTIVE, eventId: EVENT_ID },
      }),
    );
    // Only the second seller was told.
    expect(w.mailer.send).toHaveBeenCalledTimes(1);
  });

  it("a failed email is reported; the cancel and the in-app notice stand", async () => {
    const w = makeWorld({ listings: [listing(LEGACY_ACTIVE)], mailThrows: true });

    const out = await cancelLegacyResaleListings(w.deps, apply);

    expect(out.cancelledListingIds).toEqual([LEGACY_ACTIVE]);
    expect(w.listings.get(LEGACY_ACTIVE)!.status).toBe("CANCELLED");
    expect(w.notifications.create).toHaveBeenCalledTimes(1);
    expect(w.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "smtp down" }),
      expect.objectContaining({
        tags: {
          useCase: "resale.cancelLegacyResaleListings",
          reason: "email_failed",
        },
      }),
    );
  });

  it("a throwing reporter never changes the outcome", async () => {
    const w = makeWorld({ listings: [listing(LEGACY_ACTIVE)], mailThrows: true });
    w.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });

    await expect(
      cancelLegacyResaleListings(w.deps, apply),
    ).resolves.toMatchObject({ cancelledListingIds: [LEGACY_ACTIVE] });
  });

  it("refuses unknown input (strict)", async () => {
    const w = makeWorld();
    await expect(
      cancelLegacyResaleListings(w.deps, { ...apply, listingIds: ["x"] }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
