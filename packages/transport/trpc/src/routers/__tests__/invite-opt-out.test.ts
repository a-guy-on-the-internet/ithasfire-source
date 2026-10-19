import { describe, expect, it, vi } from "vitest";

import {
  hashInviteOptOutEmail,
  mintInviteOptOutToken,
} from "@th/core/lib/security/invite-optout-token";
import { fail } from "@th/errors";

import { router } from "../../init";
import { isInvalidAttemptsRateLimited } from "../../rate-limit-markers";
import type { Ctx } from "../../context";
import { toTrpcError } from "../../utils";
import { eventsRouter } from "../events";
import { buildBaseCtx } from "./test-helpers";

/**
 * "Stop invites from this organiser" and "Stop all event invites", transport
 * side: three public, per-IP-limited mutations (peek, confirm, stop-all)
 * that never echo the address, and the allowance error's mapping.
 */

const OPT_OUT_SECRET = "derived-invite-optout-key-of-43-chars-xxxxx";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date();
const clock = { now: () => NOW } as unknown as Ctx["clock"];

const token = (email = "ana@example.com") =>
  mintInviteOptOutToken({ owner: { kind: "ORG", orgId: ORG_ID }, email }, OPT_OUT_SECRET);

const buildRepos = (
  standing: "ORGANISER" | "ALL" | null = null,
) => {
  const added: Array<{ owner: unknown; emailHash: string }> = [];
  const addedAll: Array<{ emailHash: string }> = [];
  const repos = {
    organizations: {
      getById: vi.fn(async (id: string) =>
        id === ORG_ID ? { id, name: "Night Owl Collective" } : null,
      ),
    },
    humans: { getById: vi.fn(async () => null) },
    eventInviteOptOuts: {
      add: vi.fn(async (input: { owner: unknown; emailHash: string }) => {
        added.push(input);
        return { created: true };
      }),
      addForAllOrganisers: vi.fn(async (input: { emailHash: string }) => {
        const created = !addedAll.some((a) => a.emailHash === input.emailHash);
        addedAll.push(input);
        return { created };
      }),
      standing: vi.fn(
        async (_input: { owner: unknown; emailHash: string }) => standing,
      ),
      listOptedOut: vi.fn(async () => new Set<string>()),
    },
  };
  return { repos: repos as unknown as Ctx["repos"], added, addedAll, raw: repos };
};

const allowAll = () => ({
  consume: vi.fn(async (_key: string) => ({
    allowed: true,
    remaining: Number.POSITIVE_INFINITY,
    retryAfterSeconds: 0,
  })),
});

const callerFor = (
  repos: Ctx["repos"],
  overrides: Partial<Ctx> = {},
  inviteOptOutSecret: string | null = OPT_OUT_SECRET,
) => {
  const ctx = {
    ...buildBaseCtx({
      repos,
      clock,
      actorHumanId: null,
      auth: null,
      authToken: null,
      rateLimit: allowAll() as unknown as Ctx["rateLimit"],
      ...overrides,
    }),
    inviteOptOutSecret,
  } as Ctx;
  return router(eventsRouter).createCaller(ctx) as any;
};

