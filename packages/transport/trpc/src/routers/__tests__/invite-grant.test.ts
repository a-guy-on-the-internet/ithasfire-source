import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as updateOrderItemsModule from "@th/core/use-cases/orders/update-order-items";
import { fail } from "@th/errors";

import {
  hashInviteToken,
  mintInviteToken,
} from "@th/core/lib/security/invite-token";

import { router } from "../../init";
import type { Ctx } from "../../context";
import { ensureFullEventReadAccessByEventId } from "../../event-read-access";
import {
  findHeldEventInviteGrantId,
  hasEventUnlockCookie,
  readEventApplicationGrantCookie,
  readEventInviteGrantCookie,
  verifyEventUnlockCookie,
} from "../../event-unlock-cookie";
import { eventsRouter } from "../events";
import { ordersRouter } from "../orders";
import { buildBaseCtx } from "./test-helpers";

/**
 * Gated-event invite links, transport side
 * (docs/specs/2026-10-02/completed/gated-event-invite-links.spec.yaml):
 *  - the `th_ei_<eventId>` invite grant cookie (web signs, API verifies);
 *  - read access honours it through core's `inviteGrantHolds`;
 *  - `events.redeemInvite` (public, rate limited, never echoes the token,
 *    grant id server-derived) and the organizer procedures.
 */

const SECRET = "event-unlock-secret-with-at-least-32-chars";
const TOKEN_SECRET = "derived-invite-token-key-of-43-chars-xxxxxx";
const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const OTHER_EVENT_ID = "40000000-0000-4000-8000-00000000000a";
const INVITE_ID = "90000000-0000-4000-8000-000000000009";
const OTHER_INVITE_ID = "90000000-0000-4000-8000-00000000000f";
const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Golden vector for `apps/web/src/lib/event-unlock-cookie.ts` (step 6): the
 * web's signer MUST produce exactly this value for these inputs.
 * `<inviteId>.<expMs>.<base64url HMAC-SHA256(secret, "th_ei|v1|<eventId>|<inviteId>|<expMs>")>`
 */
const GOLDEN_COOKIE = `th_ei_${EVENT_ID}=${INVITE_ID}.4102444800000.FL9PARNJlJu5VNuT_uWWCpqC8LwbgTWT93wlcxovhd0`;

const inviteCookie = (
  opts: {
    eventId?: string;
    signedForEventId?: string;
    inviteId?: string;
    exp?: number;
    secret?: string;
  } = {},
): string => {
  const eventId = opts.eventId ?? EVENT_ID;
  const inviteId = opts.inviteId ?? INVITE_ID;
  const exp = String(opts.exp ?? Date.now() + 60_000);
  const sig = createHmac("sha256", opts.secret ?? SECRET)
    .update(`th_ei|v1|${opts.signedForEventId ?? eventId}|${inviteId}|${exp}`)
    .digest("base64url");
  return `th_ei_${eventId}=${inviteId}.${exp}.${sig}`;
};

const applicationGrantCookie = (submissionId: string, approvedAtMs: number): string => {
  const exp = String(Date.now() + 60_000);
  const sig = createHmac("sha256", SECRET)
    .update(`th_ea|v2|${EVENT_ID}|${submissionId}|${approvedAtMs}|${exp}`)
    .digest("base64url");
  return `th_ea_${EVENT_ID}=${submissionId}.${approvedAtMs}.${exp}.${sig}`;
};

const passwordCookie = (): string => {
  const exp = Date.now() + 60_000;
  const sig = createHmac("sha256", SECRET)
    .update(`${EVENT_ID}|${exp}`)
    .digest("base64url");
  return `th_eu_${EVENT_ID}=${exp}.${sig}`;
};

const cookieCtx = (cookieHeader: string | null, secret: string | null = SECRET) => ({
  cookieHeader,
  eventUnlockSecret: secret,
});

