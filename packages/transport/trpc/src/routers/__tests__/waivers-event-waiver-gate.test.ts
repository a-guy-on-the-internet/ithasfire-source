import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { waiversRouter } from "../waivers";
import { createCaller } from "./test-helpers";

/**
 * `waivers.getEventWaiver` is part of the event page, so a PASSWORD /
 * APPLICATION event's waiver goes only to a viewer past its gate (the same
 * full-read gate as `listEventTicketTypes` and `getCheckoutFeeRates`). The
 * embed widget calls it anonymously with no cookies, so for a gated event it
 * is refused.
 *
 * It is an `optionalProcedure`: a signed-in buyer whose standing is a durable
 * `EventUnlock` (no cookie) must still get the waiver, or the main-site
 * checkout silently shows none and the purchase fails WAIVER_REQUIRED. The
 * session arrives here as a TOKEN resolved through `authn`, never as a
 * pre-set actor, so a `publicProcedure` (which never resolves one) fails it.
 *
 * Through the REAL router, gate use case and waiver use case; only the repos
 * and `authn` are fakes.
 */

const SECRET = "event-unlock-secret-with-at-least-32-chars";
const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const TEMPLATE_ID = "55555555-5555-4555-8555-555555555555";

const WAIVER = {
  id: TEMPLATE_ID,
  name: "Members waiver",
  body: "You agree to the secret-room house rules.",
  version: 3,
};

/** `th_eu_<eventId>`, the password unlock cookie. */
const passwordCookie = (): string => {
  const exp = Date.now() + 60_000;
  const sig = createHmac("sha256", SECRET)
    .update(`${EVENT_ID}|${exp}`)
    .digest("base64url");
  return `th_eu_${EVENT_ID}=${exp}.${sig}`;
};

const buildRepos = (gateType: "NONE" | "PASSWORD" | "APPLICATION") => {
  const event = {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    gateType,
    visibility: "PUBLIC",
    status: "PUBLISHED",
    publishedAt: new Date("2025-12-01T00:00:00.000Z"),
    stewardship: "OWNED",
    passwordHash: "set",
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    waiverTemplateId: TEMPLATE_ID,
    slug: "members-night",
  };
  const isUnlocked = vi.fn(
    async (_eventId: string, humanId: string) => humanId === VIEWER_ID,
  );
  const getTemplate = vi.fn(async () => ({ ...WAIVER, orgId: ORG_ID }));
  const repos = {
    events: {
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)),
    },
    authz: { getOrgMembership: vi.fn(async () => null) },
    eventUnlocks: { isUnlocked },
    eventApplications: { getSubmissionById: vi.fn(async () => null) },
    eventInvites: { getById: vi.fn(async () => null) },
    waiverTemplates: { getById: getTemplate },
  };
  return { repos: repos as unknown as Ctx["repos"], isUnlocked, getTemplate };
};

const anonymous = (repos: Ctx["repos"], cookieHeader: string | null) => ({
  repos,
  actorHumanId: null,
  auth: null,
  authToken: null,
  eventUnlockSecret: SECRET,
  cookieHeader,
});

/** A signed-in request: a bearer token that `authn` resolves to VIEWER_ID. */
const signedIn = (repos: Ctx["repos"]) => ({
  repos,
  actorHumanId: null,
  auth: null,
  authToken: "session-token",
  authn: {
    getProviderUserId: vi.fn(async () => ({
      providerUserId: "provider-user-1",
      sessionId: undefined,
    })),
    ensureAuthedHuman: vi.fn(async () => ({ humanId: VIEWER_ID })),
  } as unknown as Ctx["authn"],
  eventUnlockSecret: SECRET,
  cookieHeader: null,
});

describe("waivers.getEventWaiver — the event's gate applies", () => {
  it.each(["PASSWORD", "APPLICATION"] as const)(
    "an anonymous viewer of a %s event (the embed) is refused, and no waiver is read",
    async (gateType) => {
      const { repos, getTemplate } = buildRepos(gateType);
      const { caller } = createCaller(waiversRouter, anonymous(repos, null));

      await expect(
        caller.getEventWaiver({ eventId: EVENT_ID }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(getTemplate).not.toHaveBeenCalled();
    },
  );

  it("an ungated event's waiver is served to an anonymous viewer (the embed)", async () => {
    const { repos } = buildRepos("NONE");
    const { caller } = createCaller(waiversRouter, anonymous(repos, null));

    await expect(caller.getEventWaiver({ eventId: EVENT_ID })).resolves.toEqual(
      { waiver: WAIVER },
    );
  });

  it("a valid password cookie opens a PASSWORD event's waiver", async () => {
    const { repos } = buildRepos("PASSWORD");
    const { caller } = createCaller(
      waiversRouter,
      anonymous(repos, passwordCookie()),
    );

    await expect(caller.getEventWaiver({ eventId: EVENT_ID })).resolves.toEqual(
      { waiver: WAIVER },
    );
  });

  it("a signed-in buyer with a durable unlock gets an APPLICATION event's waiver (main-site checkout)", async () => {
    const { repos, isUnlocked } = buildRepos("APPLICATION");
    const { caller } = createCaller(waiversRouter, signedIn(repos));

    await expect(caller.getEventWaiver({ eventId: EVENT_ID })).resolves.toEqual(
      { waiver: WAIVER },
    );
    expect(isUnlocked).toHaveBeenCalledWith(EVENT_ID, VIEWER_ID);
  });
});
