import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

import { registerE2ePublicReadReset } from "../src/routes/e2e/public-read-reset";

async function makeApp() {
  const order: string[] = [];
  const deps = {
    publicReadGeneration: {
      bump: vi.fn(async (reason: string) => {
        order.push(`bump:${reason}`);
      }),
    },
    platformSettingsCache: {
      invalidate: vi.fn(() => {
        order.push("invalidate");
      }),
    },
  };
  const app = Fastify();
  registerE2ePublicReadReset(app, deps);
  app.post("/e2e/reset", async () => ({ ok: true }));
  app.post("/e2e/seed/gated-event", async () => ({ ok: true }));
  app.get("/e2e/orders/:id", async () => ({ ok: true }));
  app.post("/trpc/events.unpublishEvent", async () => ({ ok: true }));
  await app.ready();
  return { app, deps, order };
}

describe("registerE2ePublicReadReset", () => {
  it("POST /e2e/reset and /e2e/seed/* invalidate settings and bump the generation before responding", async () => {
    const { app, deps, order } = await makeApp();

    const reset = await app.inject({ method: "POST", url: "/e2e/reset" });
    expect(reset.statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/e2e/seed/gated-event" });

    expect(deps.platformSettingsCache.invalidate).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      "invalidate",
      "bump:e2e:/e2e/reset",
      "invalidate",
      "bump:e2e:/e2e/seed/gated-event",
    ]);
  });

  it("leaves GETs and non-e2e routes alone", async () => {
    const { app, deps } = await makeApp();
    await app.inject({ method: "GET", url: "/e2e/orders/1" });
    await app.inject({ method: "POST", url: "/trpc/events.unpublishEvent" });
    expect(deps.publicReadGeneration.bump).not.toHaveBeenCalled();
  });
});
