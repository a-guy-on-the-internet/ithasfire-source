import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { EventRecord, Repos } from "@th/ports/repos";
import type { TurnstilePort } from "@th/ports/turnstile";
import { createInMemoryRateLimit } from "@th/test-utils/fakes/rate-limit";

import { hashEventPassword } from "../../lib/security/event-password";
import {
  EVENT_PASSWORD_EVENT_FAILURE_BUDGET,
  EVENT_PASSWORD_IP_FAILURE_THRESHOLD,
  eventPasswordFailureKeys,
  validateEventPassword,
} from "./validate-event-password";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const EDITOR_ID = "30000000-0000-4000-8000-000000000003";
const RIGHT = "right-pass";
const WRONG = "wrong-pass";
const GOOD_TOKEN = "good-token";
const BAD_TOKEN = "bad-token";
const IP_A = "203.0.113.7";
const IP_B = "198.51.100.9";

const buildEvent = (overrides: Partial<EventRecord> = {}): EventRecord =>
  ({
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Gated",
    status: "PUBLISHED",
    visibility: "PRIVATE",
    gateType: "PASSWORD",
    locationMode: "EXACT",
    startsAt: new Date("2024-01-01T00:00:00Z"),
    endsAt: new Date("2024-01-01T02:00:00Z"),
    slug: "event",
    shortId: "EVT",
    publishedAt: new Date("2023-12-20T00:00:00Z"),
    passwordHash: hashEventPassword(RIGHT),
    ...overrides,
  }) as EventRecord;