describe("readEventInviteGrantCookie", () => {
  it("accepts the golden vector (the web signer's contract)", () => {
    expect(readEventInviteGrantCookie(cookieCtx(GOLDEN_COOKIE), EVENT_ID)).toEqual({
      inviteId: INVITE_ID,
      expMs: 4102444800000,
    });
  });

  it("round-trips a freshly signed grant among other cookies", () => {
    const exp = Date.now() + 60_000;
    expect(
      readEventInviteGrantCookie(
        cookieCtx(`th-theme=dark; ${inviteCookie({ exp })}; th_consent=1`),
        EVENT_ID,
      ),
    ).toEqual({ inviteId: INVITE_ID, expMs: exp });
  });

  it("rejects a tampered signature, a swapped invite id and a swapped expiry", () => {
    const good = inviteCookie();
    const tampered = good.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect(readEventInviteGrantCookie(cookieCtx(tampered), EVENT_ID)).toBeNull();
    const swappedId = good.replace(INVITE_ID, OTHER_INVITE_ID);
    expect(readEventInviteGrantCookie(cookieCtx(swappedId), EVENT_ID)).toBeNull();
    const [, value] = good.split("=") as [string, string];
    const [, exp, sig] = value.split(".") as [string, string, string];
    const swappedExp = `th_ei_${EVENT_ID}=${INVITE_ID}.${Number(exp) + 1}.${sig}`;
    expect(readEventInviteGrantCookie(cookieCtx(swappedExp), EVENT_ID)).toBeNull();
  });

  it("rejects an expired grant", () => {
    expect(
      readEventInviteGrantCookie(
        cookieCtx(inviteCookie({ exp: Date.now() - 1 })),
        EVENT_ID,
      ),
    ).toBeNull();
  });

  it("rejects a grant signed for another event, and never reads event A's grant for event B", () => {
    expect(
      readEventInviteGrantCookie(
        cookieCtx(inviteCookie({ signedForEventId: OTHER_EVENT_ID })),
        EVENT_ID,
      ),
    ).toBeNull();
    expect(
      readEventInviteGrantCookie(cookieCtx(inviteCookie()), OTHER_EVENT_ID),
    ).toBeNull();
  });

  it("rejects another secret, and returns null without a usable secret", () => {
    expect(
      readEventInviteGrantCookie(
        cookieCtx(inviteCookie({ secret: "x".repeat(40) })),
        EVENT_ID,
      ),
    ).toBeNull();
    expect(readEventInviteGrantCookie(cookieCtx(inviteCookie(), null), EVENT_ID)).toBeNull();
    expect(readEventInviteGrantCookie(cookieCtx(inviteCookie(), "short"), EVENT_ID)).toBeNull();
  });

  it("is never confused with the password cookie or the application grant", () => {
    const grantValue = inviteCookie().split("=")[1]!;
    // The invite grant's value under the other two names.
    expect(
      verifyEventUnlockCookie(
        buildBaseCtx({
          eventUnlockSecret: SECRET,
          cookieHeader: `th_eu_${EVENT_ID}=${grantValue}`,
        }),
        EVENT_ID,
      ),
    ).toBe(false);
    expect(
      readEventApplicationGrantCookie(
        cookieCtx(`th_ea_${EVENT_ID}=${grantValue}`),
        EVENT_ID,
      ),
    ).toBeNull();
    // A password cookie's value under the invite grant's name.
    const exp = Date.now() + 60_000;
    const pwSig = createHmac("sha256", SECRET)
      .update(`${EVENT_ID}|${exp}`)
      .digest("base64url");
    expect(
      readEventInviteGrantCookie(cookieCtx(`th_ei_${EVENT_ID}=${exp}.${pwSig}`), EVENT_ID),
    ).toBeNull();
    // Same-shape forgery: the password MAC under th_ei_'s 3-part layout.
    expect(
      readEventInviteGrantCookie(
        cookieCtx(`th_ei_${EVENT_ID}=${INVITE_ID}.${exp}.${pwSig}`),
        EVENT_ID,
      ),
    ).toBeNull();
  });

  it("hasEventUnlockCookie counts an invite grant, keeping the request off shared caches", () => {
    expect(hasEventUnlockCookie(`th-theme=dark; ${inviteCookie()}`)).toBe(true);
  });
});

