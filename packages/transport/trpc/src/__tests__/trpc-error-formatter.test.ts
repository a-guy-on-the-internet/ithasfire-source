import { describe, expect, it } from "vitest";
import { fail } from "@th/errors";

import { t } from "../trpc";
import { toTrpcError } from "../utils";

/**
 * Guards that the REAL router carries the wire `errorFormatter` — not a
 * reproduction of it.
 *
 * utils.test.ts ("wire errorFormatter") already covers the resolution RULES,
 * but it does so against a local copy of the formatter body, so it stays green
 * even if the formatter is dropped from `initTRPC.create(...)` entirely. That
 * is exactly the failure this file exists to catch: tRPC honours
 * `errorFormatter` ONLY on `initTRPC.create(...)`, and it was previously passed
 * to the Fastify adapter's options, where it was silently ignored and
 * `data.appCode` / `data.meta` never reached the wire (see trpc.ts).
 *
 * `_config` is tRPC-internal, which is the point: there is no public accessor,
 * and asserting through a live procedure would test the whole server stack to
 * check one wiring fact. If a tRPC upgrade moves it, this breaking loudly is
 * the correct outcome — the alternative is the silent regression above.
 */
describe("router errorFormatter wiring", () => {
  const shape = {
    message: "event_not_found",
    code: -32600,
    data: { code: "NOT_FOUND", httpStatus: 404, path: "events.byId" },
  };

  // Via `unknown`: tRPC's ErrorFormatter is generic over Ctx and the fully
  // typed shape, which doesn't structurally overlap this deliberately loose
  // signature. We're probing the wiring, not type-checking tRPC's contract.
  const format = (error: unknown) =>
    (
      t._config.errorFormatter as unknown as (opts: {
        shape: unknown;
        error: unknown;
      }) => { data: Record<string, unknown> }
    )({ shape, error });

  // Weak on its own: tRPC installs a DEFAULT formatter when none is supplied,
  // so this passes either way. It only guards the `_config` shape itself. The
  // appCode assertions below are the actual regression guard — the default
  // formatter returns `shape` untouched and would fail them.
  it("exposes an errorFormatter on the initTRPC config", () => {
    expect(typeof t._config.errorFormatter).toBe("function");
  });

  it("adds appCode/meta to data for a domain error", () => {
    let caught: unknown;
    try {
      fail("EVENT_NOT_FOUND");
    } catch (err) {
      caught = err;
    }

    const { data } = format(caught);

    expect(data.appCode).toBe("EVENT_NOT_FOUND");
    // tRPC's own fields survive untouched.
    expect(data.code).toBe("NOT_FOUND");
    expect(data.httpStatus).toBe(404);
    expect(data.path).toBe("events.byId");
  });

  it("STANDARDS_UNMET's structured items reach data.meta intact (venue-booking-standards FR-006)", () => {
    let caught: unknown;
    try {
      fail("STANDARDS_UNMET", {
        meta: { items: [{ field: "LINK_MUSIC", label: "Send us a music link" }] },
      });
    } catch (err) {
      caught = err;
    }

    const { data } = format(toTrpcError(caught));

    expect(data.appCode).toBe("STANDARDS_UNMET");
    expect(data.meta).toEqual({
      items: [{ field: "LINK_MUSIC", label: "Send us a music link" }],
      appCode: "STANDARDS_UNMET",
    });
  });

  it("EVENT_GATED (embed, gated event) is a FORBIDDEN the widget can recognise by appCode", () => {
    let caught: unknown;
    try {
      fail("EVENT_GATED");
    } catch (err) {
      caught = err;
    }

    const trpcError = toTrpcError(caught);
    expect(trpcError.code).toBe("FORBIDDEN");
    expect(format(trpcError).data.appCode).toBe("EVENT_GATED");
  });

  it("omits appCode/meta entirely for an error with no domain code", () => {
    const { data } = format(new Error("boom"));

    expect(data).not.toHaveProperty("appCode");
    expect(data).not.toHaveProperty("meta");
    expect(data.httpStatus).toBe(404);
  });
});