function setup(
  opts: {
    turnstile?: TurnstilePort | null;
    counter?: Pick<RateLimitPort, "peek" | "consumeMany">;
    reportError?: ReporterPort;
  } = {},
) {
  const events = { getById: vi.fn(async () => buildEvent()) };
  const authz = { getOrgMembership: vi.fn(async () => null) };
  const eventUnlocks = { upsert: vi.fn() };
  const repos = { events, authz, eventUnlocks } as unknown as Pick<
    Repos,
    "events" | "authz" | "eventUnlocks"
  >;
  const logger = {
    child: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as LoggerPort & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  const memory = createInMemoryRateLimit();
  const verify = vi.fn(async (token: string) => token === GOOD_TOKEN);
  const turnstile =
    opts.turnstile === undefined
      ? ({ enabled: true, verify } as TurnstilePort)
      : opts.turnstile;
  const reportError = opts.reportError ?? vi.fn();
  const deps = {
    repos,
    authz: { hasStaffRole: async () => ({ allowed: false }) },
    logger,
    attemptCounter: opts.counter ?? memory,
    turnstile,
    reportError,
  };

  const attempt = (
    password: string,
    o: { ip?: string | null; token?: string; viewer?: string | null } = {},
  ) =>
    validateEventPassword(deps, {
      eventId: EVENT_ID,
      password,
      requestIp: o.ip === undefined ? IP_A : o.ip,
      viewerHumanId: o.viewer ?? null,
      ...(o.token !== undefined ? { turnstileToken: o.token } : {}),
    });

  return {
    attempt,
    memory,
    verify,
    reportError: reportError as ReturnType<typeof vi.fn>,
    logger,
    authz,
  };
}

const keysFor = (ip: string | null) => eventPasswordFailureKeys(EVENT_ID, ip);

/** Burn `n` wrong-password attempts from `ip` (each must answer INVALID). */
async function failTimes(
  attempt: ReturnType<typeof setup>["attempt"],
  n: number,
  ip: string,
) {
  for (let i = 0; i < n; i += 1) {
    await expect(attempt(WRONG, { ip })).rejects.toMatchObject({
      code: "EVENT_PASSWORD_INVALID",
    });
  }
}

describe("validateEventPassword failure gate", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it("thresholds are 3 per IP and 100 per event", () => {
    expect(EVENT_PASSWORD_IP_FAILURE_THRESHOLD).toBe(3);
    expect(EVENT_PASSWORD_EVENT_FAILURE_BUDGET).toBe(100);
  });

  it("(a) under the threshold a wrong password is INVALID, unchallenged, and counted", async () => {
    await expect(s.attempt(WRONG)).rejects.toMatchObject({
      code: "EVENT_PASSWORD_INVALID",
    });

    expect(s.memory.count(keysFor(IP_A).ip)).toBe(1);
    expect(s.memory.count(keysFor(IP_A).event)).toBe(1);
    expect(s.verify).not.toHaveBeenCalled();
  });

  it("(b) after 3 failures from one IP the 4th needs a token, and the password is NOT evaluated", async () => {
    await failTimes(s.attempt, 3, IP_A);

    await expect(s.attempt(WRONG)).rejects.toMatchObject({
      code: "EVENT_PASSWORD_CHALLENGE_REQUIRED",
    });
    // Even the RIGHT password is refused without a token: nothing was checked.
    await expect(s.attempt(RIGHT)).rejects.toMatchObject({
      code: "EVENT_PASSWORD_CHALLENGE_REQUIRED",
    });

    // Refused-before-evaluation attempts are not counted as failures.
    expect(s.memory.count(keysFor(IP_A).ip)).toBe(3);
    expect(s.verify).not.toHaveBeenCalled();
    expect(s.logger.info).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({
        result: "challenge_required",
        reason: "token_missing",
      }),
    );
  });

  it("(c) over the threshold a valid token lets the attempt through; an invalid token does not", async () => {
    await failTimes(s.attempt, 3, IP_A);

    await expect(s.attempt(RIGHT, { token: GOOD_TOKEN })).resolves.toMatchObject(
      { unlocked: true, bypassed: false },
    );
    expect(s.verify).toHaveBeenLastCalledWith(GOOD_TOKEN, IP_A);
    expect(s.verify).toHaveBeenCalledTimes(1);

    await expect(s.attempt(WRONG, { token: GOOD_TOKEN })).rejects.toMatchObject(
      { code: "EVENT_PASSWORD_INVALID" },
    );
    expect(s.memory.count(keysFor(IP_A).ip)).toBe(4);
    // Every gated attempt verifies its own token: no "verified once, trust
    // this IP from now on" shortcut.
    expect(s.verify).toHaveBeenCalledTimes(2);

    await expect(s.attempt(RIGHT, { token: BAD_TOKEN })).rejects.toMatchObject({
      code: "EVENT_PASSWORD_CHALLENGE_REQUIRED",
    });
    expect(s.verify).toHaveBeenCalledTimes(3);
    expect(s.verify).toHaveBeenLastCalledWith(BAD_TOKEN, IP_A);
    expect(s.logger.info).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({
        result: "challenge_required",
        reason: "token_rejected",
      }),
    );
    // The rejected-token attempt did not count as a password failure.
    expect(s.memory.count(keysFor(IP_A).ip)).toBe(4);
  });

  it("(d) successes are never counted", async () => {
    for (let i = 0; i < 10; i += 1) {
      await expect(s.attempt(RIGHT)).resolves.toMatchObject({ unlocked: true });
    }

    expect(s.memory.count(keysFor(IP_A).ip)).toBe(0);
    expect(s.memory.count(keysFor(IP_A).event)).toBe(0);
    expect(s.memory.keys()).toEqual([]);
  });

  it("(e) the per-event budget trips on the 100th failure across IPs, reports exactly once, then challenges every IP", async () => {
    // 90 earlier failures from 90 distinct IPs, written exactly as the use
    // case writes them (seeded directly: each real attempt costs a scrypt).
    for (let i = 0; i < 90; i += 1) {
      await s.memory.consumeMany([
        { key: keysFor(`10.0.0.${i}`).ip, maxTokens: 3, windowSeconds: 900 },
        { key: keysFor(null).event, maxTokens: 100, windowSeconds: 3600 },
      ]);
    }
    expect(s.reportError).not.toHaveBeenCalled();

    // Failures 91..100 run for real and concurrently, each from a fresh IP
    // (none near its own threshold). The counter's atomic increment means
    // exactly one of them sees the 100th count.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        s.attempt(WRONG, { ip: `10.0.0.${90 + i}` }),
      ),
    );
    expect(
      results.every(
        (r) =>
          r.status === "rejected" &&
          (r.reason as { code?: string }).code === "EVENT_PASSWORD_INVALID",
      ),
    ).toBe(true);
    expect(s.memory.count(keysFor(null).event)).toBe(100);

    expect(s.reportError).toHaveBeenCalledTimes(1);
    expect(s.reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { area: "event_password_failure_budget" },
      extra: { eventId: EVENT_ID },
    });

    // 101st…105th (tokened so they reach the password check): counted, not
    // reported again.
    for (let i = 0; i < 5; i += 1) {
      await expect(
        s.attempt(WRONG, { ip: `10.0.1.${i}`, token: GOOD_TOKEN }),
      ).rejects.toMatchObject({ code: "EVENT_PASSWORD_INVALID" });
    }
    expect(s.memory.count(keysFor(null).event)).toBe(105);
    expect(s.reportError).toHaveBeenCalledTimes(1);

    // A fresh IP with no failures of its own now needs a token too.
    await expect(
      s.attempt(RIGHT, { ip: "192.0.2.200" }),
    ).rejects.toMatchObject({ code: "EVENT_PASSWORD_CHALLENGE_REQUIRED" });
    await expect(
      s.attempt(RIGHT, { ip: "192.0.2.200", token: GOOD_TOKEN }),
    ).resolves.toMatchObject({ unlocked: true });
  });

  it("(f) another IP is unaffected by one IP's failures while under the event budget", async () => {
    await failTimes(s.attempt, 3, IP_A);

    await expect(s.attempt(WRONG, { ip: IP_B })).rejects.toMatchObject({
      code: "EVENT_PASSWORD_INVALID",
    });
    await expect(s.attempt(RIGHT, { ip: IP_B })).resolves.toMatchObject({
      unlocked: true,
    });
    expect(s.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", { enabled: false, verify: vi.fn() } as TurnstilePort],
    ["absent", null],
  ])(
    "(g) Turnstile %s: no challenge, the degrade is reported, throttled",
    async (_label, turnstile) => {
      const g = setup({ turnstile });
      await failTimes(g.attempt, 3, IP_A);

      // Over the threshold, but nothing to challenge with: answered normally.
      await failTimes(g.attempt, 2, IP_A);
      await expect(g.attempt(RIGHT)).resolves.toMatchObject({ unlocked: true });

      expect(g.logger.warn).toHaveBeenCalledWith(
        "event_password_challenge_unavailable",
        expect.objectContaining({ reason: "turnstile_disabled" }),
      );
      // Three degraded attempts, ONE report (throttled per reporter + tags).
      const degradeReports = g.reportError.mock.calls.filter(
        ([, ctx]) =>
          (ctx as { tags?: Record<string, string> }).tags?.area ===
          "event_password_challenge",
      );
      expect(degradeReports).toHaveLength(1);
      expect(degradeReports[0]![1]).toEqual({
        tags: { area: "event_password_challenge", reason: "turnstile_disabled" },
        extra: { eventId: EVENT_ID },
      });
      if (turnstile) expect(turnstile.verify).not.toHaveBeenCalled();
    },
  );

  it("(h) a throwing counter fails open: reported (throttled), password check still works", async () => {
    const boom = new Error("redis down");
    const counter = {
      peek: vi.fn(async () => {
        throw boom;
      }),
      consumeMany: vi.fn(async () => {
        throw boom;
      }),
    };
    const h = setup({ counter });

    await expect(h.attempt(WRONG)).rejects.toMatchObject({
      code: "EVENT_PASSWORD_INVALID",
    });
    await expect(h.attempt(WRONG)).rejects.toMatchObject({
      code: "EVENT_PASSWORD_INVALID",
    });
    await expect(h.attempt(RIGHT)).resolves.toMatchObject({ unlocked: true });

    expect(h.logger.error).toHaveBeenCalledWith(
      "event_password_failure_counter_unavailable",
      expect.objectContaining({ op: "peek", err: boom }),
    );
    expect(h.logger.error).toHaveBeenCalledWith(
      "event_password_failure_counter_unavailable",
      expect.objectContaining({ op: "consume", err: boom }),
    );
    // 3 peeks + 2 consumes failed; one report per op (throttled).
    expect(h.reportError).toHaveBeenCalledTimes(2);
    expect(h.reportError).toHaveBeenCalledWith(boom, {
      tags: { area: "event_password_failure_counter", op: "peek" },
      extra: { eventId: EVENT_ID },
    });
    expect(h.reportError).toHaveBeenCalledWith(boom, {
      tags: { area: "event_password_failure_counter", op: "consume" },
      extra: { eventId: EVENT_ID },
    });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("(h) a throwing reporter never changes the outcome", async () => {
    const counter = {
      peek: vi.fn(async () => {
        throw new Error("redis down");
      }),
      consumeMany: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    const h = setup({
      counter,
      reportError: vi.fn(() => {
        throw new Error("sentry down");
      }),
    });

    await expect(h.attempt(WRONG)).rejects.toMatchObject({
      code: "EVENT_PASSWORD_INVALID",
    });
    await expect(h.attempt(RIGHT)).resolves.toMatchObject({ unlocked: true });
  });

  it("(i) a bypassing editor is never challenged, even with the event budget spent", async () => {
    for (let i = 0; i < 150; i += 1) {
      await s.memory.consume(keysFor(IP_A).event, 100, 3600);
      await s.memory.consume(keysFor(IP_A).ip, 3, 900);
    }
    s.authz.getOrgMembership.mockResolvedValue({
      orgId: ORG_ID,
      humanId: EDITOR_ID,
      role: "ADMIN",
    } as never);
    const peek = vi.spyOn(s.memory, "peek");

    await expect(
      s.attempt("anything", { viewer: EDITOR_ID }),
    ).resolves.toMatchObject({ unlocked: true, bypassed: true });
    expect(peek).not.toHaveBeenCalled();
    expect(s.verify).not.toHaveBeenCalled();
  });

  it("(j) IPv6 addresses in the same /64 share one failure bucket", async () => {
    await failTimes(s.attempt, 1, "2001:db8:1:2::1");
    await failTimes(s.attempt, 1, "2001:db8:1:2::2");
    await failTimes(s.attempt, 1, "2001:db8:1:2:aaaa:bbbb:cccc:dddd");

    await expect(
      s.attempt(RIGHT, { ip: "2001:db8:1:2:ffff::9" }),
    ).rejects.toMatchObject({ code: "EVENT_PASSWORD_CHALLENGE_REQUIRED" });
    expect(keysFor("2001:db8:1:2::1").ip).toBe(
      `pwfail:ip:${EVENT_ID}:2001:0db8:0001:0002::/64`,
    );

    // The neighbouring /64 is a different client.
    await expect(
      s.attempt(RIGHT, { ip: "2001:db8:1:3::1" }),
    ).resolves.toMatchObject({ unlocked: true });
  });

  it("keeps the IPv4 key byte-identical and buckets a missing IP as no-ip", () => {
    expect(keysFor(IP_A)).toEqual({
      ip: `pwfail:ip:${EVENT_ID}:${IP_A}`,
      event: `pwfail:event:${EVENT_ID}`,
    });
    expect(keysFor(null).ip).toBe(`pwfail:ip:${EVENT_ID}:no-ip`);
  });

  it("counts both buckets in ONE consumeMany and reads them in ONE peek", async () => {
    const peek = vi.spyOn(s.memory, "peek");
    const consumeMany = vi.spyOn(s.memory, "consumeMany");

    await expect(s.attempt(WRONG)).rejects.toMatchObject({
      code: "EVENT_PASSWORD_INVALID",
    });

    expect(peek).toHaveBeenCalledTimes(1);
    expect(peek).toHaveBeenCalledWith([keysFor(IP_A).ip, keysFor(IP_A).event]);
    expect(consumeMany).toHaveBeenCalledTimes(1);
    expect(consumeMany).toHaveBeenCalledWith([
      { key: keysFor(IP_A).ip, maxTokens: 3, windowSeconds: 900 },
      { key: keysFor(IP_A).event, maxTokens: 100, windowSeconds: 3600 },
    ]);
  });
});
