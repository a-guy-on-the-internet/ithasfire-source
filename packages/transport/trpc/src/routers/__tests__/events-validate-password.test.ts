import { beforeEach, describe, expect, it, vi } from "vitest";

import * as eventsUseCases from "@th/core/use-cases/events";
import { hashEventPassword } from "@th/core/lib/security/event-password";
import { createInMemoryRateLimit } from "@th/test-utils/fakes/rate-limit";

import type { Ctx } from "../../context";
import { t } from "../../trpc";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

/**
 * `events.validatePassword` through the REAL router: the server injects the
 * client IP, the Turnstile token passes through, the failure gate's code
 * reaches the wire, and the hard caps bucket IPv6 on its /64.
 */

const EVENT_ID = "44444444-4444-4444-8444-444444444444";
const RIGHT = "right-pass";

/** Run the real errorFormatter so we read `data.appCode` as a client would. */
function wireData(error: unknown) {
  const format = t._config.errorFormatter as unknown as (opts: {
    shape: unknown;
    error: unknown;
  }) => { data: Record<string, unknown> };
  return format({
    shape: {
      message: "x",
      code: -32600,
      data: { code: "FORBIDDEN", httpStatus: 403 },
    },
    error,
  }).data;
}

const buildRepos = () =>
  ({
    events: {
      getById: vi.fn(async (id: string) =>
        id === EVENT_ID
          ? {
              id: EVENT_ID,
              orgId: "org-1",
              humanId: null,
              gateType: "PASSWORD",
              visibility: "PRIVATE",
              status: "PUBLISHED",
              publishedAt: new Date("2025-12-01T00:00:00.000Z"),
              passwordHash: hashEventPassword(RIGHT),
            }
          : null,
      ),
    },
    authz: { getOrgMembership: vi.fn(async () => null) },
    eventUnlocks: { upsert: vi.fn() },
  }) as unknown as Ctx["repos"];

describe("events.validatePassword failure gate (router)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("injects requestIp from ctx.clientIp and passes the Turnstile token and gate deps through", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "validateEventPassword")
      .mockResolvedValue({
        eventId: EVENT_ID,
        unlocked: true,
        bypassed: false,
        persisted: false,
      });
    const turnstile = { enabled: true, verify: vi.fn() };
    const reportError = vi.fn();

    const { caller, ctx } = createCaller(eventsRouter, {
      clientIp: "198.51.100.10",
      actorHumanId: null,
      turnstile: turnstile as unknown as Ctx["turnstile"],
      reportError,
    });

    await caller.validatePassword({
      eventId: EVENT_ID,
      password: RIGHT,
      turnstileToken: "tt-token",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [deps, input] = spy.mock.calls[0]!;
    expect(input).toEqual({
      eventId: EVENT_ID,
      password: RIGHT,
      turnstileToken: "tt-token",
      viewerHumanId: null,
      requestIp: "198.51.100.10",
    });
    expect(deps).toMatchObject({
      attemptCounter: ctx.rateLimit,
      turnstile,
      reportError,
    });
  });

  it("refuses a client-supplied requestIp (server-injected only)", async () => {
    const spy = vi.spyOn(eventsUseCases, "validateEventPassword");
    const { caller } = createCaller(eventsRouter, { actorHumanId: null });

    await expect(
      caller.validatePassword({
        eventId: EVENT_ID,
        password: RIGHT,
        requestIp: "1.1.1.1",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns FORBIDDEN / EVENT_PASSWORD_CHALLENGE_REQUIRED after 3 failures, and a verified token gets through", async () => {
    const rateLimit = createInMemoryRateLimit();
    const verify = vi.fn(async (token: string) => token === "good");
    const { caller } = createCaller(eventsRouter, {
      repos: buildRepos(),
      clientIp: "203.0.113.9",
      actorHumanId: null,
      rateLimit: rateLimit as unknown as Ctx["rateLimit"],
      turnstile: { enabled: true, verify } as unknown as Ctx["turnstile"],
    });

    for (let i = 0; i < 3; i += 1) {
      const err = await caller
        .validatePassword({ eventId: EVENT_ID, password: "nope" })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "BAD_REQUEST" });
      expect(wireData(err).appCode).toBe("EVENT_PASSWORD_INVALID");
    }

    const err = await caller
      .validatePassword({ eventId: EVENT_ID, password: RIGHT })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "FORBIDDEN" });
    expect(wireData(err).appCode).toBe("EVENT_PASSWORD_CHALLENGE_REQUIRED");

    await expect(
      caller.validatePassword({
        eventId: EVENT_ID,
        password: RIGHT,
        turnstileToken: "good",
      }),
    ).resolves.toMatchObject({ unlocked: true });
    // Turnstile's remoteip is the server-observed client IP.
    expect(verify).toHaveBeenCalledWith("good", "203.0.113.9");
  });

  it("buckets IPv6 on its /64 in the hard-cap keys; IPv4 keys are unchanged", async () => {
    vi.spyOn(eventsUseCases, "validateEventPassword").mockResolvedValue({
      eventId: EVENT_ID,
      unlocked: true,
      bypassed: false,
      persisted: false,
    });
    const keysFor = async (clientIp: string) => {
      const rateLimit = createInMemoryRateLimit();
      const { caller } = createCaller(eventsRouter, {
        clientIp,
        actorHumanId: null,
        rateLimit: rateLimit as unknown as Ctx["rateLimit"],
      });
      await caller.validatePassword({ eventId: EVENT_ID, password: RIGHT });
      return rateLimit
        .keys()
        .filter((k) => k.startsWith("event:validatePassword:"));
    };

    expect(await keysFor("2001:db8:1:2::5")).toEqual([
      `event:validatePassword:${EVENT_ID}:anonymous:ip:2001:0db8:0001:0002::/64`,
      "event:validatePassword:ip:2001:0db8:0001:0002::/64",
    ]);
    expect(await keysFor("198.51.100.10")).toEqual([
      `event:validatePassword:${EVENT_ID}:anonymous:ip:198.51.100.10`,
      "event:validatePassword:ip:198.51.100.10",
    ]);
  });
});
