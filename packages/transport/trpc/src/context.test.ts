import { describe, expect, it } from "vitest";

import type { TrpcDeps } from "./context";
import { createContextFactory } from "./context";
import { createTestLogger } from "@th/test-utils";

const makeDeps = (): TrpcDeps =>
  ({
    logger: createTestLogger(),
  }) as unknown as TrpcDeps;

describe("createContextFactory clientIp", () => {
  it("prefers the real client IP from forwarding headers over the socket peer", async () => {
    const createContext = createContextFactory(makeDeps());

    const ctx = await createContext({
      req: {
        headers: {
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "203.0.113.200, 70.41.3.18",
          "x-real-ip": "203.0.113.201",
        },
        raw: {
          // Behind Cloudflare + Cloud Run this socket peer is Google's internal
          // frontend — identical for every anonymous visitor.
          socket: {
            remoteAddress: "198.51.100.44",
          },
        },
      },
    });

    expect(ctx.clientIp).toBe("203.0.113.7");
  });

  it("falls back to the socket address when no forwarding headers are present", async () => {
    const createContext = createContextFactory(makeDeps());

    const ctx = await createContext({
      req: {
        headers: {},
        raw: {
          socket: {
            remoteAddress: "198.51.100.44",
          },
        },
      },
    });

    expect(ctx.clientIp).toBe("198.51.100.44");
  });
});
