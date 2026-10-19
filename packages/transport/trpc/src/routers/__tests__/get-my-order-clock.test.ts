import { beforeEach, describe, expect, it, vi } from "vitest";

import * as getMyOrderModule from "@th/core/use-cases/orders/get-my-order";

import { ordersRouter } from "../orders";
import { createCaller } from "./test-helpers";

// `getMyOrder.eventEnded` is what hides "Transfer" on a past event. `clock` is
// optional on its deps, so dropping it from the router still typechecks and the
// use case silently falls back to the wall clock. This pins the wiring.
describe("ordersRouter.getMyOrder", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the request clock to getMyOrder", async () => {
    const spy = vi
      .spyOn(getMyOrderModule, "getMyOrder")
      .mockRejectedValue({ code: "not_found", message: "nope" });

    // A verified actor: getMyOrder sits behind the B2 verified-email gate.
    const { caller, ctx } = createCaller(ordersRouter, {
      repos: {
        humans: {
          getByIdWithIdentity: vi.fn(async () => ({
            identity: { emailVerified: true },
          })),
        },
      } as any,
    });

    await expect(
      caller.getMyOrder({ orderId: "33333333-3333-4333-8333-333333333333" }),
    ).rejects.toBeDefined();

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ clock: ctx.clock }),
      expect.anything(),
    );
  });
});
