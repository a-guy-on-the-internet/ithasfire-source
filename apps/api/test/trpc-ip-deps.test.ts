import { describe, expect, it } from "vitest";

import { trpcClientIpDepsFromEnv } from "../src/lib/trpc-ip-deps";

/**
 * `buildDeps()` needs Prisma, Redis and Stripe, so its tRPC client-IP wiring
 * is tested through the pure mapping it spreads in (lib/dep.ts).
 */
describe("trpcClientIpDepsFromEnv", () => {
  const SECRET = "s".repeat(32);

  it("passes ORIGIN_SHARED_SECRET through as the forward secret", () => {
    expect(
      trpcClientIpDepsFromEnv({ ORIGIN_SHARED_SECRET: SECRET })
        .clientIpForwardSecret,
    ).toBe(SECRET);
  });

  it("trims the secret, as both signer and verifier do", () => {
    expect(
      trpcClientIpDepsFromEnv({ ORIGIN_SHARED_SECRET: `  ${SECRET}\n` })
        .clientIpForwardSecret,
    ).toBe(SECRET);
  });

  it.each([undefined, null, "", "   "])(
    "is null when the secret is %j (forwards ignored)",
    (value) => {
      expect(
        trpcClientIpDepsFromEnv({ ORIGIN_SHARED_SECRET: value })
          .clientIpForwardSecret,
      ).toBeNull();
    },
  );

  it("defaults the global rate-limit mode to shadow", () => {
    expect(trpcClientIpDepsFromEnv({}).globalRateLimitMode).toBe("shadow");
    expect(
      trpcClientIpDepsFromEnv({ TRPC_GLOBAL_RATE_LIMIT_MODE: null })
        .globalRateLimitMode,
    ).toBe("shadow");
  });

  it.each(["enforce", "shadow", "off"] as const)(
    "passes an explicit mode %s through",
    (mode) => {
      expect(
        trpcClientIpDepsFromEnv({ TRPC_GLOBAL_RATE_LIMIT_MODE: mode })
          .globalRateLimitMode,
      ).toBe(mode);
    },
  );

  it("returns exactly the two TrpcDeps fields dep.ts spreads", () => {
    expect(
      Object.keys(
        trpcClientIpDepsFromEnv({
          ORIGIN_SHARED_SECRET: SECRET,
          TRPC_GLOBAL_RATE_LIMIT_MODE: "enforce",
        }),
      ).sort(),
    ).toEqual(["clientIpForwardSecret", "globalRateLimitMode"]);
  });
});