describe("findHeldEventInviteGrantId", () => {
  it("finds a valid grant for the invite under its event's cookie", () => {
    expect(
      findHeldEventInviteGrantId(
        cookieCtx(`a=1; ${inviteCookie({ eventId: OTHER_EVENT_ID, inviteId: OTHER_INVITE_ID })}; ${inviteCookie()}`),
        INVITE_ID,
      ),
    ).toBe(INVITE_ID);
  });

  it("returns null for another invite's grant, a forged or expired one, or no secret", () => {
    expect(findHeldEventInviteGrantId(cookieCtx(inviteCookie()), OTHER_INVITE_ID)).toBeNull();
    expect(
      findHeldEventInviteGrantId(
        cookieCtx(inviteCookie({ secret: "y".repeat(40) })),
        INVITE_ID,
      ),
    ).toBeNull();
    expect(
      findHeldEventInviteGrantId(cookieCtx(inviteCookie({ exp: Date.now() - 1 })), INVITE_ID),
    ).toBeNull();
    expect(
      findHeldEventInviteGrantId(
        cookieCtx(inviteCookie({ signedForEventId: OTHER_EVENT_ID })),
        INVITE_ID,
      ),
    ).toBeNull();
    expect(findHeldEventInviteGrantId(cookieCtx(inviteCookie(), null), INVITE_ID)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

type InviteRow = {
  id: string;
  eventId: string;
  kind: "SHARED" | "PERSONAL";
  revokedAt: Date | null;
  grantsRevokedAt: Date | null;
};

const NOW = new Date();
const DAY_MS = 24 * 60 * 60 * 1000;

const buildRepos = (
  opts: {
    gateType?: "PASSWORD" | "APPLICATION" | "NONE";
    status?: "PUBLISHED" | "CANCELLED";
    endsAt?: Date | null;
    startsAt?: Date;
    invite?: Partial<InviteRow & { inviteeName: string | null; inviteeEmail: string | null }> | null;
    membershipRole?: string | null;
    /** An APPROVED ATTEND submission of the viewer (for th_ea_ ordering). */
    approvedSubmission?: { id: string; reviewedAt: Date };
  } = {},
) => {
  const event = {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    gateType: opts.gateType ?? "PASSWORD",
    visibility: "PUBLIC",
    status: opts.status ?? "PUBLISHED",
    publishedAt: new Date(NOW.getTime() - 10 * DAY_MS),
    stewardship: "OWNED",
    passwordHash: "set",
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    slug: "secret-show",
    startsAt: opts.startsAt ?? new Date(NOW.getTime() + DAY_MS),
    endsAt:
      opts.endsAt === undefined ? new Date(NOW.getTime() + 2 * DAY_MS) : opts.endsAt,
    timezone: "America/Chicago",
  };
  const invite: InviteRow | null =
    opts.invite === null
      ? null
      : {
          id: INVITE_ID,
          eventId: EVENT_ID,
          kind: "SHARED",
          revokedAt: null,
          grantsRevokedAt: null,
          ...opts.invite,
        };
  const token = mintInviteToken(INVITE_ID, TOKEN_SECRET);
  const eventInvites = {
    getById: vi.fn(async (id: string) => (invite && id === invite.id ? { ...invite } : null)),
    getByTokenHash: vi.fn(async (hash: string) =>
      invite && hash === hashInviteToken(token) ? { ...invite } : null,
    ),
    recordRedemption: vi.fn(async () => (invite ? { ...invite } : null)),
    lockIfLive: vi.fn(async () => !!invite && invite.revokedAt === null),
    lockIfGrantsHold: vi.fn(
      async () => !!invite && invite.grantsRevokedAt === null,
    ),
    listByEvent: vi.fn(async () => []),
    getLiveShared: vi.fn(async () => null),
  };
  const eventUnlocks = {
    isUnlocked: vi.fn(async () => false),
    get: vi.fn(async () => null),
    upsert: vi.fn(async () => ({ id: "unlock-1" })),
  };
  const getOrgMembership = vi.fn(async () =>
    opts.membershipRole ? { role: opts.membershipRole } : null,
  );
  const repos: Record<string, unknown> = {
    events: {
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)),
    },
    authz: { getOrgMembership, getHumanDelegation: vi.fn(async () => null) },
    eventUnlocks,
    eventApplications: {
      getSubmissionById: vi.fn(async (id: string) =>
        opts.approvedSubmission && id === opts.approvedSubmission.id
          ? {
              id,
              eventId: EVENT_ID,
              purpose: "ATTEND",
              formId: "form-attend",
              humanId: VIEWER_ID,
              contactEmail: null,
              status: "APPROVED",
              reviewedAt: opts.approvedSubmission.reviewedAt,
            }
          : null,
      ),
      attachSubmissionToHuman: vi.fn(async () => null),
      lockApprovedSubmission: vi.fn(async () => true),
    },
    eventInvites,
    audit: { log: vi.fn(async () => undefined) },
    organizations: {
      getById: vi.fn(async (id: string) =>
        id === ORG_ID ? { id, name: "Stub Collective" } : null,
      ),
    },
    humans: {
      getById: vi.fn(async () => null),
      getByIdWithIdentity: vi.fn(async () => ({
        human: { id: VIEWER_ID },
        identity: { email: "viewer@example.com", emailVerified: true },
      })),
    },
  };
  repos.tx = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(repos));
  return {
    repos: repos as unknown as Ctx["repos"],
    eventInvites,
    eventUnlocks,
    getOrgMembership,
    token,
  };
};

const clock = { now: () => NOW } as unknown as Ctx["clock"];

const anonymousCtx = (repos: Ctx["repos"], cookieHeader: string | null) =>
  buildBaseCtx({
    repos,
    clock,
    actorHumanId: null,
    auth: null,
    authToken: null,
    eventUnlockSecret: SECRET,
    cookieHeader,
  });

describe("ensureFullEventReadAccessByEventId — invite grant", () => {
  it.each(["PASSWORD", "APPLICATION"] as const)(
    "a valid grant for a live invite opens a %s gate",
    async (gateType) => {
      const { repos, eventInvites } = buildRepos({ gateType });
      await expect(
        ensureFullEventReadAccessByEventId(anonymousCtx(repos, inviteCookie()), EVENT_ID),
      ).resolves.toBeUndefined();
      expect(eventInvites.getById).toHaveBeenCalledWith(INVITE_ID);
    },
  );

  it("SHARED invite reset / turned off → the holder stays in (R5, R14)", async () => {
    const { repos } = buildRepos({
      invite: { kind: "SHARED", revokedAt: new Date(NOW.getTime() - 1000) },
    });
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, inviteCookie()), EVENT_ID),
    ).resolves.toBeUndefined();
  });

  it("SHARED link removed (Reset and remove everyone) → the holder is out", async () => {
    const removedAt = new Date(NOW.getTime() - 1000);
    const { repos } = buildRepos({
      invite: { kind: "SHARED", revokedAt: removedAt, grantsRevokedAt: removedAt },
    });
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, inviteCookie()), EVENT_ID),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("PERSONAL invite revoked → the holder is out (FR-006)", async () => {
    const { repos } = buildRepos({
      gateType: "APPLICATION",
      invite: { kind: "PERSONAL", revokedAt: new Date(NOW.getTime() - 1000) },
    });
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, inviteCookie()), EVENT_ID),
    ).rejects.toMatchObject({ code: "forbidden", message: "event_application_required" });
  });

  it("event ended → out, even with an unexpired cookie (FR-008)", async () => {
    const { repos } = buildRepos({
      startsAt: new Date(NOW.getTime() - 2 * DAY_MS),
      endsAt: new Date(NOW.getTime() - DAY_MS),
    });
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, inviteCookie()), EVENT_ID),
    ).rejects.toMatchObject({ code: "forbidden", message: "event_password_required" });
  });

  it("an invite that belongs to another event → out", async () => {
    const { repos } = buildRepos({ invite: { eventId: OTHER_EVENT_ID } });
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, inviteCookie()), EVENT_ID),
    ).rejects.toMatchObject({ message: "event_password_required" });
  });

  it("forged / expired / other-event cookie → out, and the invite is never looked up", async () => {
    const { repos, eventInvites } = buildRepos();
    for (const cookie of [
      inviteCookie({ secret: "z".repeat(40) }),
      inviteCookie({ exp: Date.now() - 1 }),
      inviteCookie({ signedForEventId: OTHER_EVENT_ID }),
    ]) {
      await expect(
        ensureFullEventReadAccessByEventId(anonymousCtx(repos, cookie), EVENT_ID),
      ).rejects.toMatchObject({ message: "event_password_required" });
    }
    expect(eventInvites.getById).not.toHaveBeenCalled();
  });
});

