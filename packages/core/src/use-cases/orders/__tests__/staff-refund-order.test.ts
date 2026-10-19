import { describe, expect, it, vi } from "vitest";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import { staffRefundOrder } from "../staff-refund-order";

describe("staffRefundOrder", () => {
  it("forbids non-staff actors", async () => {
    await expect(
      staffRefundOrder(
        {
          repos: {
            tx: vi.fn(async (fn) => fn({ audit: { log: vi.fn() } })),
          } as any,
          payments: {} as any,
          idempotency: createFakeIdempotencyPort(),
          clock: {
            now: vi.fn(() => new Date("2024-01-01T00:00:00.000Z")),
          } as any,
          authz: {
            hasStaffRole: vi.fn(async () => ({ allowed: false })),
          } as any,
          logger: undefined,
        },
        {
          actorHumanId: crypto.randomUUID(),
          orderId: crypto.randomUUID(),
          note: "needed for support ticket #123",
        },
      ),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("delegates to refundFullOrder and adds a refund_note audit log", async () => {
    const auditLog = vi.fn();
    const tx = vi.fn(async (fn: any) => fn({ audit: { log: auditLog } }));

    // We stub the heavy lifting by mocking the module import boundary.
    const refundFullOrderModule = await import("../refund-full-order");
    const spy = vi
      .spyOn(refundFullOrderModule, "refundFullOrder")
      .mockResolvedValue({
        ok: true,
        orderId: "00000000-0000-0000-0000-000000000000",
        refundId: "re_123",
        currency: "usd",
        amountPaidCents: 1000,
        stripeFeeCents: 59,
        refundedCents: 941,
        refundedItems: [
          {
            orderItemId: "11111111-1111-4111-8111-111111111111",
            refundedCents: 941,
          },
        ],
        skippedItems: [],
        newOrderStatus: "REFUNDED",
      });

    const out = await staffRefundOrder(
      {
        repos: { tx } as any,
        payments: {} as any,
        idempotency: createFakeIdempotencyPort(),
        clock: {
          now: vi.fn(() => new Date("2024-01-01T00:00:00.000Z")),
        } as any,
        authz: { hasStaffRole: vi.fn(async () => ({ allowed: true })) } as any,
        logger: undefined,
      },
      {
        actorHumanId: crypto.randomUUID(),
        orderId: "00000000-0000-0000-0000-000000000000",
        note: "manual refund test",
      },
    );

    expect(out.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    // Staff wrapper should pass _skipBuyerCheck so it doesn't fail on ownership
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ _skipBuyerCheck: true }),
      expect.any(Object),
    );

    expect(tx).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "order",
        entityId: "00000000-0000-0000-0000-000000000000",
        action: "refund_note",
        data: { note: "manual refund test" },
      }),
    );
  });

  it("forwards notify into refundFullOrder (single notify source — no double-fire)", async () => {
    // staffRefundOrder delegates the actual refund (and the buyer
    // order.refund-processed notification) to refundFullOrder. It must forward
    // its notify dispatcher to that delegate and NOT fire a second notify of
    // its own, so the buyer gets exactly one in-app refund confirmation.
    const auditLog = vi.fn();
    const tx = vi.fn(async (fn: any) => fn({ audit: { log: auditLog } }));
    const notify = vi.fn(async () => ({}) as never);

    const refundFullOrderModule = await import("../refund-full-order");
    const spy = vi
      .spyOn(refundFullOrderModule, "refundFullOrder")
      .mockResolvedValue({
        ok: true,
        orderId: "00000000-0000-0000-0000-000000000000",
        refundId: "re_456",
        currency: "usd",
        amountPaidCents: 1000,
        stripeFeeCents: 59,
        refundedCents: 941,
        refundedItems: [
          {
            orderItemId: "11111111-1111-4111-8111-111111111111",
            refundedCents: 941,
          },
        ],
        skippedItems: [],
        newOrderStatus: "REFUNDED",
      });

    await staffRefundOrder(
      {
        repos: { tx } as any,
        payments: {} as any,
        idempotency: createFakeIdempotencyPort(),
        clock: {
          now: vi.fn(() => new Date("2024-01-01T00:00:00.000Z")),
        } as any,
        authz: { hasStaffRole: vi.fn(async () => ({ allowed: true })) } as any,
        logger: undefined,
        notify,
      },
      {
        actorHumanId: crypto.randomUUID(),
        orderId: "00000000-0000-0000-0000-000000000000",
        note: "manual refund test",
      },
    );

    // The notify dispatcher is threaded into the delegated refundFullOrder.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ notify, _skipBuyerCheck: true }),
      expect.any(Object),
    );

    // staffRefundOrder itself never fires notify directly — refundFullOrder is
    // the single source (mocked here), so it can't double-notify the buyer.
    expect(notify).not.toHaveBeenCalled();
  });
});
