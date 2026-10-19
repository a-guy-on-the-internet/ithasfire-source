/**
 * `sendLegacyRelistNotices`: after a refund commits, a seller whose listing
 * the unwind closed (priced under the removed markup split, FR-015) is told
 * the sale was refunded and how to list again. Never throws.
 */
import { describe, expect, it, vi } from "vitest";

import { sendLegacyRelistNotices } from "../_shared/send-legacy-relist-notices";
import type { LegacyRelistNotice } from "../unwind-resale-order-after-refund";

const NOW = new Date("2026-10-13T12:00:00Z");
const notice: LegacyRelistNotice = {
  sellerHumanId: "66666666-6666-4666-8666-666666666666",
  listingId: "33333333-3333-4333-8333-333333333333",
  eventId: "e0000000-0000-4000-8000-000000000001",
  askPriceCents: 5000,
  currency: "usd",
  sellerOrderId: "77777777-7777-4777-8777-777777777777",
  refundedOrderId: "11111111-1111-4111-8111-111111111111",
};

function makeDeps(opts: { createThrows?: boolean; publicAppUrl?: string | null } = {}) {
  const create = vi.fn(async () => {
    if (opts.createThrows) throw new Error("db down");
    return { id: "n-1" };
  });
  const reportError = vi.fn();
  return {
    deps: {
      repos: {
        events: { getById: vi.fn(async () => ({ title: "Sunset Sessions" })) },
        notifications: { create },
      } as never,
      clock: { now: () => NOW },
      publicAppUrl:
        opts.publicAppUrl === undefined ? "https://ithas.fire/" : opts.publicAppUrl,
      reportError,
    },
    create,
    reportError,
  };
}

describe("sendLegacyRelistNotices", () => {
  it("tells the seller the sale was refunded, the payout will not happen, and links to relisting on their order", async () => {
    const h = makeDeps();

    await sendLegacyRelistNotices(h.deps, [notice]);

    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        humanId: notice.sellerHumanId,
        title: "Your resale was refunded",
        body: expect.stringContaining(
          "Your ticket for Sunset Sessions sold for $50.00, and the buyer has been refunded, so you won't be paid for that sale.",
        ),
        metadata: { variant: "resale.sale-refunded-listing-closed" },
        action: {
          label: "List it again",
          href: `https://ithas.fire/sell/listings/new?orderId=${notice.sellerOrderId}`,
        },
      }),
    );
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("a failed write is reported and never thrown; the next seller is still told", async () => {
    const h = makeDeps({ createThrows: true });

    await expect(
      sendLegacyRelistNotices(h.deps, [notice, { ...notice, listingId: "l-2" }]),
    ).resolves.toBeUndefined();

    expect(h.create).toHaveBeenCalledTimes(2);
    expect(h.reportError).toHaveBeenCalledTimes(2);
    expect(h.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db down" }),
      {
        tags: { useCase: "sendLegacyRelistNotices", reason: "notice_failed" },
        extra: {
          listingId: notice.listingId,
          refundedOrderId: notice.refundedOrderId,
          sellerHumanId: notice.sellerHumanId,
        },
      },
    );
  });

  it("without the app's URL nothing is written, and the untold seller is reported", async () => {
    const h = makeDeps({ publicAppUrl: null });

    await sendLegacyRelistNotices(h.deps, [notice]);

    expect(h.create).not.toHaveBeenCalled();
    expect(h.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "legacy_relist_notice_no_public_app_url" }),
      expect.anything(),
    );
  });

  it("a throwing reporter changes nothing", async () => {
    const h = makeDeps({ createThrows: true });
    h.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    await expect(sendLegacyRelistNotices(h.deps, [notice])).resolves.toBeUndefined();
  });

  it("no notices, no writes", async () => {
    const h = makeDeps();
    await sendLegacyRelistNotices(h.deps, []);
    expect(h.create).not.toHaveBeenCalled();
  });
});