describe("events.getGateState — invite grant", () => {
  it("reports viewerHasInviteGrant from the cookie and refuses a client-supplied inviteGrant", async () => {
    const { repos } = buildRepos();
    const caller = router(eventsRouter).createCaller(
      anonymousCtx(repos, inviteCookie()),
    ) as any;
    const state = await caller.getGateState({ eventId: EVENT_ID });
    expect(state).toMatchObject({ viewerHasInviteGrant: true, passwordRequired: false });

    const noCookie = router(eventsRouter).createCaller(anonymousCtx(repos, null)) as any;
    await expect(
      noCookie.getGateState({
        eventId: EVENT_ID,
        inviteGrant: { inviteId: INVITE_ID, expMs: Date.now() + 60_000 },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("events.getGateState — removed by Reset and remove everyone", () => {
  const removedAt = new Date(NOW.getTime() - 1000);
  const gateFor = (repos: Ctx["repos"], cookieHeader: string | null) =>
    (router(eventsRouter).createCaller(anonymousCtx(repos, cookieHeader)) as any)
      .getGateState({ eventId: EVENT_ID });

  it("a valid grant for a removed SHARED link → locked, with the reason", async () => {
    const { repos } = buildRepos({
      invite: { kind: "SHARED", revokedAt: removedAt, grantsRevokedAt: removedAt },
    });
    await expect(gateFor(repos, inviteCookie())).resolves.toMatchObject({
      passwordRequired: true,
      viewerHasInviteGrant: false,
      viewerRemovedByInviteReset: true,
    });
  });

  it("the access check never runs the explanation lookup", async () => {
    const { repos, eventInvites, eventUnlocks } = buildRepos({
      invite: { kind: "SHARED", revokedAt: removedAt, grantsRevokedAt: removedAt },
    });
    const ctx = buildBaseCtx({
      repos,
      clock,
      actorHumanId: VIEWER_ID,
      auth: null,
      authToken: null,
      eventUnlockSecret: SECRET,
      cookieHeader: inviteCookie(),
    });
    await expect(
      ensureFullEventReadAccessByEventId(ctx, EVENT_ID),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(eventUnlocks.get).not.toHaveBeenCalled();
    // Once, by `inviteGrantHolds`; never again for the explanation.
    expect(eventInvites.getById).toHaveBeenCalledTimes(1);
  });

  it("refuses a client-supplied explainRemoval", async () => {
    const { repos } = buildRepos();
    const caller = router(eventsRouter).createCaller(anonymousCtx(repos, null)) as any;
    await expect(
      caller.getGateState({ eventId: EVENT_ID, explainRemoval: true }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("a plain reset → still in, no reason", async () => {
    const { repos } = buildRepos({
      invite: { kind: "SHARED", revokedAt: removedAt },
    });
    await expect(gateFor(repos, inviteCookie())).resolves.toMatchObject({
      passwordRequired: false,
      viewerRemovedByInviteReset: false,
    });
  });

  it("event ended → no reason", async () => {
    const { repos } = buildRepos({
      startsAt: new Date(NOW.getTime() - 2 * DAY_MS),
      endsAt: new Date(NOW.getTime() - DAY_MS),
      invite: { kind: "SHARED", revokedAt: removedAt, grantsRevokedAt: removedAt },
    });
    await expect(gateFor(repos, inviteCookie())).resolves.toMatchObject({
      viewerRemovedByInviteReset: false,
    });
  });

  it("forged / expired / other-event cookie → no reason, and the invite is never looked up", async () => {
    const { repos, eventInvites } = buildRepos({
      invite: { kind: "SHARED", revokedAt: removedAt, grantsRevokedAt: removedAt },
    });
    for (const cookie of [
      inviteCookie({ secret: "z".repeat(40) }),
      inviteCookie({ exp: Date.now() - 1 }),
      inviteCookie({ signedForEventId: OTHER_EVENT_ID }),
      // Event B's valid grant, sent under its own cookie name: never read for A.
      inviteCookie({ eventId: OTHER_EVENT_ID }),
      `th_ei_${EVENT_ID}=${INVITE_ID}.${Date.now() + 60_000}.`,
    ]) {
      await expect(gateFor(repos, cookie)).resolves.toMatchObject({
        passwordRequired: true,
        viewerRemovedByInviteReset: false,
      });
    }
    await expect(gateFor(repos, null)).resolves.toMatchObject({
      viewerRemovedByInviteReset: false,
    });
    expect(eventInvites.getById).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

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
  inviteTokenSecret: string | null = TOKEN_SECRET,
) => {
  const ctx = {
    ...buildBaseCtx({
      repos,
      clock,
      actorHumanId: null,
      auth: null,
      authToken: null,
      eventUnlockSecret: SECRET,
      publicAppUrl: "https://ithas.fire",
      ...overrides,
    }),
    inviteTokenSecret,
  } as Ctx;
  return router(eventsRouter).createCaller(ctx) as any;
};

describe("events.redeemInvite", () => {
  it("is public: a signed-out holder of a live SHARED link gets INVITE_GRANT, and the token is never echoed", async () => {
    const { repos, token, eventInvites } = buildRepos();
    const result = await callerFor(repos).redeemInvite({ token });

    expect(result).toEqual({
      ok: true,
      eventId: EVENT_ID,
      slug: "secret-show",
      grant: "INVITE_GRANT",
      inviteId: INVITE_ID,
      submissionId: null,
      approvedAtMs: null,
      expiresAtMs: expect.any(Number),
      created: true,
    });
    expect(result.expiresAtMs).toBe(NOW.getTime() + 2 * DAY_MS);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token.slice(-43));
    expect(eventInvites.recordRedemption).toHaveBeenCalledTimes(1);
  });

  it("a dead link is { ok: false, reason } and does not echo the token either", async () => {
    const { repos, token } = buildRepos({
      invite: { kind: "SHARED", revokedAt: new Date(NOW.getTime() - 1000) },
    });
    const result = await callerFor(repos).redeemInvite({ token });
    expect(result).toEqual({
      ok: false,
      reason: "REVOKED",
      eventId: EVENT_ID,
      slug: "secret-show",
    });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("a forged token is INVALID without touching the event", async () => {
    const { repos } = buildRepos();
    const forged = mintInviteToken(INVITE_ID, "q".repeat(43));
    const result = await callerFor(repos).redeemInvite({ token: forged });
    expect(result).toEqual({ ok: false, reason: "INVALID", eventId: null, slug: null });
  });

  it("expectedEventId naming another event → INVALID before any count or write, and no event leaks (F7)", async () => {
    const { repos, token, eventInvites, eventUnlocks } = buildRepos();
    const result = await callerFor(repos).redeemInvite({
      token,
      expectedEventId: OTHER_EVENT_ID,
    });
    expect(result).toEqual({ ok: false, reason: "INVALID", eventId: null, slug: null });
    expect(eventInvites.recordRedemption).not.toHaveBeenCalled();
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
    expect((repos as unknown as { tx: ReturnType<typeof vi.fn> }).tx).not.toHaveBeenCalled();
  });

  it("expectedEventId naming the token's own event redeems as usual", async () => {
    const { repos, token, eventInvites } = buildRepos();
    const result = await callerFor(repos).redeemInvite({
      token,
      expectedEventId: EVENT_ID,
    });
    expect(result).toMatchObject({ ok: true, eventId: EVENT_ID });
    expect(eventInvites.recordRedemption).toHaveBeenCalledTimes(1);
  });

  it("rejects a client-supplied grant id or viewer id (strict input)", async () => {
    const { repos, token, eventInvites } = buildRepos();
    const caller = callerFor(repos);
    await expect(
      caller.redeemInvite({ token, currentInviteGrantId: INVITE_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.redeemInvite({ token, viewerHumanId: VIEWER_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(eventInvites.getByTokenHash).not.toHaveBeenCalled();
  });

  it("derives the held grant from a VERIFIED th_ei_ cookie only: a re-redeem does not count again", async () => {
    const held = buildRepos();
    const reRedeem = await callerFor(held.repos, {
      cookieHeader: inviteCookie(),
    }).redeemInvite({ token: held.token });
    expect(reRedeem).toMatchObject({ ok: true, grant: "INVITE_GRANT", created: false });
    expect(held.eventInvites.recordRedemption).not.toHaveBeenCalled();

    // A forged cookie naming the same invite is ignored: counted as new.
    const forged = buildRepos();
    const fresh = await callerFor(forged.repos, {
      cookieHeader: inviteCookie({ secret: "f".repeat(40) }),
    }).redeemInvite({ token: forged.token });
    expect(fresh).toMatchObject({ ok: true, created: true });
    expect(forged.eventInvites.recordRedemption).toHaveBeenCalledTimes(1);
  });

  it("is rate limited per IP under its own key, before the use case runs", async () => {
    const { repos, token, eventInvites } = buildRepos();
    const consume = vi.fn(async (key: string) =>
      key.startsWith("event:redeemInvite:")
        ? { allowed: false, remaining: 0, retryAfterSeconds: 30 }
        : { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0 },
    );
    const caller = callerFor(repos, {
      clientIp: "203.0.113.7",
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    await expect(caller.redeemInvite({ token })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    const keys = consume.mock.calls.map(([key]) => key);
    expect(keys).toContain("event:redeemInvite:ip:203.0.113.7");
    expect(eventInvites.getByTokenHash).not.toHaveBeenCalled();
  });

  it("fails NOT_CONFIGURED (PRECONDITION_FAILED) when the token key is missing", async () => {
    const { repos, token, eventInvites } = buildRepos();
    await expect(
      callerFor(repos, {}, null).redeemInvite({ token }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(eventInvites.getByTokenHash).not.toHaveBeenCalled();
  });

  it("setSharedInvite ENABLE without a token key fails NOT_CONFIGURED, not a 500", async () => {
    const { repos } = buildRepos({ membershipRole: "OWNER" });
    await expect(
      callerFor(
        repos,
        {
          actorHumanId: ORGANIZER_ID,
          rateLimit: allowAll() as unknown as Ctx["rateLimit"],
        },
        null,
      ).setSharedInvite({ eventId: EVENT_ID, action: "ENABLE" }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("events.peekInvite", () => {
  it("is public: an anonymous peek of a live PERSONAL link → short name + organizer, no token, no email, no writes", async () => {
    const { repos, token, eventInvites, eventUnlocks } = buildRepos({
      invite: {
        kind: "PERSONAL",
        inviteeName: "Maya Rodriguez",
        inviteeEmail: "maya@example.com",
      },
    });
    const out = await callerFor(repos).peekInvite({ token });

    expect(out).toEqual({
      ok: true,
      eventId: EVENT_ID,
      kind: "PERSONAL",
      inviteeShortName: "Maya R.",
      organizerName: "Stub Collective",
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.slice(-43));
    expect(text).not.toContain("maya@example.com");
    expect(eventInvites.recordRedemption).not.toHaveBeenCalled();
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
    expect((repos as unknown as { tx: ReturnType<typeof vi.fn> }).tx).not.toHaveBeenCalled();
  });

  it("expectedEventId naming another event → INVALID with no event (F7)", async () => {
    const { repos, token } = buildRepos();
    await expect(
      callerFor(repos).peekInvite({ token, expectedEventId: OTHER_EVENT_ID }),
    ).resolves.toEqual({ ok: false, reason: "INVALID", eventId: null });
    await expect(
      callerFor(repos).peekInvite({ token, expectedEventId: EVENT_ID }),
    ).resolves.toMatchObject({ ok: true, eventId: EVENT_ID });
  });

  it("a forged token → INVALID with no event", async () => {
    const { repos } = buildRepos();
    const forged = mintInviteToken(INVITE_ID, "q".repeat(43));
    await expect(callerFor(repos).peekInvite({ token: forged })).resolves.toEqual({
      ok: false,
      reason: "INVALID",
      eventId: null,
    });
  });

  it("a reset SHARED link → REVOKED (stops new arrivals, R5)", async () => {
    const { repos, token } = buildRepos({
      invite: { kind: "SHARED", revokedAt: new Date(NOW.getTime() - 1000) },
    });
    await expect(callerFor(repos).peekInvite({ token })).resolves.toEqual({
      ok: false,
      reason: "REVOKED",
      eventId: EVENT_ID,
    });
  });

  it("strict input: only the token", async () => {
    const { repos, token } = buildRepos();
    await expect(
      callerFor(repos).peekInvite({ token, viewerHumanId: VIEWER_ID }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("is rate limited per IP under its OWN key (not redeem's), before core runs", async () => {
    const { repos, token, eventInvites } = buildRepos();
    const consume = vi.fn(async (key: string) =>
      key.startsWith("event:peekInvite:")
        ? { allowed: false, remaining: 0, retryAfterSeconds: 30 }
        : { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0 },
    );
    const caller = callerFor(repos, {
      clientIp: "203.0.113.7",
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    await expect(caller.peekInvite({ token })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    const keys = consume.mock.calls.map(([key]) => key);
    expect(keys).toContain("event:peekInvite:ip:203.0.113.7");
    expect(keys.some((k) => k.startsWith("event:redeemInvite:"))).toBe(false);
    expect(eventInvites.getByTokenHash).not.toHaveBeenCalled();
  });

  it("no token key → PRECONDITION_FAILED", async () => {
    const { repos, token } = buildRepos();
    await expect(callerFor(repos, {}, null).peekInvite({ token })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});

describe("organizer invite procedures", () => {
  const signedIn = (actor: string) => ({
    actorHumanId: actor,
    rateLimit: allowAll() as unknown as Ctx["rateLimit"],
  });

  it.each([
    ["setSharedInvite", { eventId: EVENT_ID, action: "ENABLE" }],
    ["listInvites", { eventId: EVENT_ID }],
    ["revokeGuestInvite", { eventId: EVENT_ID, inviteId: INVITE_ID }],
    ["resendGuestInvite", { eventId: EVENT_ID, inviteId: INVITE_ID }],
    [
      "createGuestInvites",
      { eventId: EVENT_ID, guests: [{ name: "Ana", email: "ana@example.com" }] },
    ],
  ] as const)(
    "%s: a non-editor is refused by the use case's authz, with the SESSION actor",
    async (procedure, input) => {
      const { repos, getOrgMembership, eventInvites } = buildRepos({
        membershipRole: null,
      });
      await expect(
        callerFor(repos, signedIn(VIEWER_ID))[procedure](input),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(getOrgMembership).toHaveBeenCalledWith({
        orgId: ORG_ID,
        humanId: VIEWER_ID,
      });
      expect(eventInvites.listByEvent).not.toHaveBeenCalled();
      expect(eventInvites.getLiveShared).not.toHaveBeenCalled();
    },
  );

  it.each(["setSharedInvite", "listInvites", "revokeGuestInvite"] as const)(
    "%s: rejects a client-supplied actorHumanId",
    async (procedure) => {
      const { repos } = buildRepos({ membershipRole: "OWNER" });
      await expect(
        callerFor(repos, signedIn(VIEWER_ID))[procedure]({
          eventId: EVENT_ID,
          inviteId: INVITE_ID,
          action: "ENABLE",
          actorHumanId: ORGANIZER_ID,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    },
  );

  it.each([
    [
      "createGuestInvites",
      "event:createGuestInvites:actor:",
      { guests: [{ name: "Ana", email: "ana@example.com" }] },
    ],
    ["resendGuestInvite", "event:resendGuestInvite:actor:", { inviteId: INVITE_ID }],
  ] as const)(
    "%s: an actor-wide bucket (no event id in the key) refuses before the use case",
    async (procedure, prefix, rest) => {
      const { repos, getOrgMembership } = buildRepos({ membershipRole: "OWNER" });
      const consume = vi.fn(async (key: string) =>
        key.startsWith(prefix)
          ? { allowed: false, remaining: 0, retryAfterSeconds: 60 }
          : { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0 },
      );
      const caller = callerFor(repos, {
        actorHumanId: ORGANIZER_ID,
        rateLimit: { consume } as unknown as Ctx["rateLimit"],
      });
      await expect(
        caller[procedure]({ eventId: EVENT_ID, ...rest }),
      ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
      const keys = consume.mock.calls.map(([key]) => key);
      expect(keys).toContain(`${prefix}${ORGANIZER_ID}`);
      // The per-event bucket is still there, and the actor bucket ignores the event.
      expect(keys.some((k) => k.includes(`:${ORGANIZER_ID}:${EVENT_ID}`))).toBe(true);
      expect(keys.filter((k) => k.startsWith(prefix)).every((k) => !k.includes(EVENT_ID))).toBe(true);
      expect(getOrgMembership).not.toHaveBeenCalled();
    },
  );

  it("requires a session", async () => {
    const { repos } = buildRepos({ membershipRole: "OWNER" });
    await expect(
      callerFor(repos).listInvites({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("an editor reaches the use case: listInvites and DISABLE with nothing live", async () => {
    const { repos } = buildRepos({ membershipRole: "OWNER" });
    const caller = callerFor(repos, signedIn(ORGANIZER_ID));
    await expect(caller.listInvites({ eventId: EVENT_ID })).resolves.toEqual({
      shared: null,
      guests: [],
    });
    await expect(
      caller.setSharedInvite({ eventId: EVENT_ID, action: "DISABLE" }),
    ).resolves.toEqual({ id: null, url: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Signed-in conversion of a th_ei_ grant (R3): the two paths the application
// grant already has.

const MAGIC_LINK_UNLOCK = {
  eventId: EVENT_ID,
  humanId: VIEWER_ID,
  source: "MAGIC_LINK",
  applicationSubmissionId: null,
  inviteId: INVITE_ID,
};

describe("events.recordSignedInviteUnlock", () => {
  const signedInCaller = (repos: Ctx["repos"], cookieHeader: string | null) =>
    callerFor(repos, {
      actorHumanId: VIEWER_ID,
      cookieHeader,
      rateLimit: allowAll() as unknown as Ctx["rateLimit"],
    });

  it("a verified th_ei_ for a live invite → the durable MAGIC_LINK unlock for the SESSION's human", async () => {
    const { repos, eventUnlocks, eventInvites } = buildRepos();
    await expect(
      signedInCaller(repos, inviteCookie()).recordSignedInviteUnlock({ eventId: EVENT_ID }),
    ).resolves.toEqual({
      eventId: EVENT_ID,
      persisted: true,
      outcome: "persisted",
      submissionId: null,
    });
    expect(eventUnlocks.upsert).toHaveBeenCalledWith(MAGIC_LINK_UNLOCK);
    // A SHARED conversion is not a new redemption.
    expect(eventInvites.recordRedemption).not.toHaveBeenCalled();
  });

  it("SHARED reset since → still converts; PERSONAL revoked → persisted:false, nothing written", async () => {
    const shared = buildRepos({
      invite: { kind: "SHARED", revokedAt: new Date(NOW.getTime() - 1000) },
    });
    await expect(
      signedInCaller(shared.repos, inviteCookie()).recordSignedInviteUnlock({ eventId: EVENT_ID }),
    ).resolves.toMatchObject({ persisted: true });

    const personal = buildRepos({
      invite: { kind: "PERSONAL", revokedAt: new Date(NOW.getTime() - 1000) },
    });
    await expect(
      signedInCaller(personal.repos, inviteCookie()).recordSignedInviteUnlock({
        eventId: EVENT_ID,
      }),
    ).resolves.toMatchObject({ persisted: false, outcome: "grant_invalid" });
    expect(personal.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("SHARED removed since → persisted:false, nothing written", async () => {
    const removedAt = new Date(NOW.getTime() - 1000);
    const removed = buildRepos({
      invite: { kind: "SHARED", revokedAt: removedAt, grantsRevokedAt: removedAt },
    });
    await expect(
      signedInCaller(removed.repos, inviteCookie()).recordSignedInviteUnlock({
        eventId: EVENT_ID,
      }),
    ).resolves.toMatchObject({ persisted: false, outcome: "grant_invalid" });
    expect(removed.eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("no cookie, or a forged / other-event one → FORBIDDEN before core runs", async () => {
    const { repos, eventUnlocks } = buildRepos();
    for (const cookie of [
      null,
      inviteCookie({ secret: "w".repeat(40) }),
      inviteCookie({ signedForEventId: OTHER_EVENT_ID }),
    ]) {
      await expect(
        signedInCaller(repos, cookie).recordSignedInviteUnlock({ eventId: EVENT_ID }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", message: "event_invite_grant_required" });
    }
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("refuses a client-supplied grant: the only input is the event id", async () => {
    const { repos, eventUnlocks } = buildRepos();
    const caller = signedInCaller(repos, null);
    for (const extra of [
      { inviteGrant: { inviteId: INVITE_ID, expMs: Date.now() + 60_000 } },
      { inviteId: INVITE_ID },
      { viewerHumanId: ORGANIZER_ID },
    ]) {
      await expect(
        caller.recordSignedInviteUnlock({ eventId: EVENT_ID, ...extra }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    const { repos } = buildRepos();
    await expect(
      callerFor(repos, { cookieHeader: inviteCookie() }).recordSignedInviteUnlock({
        eventId: EVENT_ID,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("orders checkout — invite grant reaching the API", () => {
  const ordersCaller = (repos: Ctx["repos"], cookieHeader: string) =>
    router({ orders: router(ordersRouter) }).createCaller(
      buildBaseCtx({
        repos,
        clock,
        actorHumanId: VIEWER_ID,
        eventUnlockSecret: SECRET,
        cookieHeader,
      }),
    ) as any;
  const holdInput = {
    eventId: EVENT_ID,
    items: [{ ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 1 }],
  };
  const holdResult = {
    order: {
      id: "123e4567-e89b-12d3-a456-426614174000",
      eventId: EVENT_ID,
      buyerHumanId: VIEWER_ID,
      amountGrossCents: 1000,
      feesPlatformCents: 100,
      buyerFeesCents: 100,
      processorFeeCents: 50,
      currency: "usd",
      status: "PENDING",
      items: [],
    },
    holdExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("valid th_ei_: converts to the buyer's durable unlock, then holds tickets", async () => {
    const { repos, eventUnlocks } = buildRepos();
    const spy = vi
      .spyOn(updateOrderItemsModule, "updateOrderItems")
      .mockResolvedValue(holdResult as never);

    await ordersCaller(repos, inviteCookie()).orders.updateOrderItems(holdInput);

    expect(eventUnlocks.upsert).toHaveBeenCalledWith(MAGIC_LINK_UNLOCK);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("PERSONAL revoked: nothing persists and checkout's own gate answers FORBIDDEN", async () => {
    const { repos, eventUnlocks } = buildRepos({
      invite: { kind: "PERSONAL", revokedAt: new Date(NOW.getTime() - 1000) },
    });
    const spy = vi
      .spyOn(updateOrderItemsModule, "updateOrderItems")
      .mockImplementation(async () => fail("FORBIDDEN"));

    await expect(
      ordersCaller(repos, inviteCookie()).orders.updateOrderItems(holdInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("SHARED removed: the checkout conversion writes nothing; checkout's own gate answers", async () => {
    const removedAt = new Date(NOW.getTime() - 1000);
    const { repos, eventUnlocks } = buildRepos({
      invite: { kind: "SHARED", revokedAt: removedAt, grantsRevokedAt: removedAt },
    });
    const spy = vi
      .spyOn(updateOrderItemsModule, "updateOrderItems")
      .mockImplementation(async () => fail("FORBIDDEN"));

    await expect(
      ordersCaller(repos, inviteCookie()).orders.updateOrderItems(holdInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("th_ea_ + th_ei_: the persisted application grant wins; the invite conversion never runs", async () => {
    const submissionId = "70000000-0000-4000-8000-000000000007";
    const reviewedAt = new Date(NOW.getTime() - 60_000);
    const { repos, eventUnlocks, eventInvites } = buildRepos({
      gateType: "APPLICATION",
      invite: { kind: "PERSONAL" },
      approvedSubmission: { id: submissionId, reviewedAt },
    });
    vi.spyOn(updateOrderItemsModule, "updateOrderItems").mockResolvedValue(
      holdResult as never,
    );

    await ordersCaller(
      repos,
      `${applicationGrantCookie(submissionId, reviewedAt.getTime())}; ${inviteCookie()}`,
    ).orders.updateOrderItems(holdInput);

    expect(eventUnlocks.upsert).toHaveBeenCalledTimes(1);
    expect(eventUnlocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ source: "APPLICATION", applicationSubmissionId: submissionId }),
    );
    expect(eventInvites.getById).not.toHaveBeenCalled();
    expect(eventInvites.recordRedemption).not.toHaveBeenCalled();
  });

  it("th_ei_ (revoked PERSONAL) + th_eu_ on a PASSWORD event: falls back to the password path", async () => {
    const { repos, eventUnlocks, eventInvites } = buildRepos({
      invite: { kind: "PERSONAL", revokedAt: new Date(NOW.getTime() - 1000) },
    });
    vi.spyOn(updateOrderItemsModule, "updateOrderItems").mockResolvedValue(
      holdResult as never,
    );

    await ordersCaller(
      repos,
      `${inviteCookie()}; ${passwordCookie()}`,
    ).orders.updateOrderItems(holdInput);

    // The invite was consulted and refused…
    expect(eventInvites.getById).toHaveBeenCalledWith(INVITE_ID);
    expect(eventInvites.recordRedemption).not.toHaveBeenCalled();
    // …so the password cookie persisted the unlock instead.
    expect(eventUnlocks.upsert).toHaveBeenCalledTimes(1);
    expect(eventUnlocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ source: "PASSWORD", humanId: VIEWER_ID }),
    );
  });

  it("a forged th_ei_ is never converted", async () => {
    const { repos, eventUnlocks, eventInvites } = buildRepos();
    vi.spyOn(updateOrderItemsModule, "updateOrderItems").mockImplementation(
      async () => fail("FORBIDDEN"),
    );
    await expect(
      ordersCaller(repos, inviteCookie({ secret: "v".repeat(40) })).orders.updateOrderItems(
        holdInput,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
    expect(eventInvites.getById).not.toHaveBeenCalled();
  });
});
