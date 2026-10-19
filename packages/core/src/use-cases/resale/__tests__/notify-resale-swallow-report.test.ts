import { describe, expect, it, vi } from "vitest";

import type { MailerPort } from "@th/ports/comms/mailer";
import type { Repos } from "@th/ports/repos";
import type { CreateNotificationInput } from "@th/ports/repos/notifications";

import {
  notifyClaimOpened,
  notifyClaimResolved,
  notifyListingCreated,
} from "../notify-resale-events";
import { notifyResaleSellerSold } from "../notify-resale-seller-sold";

// The resale producers swallow every failure (fire-and-forget). A swallowed
// failure also drops the email, so it must reach Sentry through
// `reportError`, never only `logger.warn` (CLAUDE.md, Error Reporting).

const SELLER_ID = "seller-uuid";
const BUYER_ID = "buyer-uuid";
const EVENT_ID = "event-uuid";
const LISTING_ID = "listing-uuid";
const ORDER_ID = "order-uuid";
const CLAIM_ID = "claim-uuid";
const APP = "https://ithasfire.com/";

function setup(opts: { eventTitle?: string; createError?: Error; mailError?: Error } = {}) {
  const create = vi.fn(async (_input: CreateNotificationInput) => {
    if (opts.createError) throw opts.createError;
    return { id: "notif-1", createdAt: new Date("2026-03-10T12:00:00Z") };
  });
  const send = vi.fn(async (_m: unknown) => {
    if (opts.mailError) throw opts.mailError;
    return { result: { id: "m", status: "sent" } };
  });
  const repos = {
    humans: {
      getByIdWithIdentity: vi.fn(async (id: string) => ({
        human: { id, name: "Test Human" },
        identity: { email: `${id}@example.com` },
      })),
    },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        title: opts.eventTitle ?? "Test Concert",
      })),
    },
    resaleListings: {
      getById: vi.fn(async () => ({
        id: LISTING_ID,
        sellerHumanId: SELLER_ID,
        eventId: EVENT_ID,
        askPriceCents: 4250,
        currency: "usd",
      })),
    },
    notifications: { create },
  } as unknown as Repos;
  const reportError = vi.fn();
  const warn = vi.fn();
  const logger = {
    child: () => logger,
    warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const deps = {
    repos,
    mailer: { send } as unknown as MailerPort,
    logger: logger as never,
    reportError,
  };
  return { deps, create, send, reportError, warn };
}

const listingCreated = (d: ReturnType<typeof setup>["deps"]) =>
  notifyListingCreated(d, {
    listingId: LISTING_ID,
    sellerHumanId: SELLER_ID,
    eventId: EVENT_ID,
    askPriceCents: 2500,
    currency: "usd",
    publicAppUrl: APP,
  });
const claimOpened = (d: ReturnType<typeof setup>["deps"]) =>
  notifyClaimOpened(d, {
    claimId: CLAIM_ID,
    respondentId: SELLER_ID,
    eventId: EVENT_ID,
    kind: "entry_denied",
    deadline: "2026-03-13T12:00:00.000Z",
    publicAppUrl: APP,
  });
const claimResolved = (d: ReturnType<typeof setup>["deps"]) =>
  notifyClaimResolved(d, {
    claimId: CLAIM_ID,
    claimantId: BUYER_ID,
    respondentId: SELLER_ID,
    eventId: EVENT_ID,
    status: "denied",
    resolution: null,
    publicAppUrl: APP,
  });
const sellerSold = (d: ReturnType<typeof setup>["deps"]) =>
  notifyResaleSellerSold(d, {
    orderId: ORDER_ID,
    listingId: LISTING_ID,
    publicAppUrl: APP,
  });

const SITES = [
  {
    name: "notifyListingCreated",
    run: listingCreated,
    useCase: "resale.notifyListingCreated",
    extra: { listingId: LISTING_ID },
  },
  {
    name: "notifyClaimOpened",
    run: claimOpened,
    useCase: "resale.notifyClaimOpened",
    extra: { claimId: CLAIM_ID },
  },
  {
    name: "notifyClaimResolved",
    run: claimResolved,
    useCase: "resale.notifyClaimResolved",
    extra: { claimId: CLAIM_ID },
  },
  {
    name: "notifyResaleSellerSold",
    run: sellerSold,
    useCase: "resale.notifyResaleSellerSold",
    extra: { listingId: LISTING_ID },
  },
] as const;

describe.each(SITES)("$name swallow site", ({ run, useCase, extra }) => {
  it("reports a throwing create() and still logs the warning", async () => {
    const boom = new Error("db down");
    const { deps, reportError, warn } = setup({ createError: boom });
    await expect(run(deps)).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase },
      extra,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/\.failed$/),
      expect.objectContaining({ error: "db down" }),
    );
  });

  it("reports a throwing mailer", async () => {
    const boom = new Error("smtp down");
    const { deps, reportError } = setup({ mailError: boom });
    await expect(run(deps)).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase },
      extra,
    });
  });

  it("swallows a throwing reporter", async () => {
    const { deps, reportError } = setup({ createError: new Error("db down") });
    reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    await expect(run(deps)).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("reports nothing when delivery succeeds", async () => {
    const { deps, reportError } = setup();
    await run(deps);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("resale in-app row whose payload cannot be stored", () => {
  it("still writes the English row without a template and reports the skip once", async () => {
    // A title past the stored-payload cap makes the payload `oversized`.
    const eventTitle = "T".repeat(20_000);
    const { deps, create, send, reportError, warn } = setup({ eventTitle });
    await listingCreated(deps);

    expect(create).toHaveBeenCalledTimes(1);
    const row = create.mock.calls[0]![0];
    expect(row.title).toBe("Ticket listed for resale");
    expect(row.body).toBe(`Your ticket for ${eventTitle} is now listed at $25.00.`);
    expect(row.metadata).toEqual({ variant: "resale.listing-created" });
    expect(row.template).toBeNull();
    // The email still goes out.
    expect(send).toHaveBeenCalledTimes(1);

    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = reportError.mock.calls[0]!;
    expect((err as Error).message).toContain("not stored (oversized)");
    expect(ctx).toMatchObject({
      tags: {
        useCase: "resale.notifyListingCreated",
        variant: "resale.listing-created",
        reason: "oversized",
      },
    });
    expect(warn).toHaveBeenCalledWith(
      "comms.direct_in_app.template_skipped",
      expect.objectContaining({ reason: "oversized" }),
    );
  });
});
