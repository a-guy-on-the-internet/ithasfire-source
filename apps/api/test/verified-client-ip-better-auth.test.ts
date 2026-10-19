import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import {
  VERIFIED_CLIENT_IP_HEADER,
  signClientIpForward,
} from "@th/trpc/client-ip";

/**
 * Better Auth's OWN rate limiter, for real, behind the real Fastify mount and
 * the real verified-client-ip hook: two visitors whose IPs our web server
 * signed land in DIFFERENT buckets even though both requests come from the
 * web server's address, and a forged stamp cannot shard the bucket.
 *
 * `auth/better-auth.ts` itself cannot be imported here (it boots env, Prisma
 * and Redis at module load), so the instance below is a minimal real
 * `betterAuth()` with the SAME `ipAddressHeaders` list, and the last case pins
 * that better-auth.ts still passes that list.
 */

const SECRET = "o".repeat(40);

vi.mock("../src/lib/env", () => ({
  env: { ORIGIN_SHARED_SECRET: "o".repeat(40) },
}));
vi.mock("../src/instrument", () => ({
  Sentry: { captureException: vi.fn() },
}));

vi.mock("../src/auth/better-auth", async () => {
  const { betterAuth } = await import("better-auth");
  const { memoryAdapter } = await import("better-auth/adapters/memory");
  const { TRUSTED_CLIENT_IP_HEADER_PRECEDENCE } = await import(
    "@th/trpc/client-ip"
  );
  return {
    auth: betterAuth({
      baseURL: "http://localhost",
      secret: "test-secret-test-secret-test-secret-32",
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      rateLimit: {
        enabled: true,
        storage: "memory",
        window: 60,
        max: 100,
        // One request per minute per IP on `/ok`, so the second request from
        // the same bucket is a 429.
        customRules: { "/ok": { window: 60, max: 1 } },
      },
      advanced: {
        ipAddress: {
          ipAddressHeaders: [...TRUSTED_CLIENT_IP_HEADER_PRECEDENCE],
        },
      },
    }),
  };
});

/** Every request "comes from" the web server, as SSR auth calls do. */
const WEB_SERVER_IP = "203.0.113.200";

const signed = (ip: string) =>
  signClientIpForward({
    ip,
    secret: SECRET,
    nowSeconds: Math.floor(Date.now() / 1000),
  });

describe("Better Auth limiter keys on the verified visitor IP", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const { default: verifiedClientIp } = await import(
      "../src/plugins/verified-client-ip"
    );
    const { default: betterAuthMount } = await import(
      "../src/plugins/better-auth"
    );
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    app = Fastify({ logger: false });
    app.decorate("deps", { logger } as never);
    await app.register(verifiedClientIp as never);
    await app.register(betterAuthMount as never);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const hit = async (headers: Record<string, string>) =>
    (
      await app.inject({
        method: "GET",
        url: "/api/auth/ok",
        headers: { "cf-connecting-ip": WEB_SERVER_IP, ...headers },
      })
    ).statusCode;

  // The limiter's memory store is module-global, so every case uses its own
  // addresses.
  it("two signed visitors get separate buckets", async () => {
    expect(await hit(signed("198.51.100.1"))).toBe(200);
    expect(await hit(signed("198.51.100.2"))).toBe(200);
    expect(await hit(signed("198.51.100.1"))).toBe(429);
    expect(await hit(signed("198.51.100.2"))).toBe(429);
  });

  it("a forged stamp is stripped: forgers share the web server's bucket", async () => {
    const shared = "203.0.113.201";
    expect(
      await hit({
        "cf-connecting-ip": shared,
        [VERIFIED_CLIENT_IP_HEADER]: "198.51.100.11",
      }),
    ).toBe(200);
    expect(
      await hit({
        "cf-connecting-ip": shared,
        [VERIFIED_CLIENT_IP_HEADER]: "198.51.100.12",
      }),
    ).toBe(429);
  });

  it("better-auth.ts passes the same trusted header list", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/auth/better-auth.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain(
      "ipAddressHeaders: [...TRUSTED_CLIENT_IP_HEADER_PRECEDENCE]",
    );
  });
});