describe("events.peekInviteOptOut", () => {
  it("is public and read-only: names the organiser, writes nothing, never echoes the address", async () => {
    const { repos, raw } = buildRepos();
    const out = await callerFor(repos).peekInviteOptOut({ token: token() });
    expect(out).toEqual({
      ok: true,
      organiserName: "Night Owl Collective",
      organiserGone: false,
      alreadyStopped: null,
    });
    expect(raw.eventInviteOptOuts.add).not.toHaveBeenCalled();
    expect(raw.eventInviteOptOuts.addForAllOrganisers).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain("ana@");
  });

  it("a forged token is INVALID", async () => {
    const { repos } = buildRepos();
    const forged = mintInviteOptOutToken(
      { owner: { kind: "ORG", orgId: ORG_ID }, email: "ana@example.com" },
      "f".repeat(43),
    );
    await expect(callerFor(repos).peekInviteOptOut({ token: forged })).resolves.toEqual({
      ok: false,
      reason: "INVALID",
    });
  });

  it("strict input and a length bound", async () => {
    const { repos } = buildRepos();
    await expect(
      callerFor(repos).peekInviteOptOut({ token: token(), email: "x@y.z" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      callerFor(repos).peekInviteOptOut({ token: "x".repeat(5000) }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a VALID token is never charged to a per-IP bucket (only the default floor)", async () => {
    const { repos } = buildRepos();
    const consume = vi.fn(async (_key: string) => ({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 0,
    }));
    await callerFor(repos, {
      clientIp: "203.0.113.7",
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    }).peekInviteOptOut({ token: token() });
    expect(
      consume.mock.calls.map(([k]) => k).filter((k) => k.startsWith("event:")),
    ).toEqual([]);
  });

  it("charges INVALID outcomes per IP, and refuses once that bucket is spent", async () => {
    const { repos } = buildRepos();
    const consume = vi.fn(async (key: string) =>
      key.startsWith("event:inviteOptOut:invalid:")
        ? { allowed: false, remaining: 0, retryAfterSeconds: 30 }
        : { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0 },
    );
    const caller = callerFor(repos, {
      clientIp: "203.0.113.7",
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    await expect(caller.peekInviteOptOut({ token: "iso_nope" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      // Marked, so the one-click route can tell it from the default floor.
      message: expect.stringMatching(/^INVALID_ATTEMPTS_RATE_LIMITED: /),
    });
    expect(consume.mock.calls.map(([k]) => k)).toContain(
      "event:inviteOptOut:invalid:ip:203.0.113.7",
    );
    // The same IP over its invalid budget still gets a valid token through.
    await expect(caller.peekInviteOptOut({ token: token() })).resolves.toEqual({
      ok: true,
      organiserName: "Night Owl Collective",
      organiserGone: false,
      alreadyStopped: null,
    });
  });

  it("no key → PRECONDITION_FAILED", async () => {
    const { repos } = buildRepos();
    await expect(
      callerFor(repos, {}, null).peekInviteOptOut({ token: token() }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("carries the already-stopped state, asked for the token's own hash only", async () => {
    const { repos, raw } = buildRepos("ALL");
    await expect(
      callerFor(repos).peekInviteOptOut({ token: token("Ana@Example.com") }),
    ).resolves.toMatchObject({ ok: true, alreadyStopped: "ALL" });
    expect(raw.eventInviteOptOuts.standing.mock.calls).toEqual([
      [
        {
          owner: { kind: "ORG", orgId: ORG_ID },
          emailHash: hashInviteOptOutEmail("ana@example.com", OPT_OUT_SECRET),
        },
      ],
    ]);
  });
});

describe("events.stopOrganiserInvites", () => {
  it("records the opt-out for the token's organiser and address only", async () => {
    const { repos, added } = buildRepos();
    const out = await callerFor(repos).stopOrganiserInvites({
      token: token("Ana@Example.com"),
    });
    expect(out).toEqual({
      ok: true,
      organiserName: "Night Owl Collective",
      organiserGone: false,
      alreadyStopped: null,
    });
    // Only the keyed hash of the canonical address is stored.
    expect(added).toEqual([
      {
        owner: { kind: "ORG", orgId: ORG_ID },
        emailHash: hashInviteOptOutEmail("ana@example.com", OPT_OUT_SECRET),
      },
    ]);
    expect(JSON.stringify(added)).not.toContain("ana");
  });

  it("a bad token writes nothing", async () => {
    const { repos, added } = buildRepos();
    await expect(
      callerFor(repos).stopOrganiserInvites({ token: "iso_nope" }),
    ).resolves.toEqual({ ok: false, reason: "INVALID" });
    expect(added).toEqual([]);
  });

  it("a provider IP over its invalid budget still records valid opt-outs", async () => {
    const { repos, added } = buildRepos();
    const consume = vi.fn(async (key: string, _max: number) =>
      key.startsWith("event:inviteOptOut:invalid:")
        ? { allowed: false, remaining: 0, retryAfterSeconds: 30 }
        : { allowed: true, remaining: 1, retryAfterSeconds: 0 },
    );
    const caller = callerFor(repos, {
      clientIp: "198.51.100.9",
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      await expect(caller.stopOrganiserInvites({ token: token(email) })).resolves.toMatchObject({
        ok: true,
      });
    }
    expect(added).toHaveLength(3);
    expect(
      consume.mock.calls.some(([k]) => k.startsWith("event:inviteOptOut:")),
    ).toBe(false);
    // A bad token from that IP is refused once the invalid bucket is spent.
    let refused: unknown;
    try {
      await caller.stopOrganiserInvites({ token: "iso_nope" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(isInvalidAttemptsRateLimited((refused as Error).message)).toBe(true);
    expect(consume.mock.calls.map(([k]) => k)).toContain(
      "event:inviteOptOut:invalid:ip:198.51.100.9",
    );
  });
});

describe("events.stopAllInvites", () => {
  it("records one all-organisers opt-out by hash; a second tap says ALREADY", async () => {
    const { repos, added, addedAll } = buildRepos();
    const caller = callerFor(repos);
    const first = await caller.stopAllInvites({ token: token("Ana@Example.com") });
    const again = await caller.stopAllInvites({ token: token("ana@example.com") });
    expect(first).toEqual({
      ok: true,
      organiserName: "Night Owl Collective",
      organiserGone: false,
      alreadyStopped: null,
    });
    expect(again).toEqual({ ...first, alreadyStopped: "ALL" });
    const hash = hashInviteOptOutEmail("ana@example.com", OPT_OUT_SECRET);
    expect(addedAll).toEqual([{ emailHash: hash }, { emailHash: hash }]);
    // Not a per-organiser row.
    expect(added).toEqual([]);
    expect(JSON.stringify([first, again, addedAll])).not.toContain("ana");
  });

  it("strict input; a bad token writes nothing", async () => {
    const { repos, addedAll } = buildRepos();
    await expect(
      callerFor(repos).stopAllInvites({ token: token(), email: "x@y.z" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(callerFor(repos).stopAllInvites({ token: "iso_nope" })).resolves.toEqual({
      ok: false,
      reason: "INVALID",
    });
    expect(addedAll).toEqual([]);
  });

  it("valid tokens skip the per-IP bucket; INVALID ones are charged to their own", async () => {
    const { repos, addedAll } = buildRepos();
    const consume = vi.fn(async (key: string, _max: number) =>
      key.startsWith("event:inviteOptOut:invalid:")
        ? { allowed: false, remaining: 0, retryAfterSeconds: 30 }
        : { allowed: true, remaining: 1, retryAfterSeconds: 0 },
    );
    const caller = callerFor(repos, {
      clientIp: "198.51.100.9",
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    await expect(caller.stopAllInvites({ token: token() })).resolves.toMatchObject({
      ok: true,
    });
    expect(addedAll).toHaveLength(1);
    expect(consume.mock.calls.some(([k]) => k.startsWith("event:"))).toBe(false);
    let refused: unknown;
    try {
      await caller.stopAllInvites({ token: "iso_nope" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(isInvalidAttemptsRateLimited((refused as Error).message)).toBe(true);
    expect(consume.mock.calls.map(([k]) => k)).toContain(
      "event:inviteOptOut:invalid:ip:198.51.100.9",
    );
  });

  it("no key → PRECONDITION_FAILED", async () => {
    const { repos } = buildRepos();
    await expect(
      callerFor(repos, {}, null).stopAllInvites({ token: token() }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("invite opt-out: shared invalid-token bucket and a deleted organiser", () => {
  it("all three procedures charge ONE per-IP bucket for INVALID tokens", async () => {
    const { repos } = buildRepos();
    const consume = vi.fn(async (_key: string, _max: number) => ({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 0,
    }));
    const caller = callerFor(repos, {
      clientIp: "192.0.2.4",
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    await caller.peekInviteOptOut({ token: "iso_nope" });
    await caller.stopOrganiserInvites({ token: "iso_nope" });
    await caller.stopAllInvites({ token: "iso_nope" });
    const charged = consume.mock.calls.filter(([k]) => k.startsWith("event:"));
    expect(charged.map(([k]) => k)).toEqual([
      "event:inviteOptOut:invalid:ip:192.0.2.4",
      "event:inviteOptOut:invalid:ip:192.0.2.4",
      "event:inviteOptOut:invalid:ip:192.0.2.4",
    ]);
    // The limit itself is unchanged.
    expect(new Set(charged.map(([, max]) => max))).toEqual(new Set([30]));
  });

  it("a valid token for a deleted organiser: peek and stop-all answer ok (organiserGone), stop-organiser is INVALID", async () => {
    const { repos, added, addedAll } = buildRepos();
    const gone = mintInviteOptOutToken(
      { owner: { kind: "ORG", orgId: "44444444-4444-4444-8444-444444444444" }, email: "ana@example.com" },
      OPT_OUT_SECRET,
    );
    const caller = callerFor(repos);
    await expect(caller.peekInviteOptOut({ token: gone })).resolves.toEqual({
      ok: true,
      organiserName: null,
      organiserGone: true,
      alreadyStopped: null,
    });
    await expect(caller.stopOrganiserInvites({ token: gone })).resolves.toEqual({
      ok: false,
      reason: "INVALID",
    });
    await expect(caller.stopAllInvites({ token: gone })).resolves.toEqual({
      ok: true,
      organiserName: null,
      organiserGone: true,
      alreadyStopped: null,
    });
    expect(added).toEqual([]);
    expect(addedAll).toEqual([
      { emailHash: hashInviteOptOutEmail("ana@example.com", OPT_OUT_SECRET) },
    ]);
  });
});

describe("INVITE_ALLOWANCE_EXCEEDED", () => {
  it("maps to TOO_MANY_REQUESTS and keeps the remaining count for the panel", () => {
    let thrown: unknown;
    try {
      fail("INVITE_ALLOWANCE_EXCEEDED", {
        meta: { requested: 20, remaining: 10, limit: 50 },
      });
    } catch (e) {
      thrown = e;
    }
    const err = toTrpcError(thrown);
    expect(err.code).toBe("TOO_MANY_REQUESTS");
    expect(JSON.stringify((err as { meta?: unknown }).meta ?? err.cause)).toContain(
      '"remaining":10',
    );
  });

  it("keeps the binding tier, so the panel can name the new-account rule", () => {
    let thrown: unknown;
    try {
      throw fail("INVITE_ALLOWANCE_EXCEEDED", {
        meta: { requested: 3, remaining: 0, limit: 10, tier: "NEW_ACCOUNT" },
      });
    } catch (e) {
      thrown = e;
    }
    const err = toTrpcError(thrown);
    expect(err.code).toBe("TOO_MANY_REQUESTS");
    expect(JSON.stringify((err as { meta?: unknown }).meta ?? err.cause)).toContain(
      '"tier":"NEW_ACCOUNT"',
    );
  });
});

describe("EMAIL_NOT_VERIFIED (sending invites needs a verified email)", () => {
  it("maps to FORBIDDEN and keeps its app code", () => {
    let thrown: unknown;
    try {
      throw fail("EMAIL_NOT_VERIFIED");
    } catch (e) {
      thrown = e;
    }
    const err = toTrpcError(thrown);
    expect(err.code).toBe("FORBIDDEN");
    expect(JSON.stringify((err as { meta?: unknown }).meta ?? err.cause)).toContain(
      "EMAIL_NOT_VERIFIED",
    );
  });
});
