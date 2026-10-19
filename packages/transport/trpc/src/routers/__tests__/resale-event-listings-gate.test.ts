import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type { Ctx } from "../../context";
import { resaleRouter } from "../resale";
import { createCaller } from "./test-helpers";

/**
 * `resale.listEventListings` is behind the event's gate (owner ruling
 * 2026-10-13: a PASSWORD / APPLICATION event's resale listings are hidden
 * from viewers who haven't been let in). The event page section and the
 * owner's admin resale page both call it.
 *
 * It is an `optionalProcedure`: a signed-in viewer's durable `EventUnlock`
 * and an owner member's role arrive as a session TOKEN resolved through
 * `authn`, never as a pre-set actor, so a `publicProcedure` (which never
 * resolves one) would refuse them.
 *
 * Through the REAL router and gate use case; only the repos and `authn` are
 * fakes.
 */

const SECRET = "event-unlock-secret-with-at-least-32-chars";
const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_HUMAN_ID = "44444444-4444-4444-8444-444444444444";
const UNRELATED_HUMAN_ID = "55555555-5555-4555-8555-555555555555";
const UNLOCKED_ID = "11111111-1111-4111-8111-111111111111";
const STRANGER_ID = "66666666-6666-4666-8666-666666666666";
const EDITOR_ID = "77777777-7777-4777-8777-777777777777";
const ORG_VIEWER_ID = "88888888-8888-4888-8888-888888888888";
/** An EDITOR, but of another org. */
const OTHER_ORG_EDITOR_ID = "99999999-9999-4999-8999-999999999999";
/** A VIEWER delegate of OWNER_HUMAN_ID. */
const OWNER_DELEGATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** An EDITOR delegate of UNRELATED_HUMAN_ID, nothing to the owner. */
const UNRELATED_DELEGATE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const LISTINGS = {
  items: [
    {
      id: "90000000-0000-4000-8000-000000000009",
      ticketId: "91000000-0000-4000-8000-000000000009",
      eventId: EVENT_ID,
      askPriceCents: 4500,
      processingPassThroughCents: 0,
      currency: "usd",
      status: "ACTIVE",
      expiresAt: null,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      ticketTypeName: "General",
      facePriceCents: 4000,
      sectionName: null,
      sectionId: null,
      seatLabel: null,
      seatRow: null,
      seatNumber: null,
    },
  ],
  pageInfo: { total: 1 },
};

/** `th_eu_<eventId>`, the password unlock cookie. */
const passwordCookie = (): string => {
  const exp = Date.now() + 60_000;
  const sig = createHmac("sha256", SECRET)
    .update(`${EVENT_ID}|${exp}`)
    .digest("base64url");
  return `th_eu_${EVENT_ID}=${exp}.${sig}`;
};

const buildRepos = (
  gateType: "NONE" | "PASSWORD" | "APPLICATION",
  opts: { owner?: "org" | "human"; ownerBanned?: boolean } = {},
) => {
  const humanOwned = opts.owner === "human";
  const event = {
    id: EVENT_ID,
    orgId: humanOwned ? null : ORG_ID,
    humanId: humanOwned ? OWNER_HUMAN_ID : null,
    ownerBanned: opts.ownerBanned ?? false,
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
    slug: "members-night",
  };
  const isUnlocked = vi.fn(
    async (_eventId: string, humanId: string) => humanId === UNLOCKED_ID,
  );
  // Keyed on org AND human: a role in another org is no role here.
  const getOrgMembership = vi.fn(
    async ({ orgId, humanId }: { orgId: string; humanId: string }) => {
      if (orgId === ORG_ID && humanId === EDITOR_ID) return { role: "EDITOR" };
      if (orgId === ORG_ID && humanId === ORG_VIEWER_ID) {
        return { role: "VIEWER" };
      }
      if (orgId === OTHER_ORG_ID && humanId === OTHER_ORG_EDITOR_ID) {
        return { role: "EDITOR" };
      }
      return null;
    },
  );
  // Keyed on principal AND delegate.
  const getHumanDelegation = vi.fn(
    async ({
      principalId,
      delegateId,
    }: {
      principalId: string;
      delegateId: string;
    }) => {
      if (principalId === OWNER_HUMAN_ID && delegateId === OWNER_DELEGATE_ID) {
        return { role: "VIEWER" };
      }
      if (
        principalId === UNRELATED_HUMAN_ID &&
        delegateId === UNRELATED_DELEGATE_ID
      ) {
        return { role: "EDITOR" };
      }
      return null;
    },
  );
  const listByEventEnriched = vi.fn(async () => LISTINGS);
  const repos = {
    events: {
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)),
    },
    authz: { getOrgMembership, getHumanDelegation },
    eventUnlocks: { isUnlocked },
    eventApplications: { getSubmissionById: vi.fn(async () => null) },
    eventInvites: { getById: vi.fn(async () => null) },
    resaleListings: { listByEventEnriched },
  };
  return {
    repos: repos as unknown as Ctx["repos"],
    isUnlocked,
    listByEventEnriched,
  };
};

const anonymous = (repos: Ctx["repos"], cookieHeader: string | null) => ({
  repos,
  actorHumanId: null,
  auth: null,
  authToken: null,
  eventUnlockSecret: SECRET,
  cookieHeader,
});

/** A signed-in request: a bearer token that `authn` resolves to `humanId`. */
const signedIn = (repos: Ctx["repos"], humanId: string) => ({
  repos,
  actorHumanId: null,
  auth: null,
  authToken: "session-token",
  authn: {
    getProviderUserId: vi.fn(async () => ({
      providerUserId: "provider-user-1",
      sessionId: undefined,
    })),
    ensureAuthedHuman: vi.fn(async () => ({ humanId })),
  } as unknown as Ctx["authn"],
  eventUnlockSecret: SECRET,
  cookieHeader: null,
});

const served = expect.objectContaining({
  total: 1,
  items: [expect.objectContaining({ askPriceCents: 4500 })],
});

describe("resale.listEventListings — the event's gate applies", () => {
  it.each([
    ["PASSWORD", "event_password_required"],
    ["APPLICATION", "event_application_required"],
  ] as const)(
    "an anonymous viewer of a %s event is refused (%s), and no listing is read",
    async (gateType, message) => {
      const { repos, listByEventEnriched } = buildRepos(gateType);
      const { caller } = createCaller(resaleRouter, anonymous(repos, null));

      await expect(
        caller.listEventListings({ eventId: EVENT_ID }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", message });
      expect(listByEventEnriched).not.toHaveBeenCalled();
    },
  );

  it("a signed-in viewer who was never let in (e.g. holds a resold ticket) is refused", async () => {
    const { repos, listByEventEnriched } = buildRepos("APPLICATION");
    const { caller } = createCaller(resaleRouter, signedIn(repos, STRANGER_ID));

    await expect(
      caller.listEventListings({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(listByEventEnriched).not.toHaveBeenCalled();
  });

  it("an ungated event's listings are served to an anonymous viewer", async () => {
    const { repos } = buildRepos("NONE");
    const { caller } = createCaller(resaleRouter, anonymous(repos, null));

    await expect(caller.listEventListings({ eventId: EVENT_ID })).resolves.toEqual(
      served,
    );
  });

  it("a valid password cookie opens a PASSWORD event's listings", async () => {
    const { repos } = buildRepos("PASSWORD");
    const { caller } = createCaller(
      resaleRouter,
      anonymous(repos, passwordCookie()),
    );

    await expect(caller.listEventListings({ eventId: EVENT_ID })).resolves.toEqual(
      served,
    );
  });

  it("a signed-in viewer with a durable unlock gets an APPLICATION event's listings", async () => {
    const { repos, isUnlocked } = buildRepos("APPLICATION");
    const { caller } = createCaller(resaleRouter, signedIn(repos, UNLOCKED_ID));

    await expect(caller.listEventListings({ eventId: EVENT_ID })).resolves.toEqual(
      served,
    );
    expect(isUnlocked).toHaveBeenCalledWith(EVENT_ID, UNLOCKED_ID);
  });

  it.each([
    ["an editor (gate bypass)", EDITOR_ID],
    ["a VIEWER-role member (the admin resale page)", ORG_VIEWER_ID],
  ])(
    "%s of the owning org gets a gated event's listings",
    async (_label, humanId) => {
      const { repos } = buildRepos("APPLICATION");
      const { caller } = createCaller(resaleRouter, signedIn(repos, humanId));

      await expect(
        caller.listEventListings({ eventId: EVENT_ID }),
      ).resolves.toEqual(served);
    },
  );

  it("a VIEWER-role member of the owning org gets a PASSWORD event's listings", async () => {
    const { repos } = buildRepos("PASSWORD");
    const { caller } = createCaller(resaleRouter, signedIn(repos, ORG_VIEWER_ID));

    await expect(caller.listEventListings({ eventId: EVENT_ID })).resolves.toEqual(
      served,
    );
  });

  it("a VIEWER-role member gets the listings of a gated event whose owner is banned (the admin page)", async () => {
    const { repos } = buildRepos("APPLICATION", { ownerBanned: true });
    const { caller } = createCaller(resaleRouter, signedIn(repos, ORG_VIEWER_ID));

    await expect(caller.listEventListings({ eventId: EVENT_ID })).resolves.toEqual(
      served,
    );
  });

  it("a stranger asking for a banned owner's event gets the gate's not-found, as before", async () => {
    const { repos, listByEventEnriched } = buildRepos("APPLICATION", {
      ownerBanned: true,
    });
    const { caller } = createCaller(resaleRouter, signedIn(repos, STRANGER_ID));

    await expect(
      caller.listEventListings({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(listByEventEnriched).not.toHaveBeenCalled();
  });

  it("an EDITOR of ANOTHER org is refused, and no listing is read", async () => {
    const { repos, listByEventEnriched } = buildRepos("APPLICATION");
    const { caller } = createCaller(
      resaleRouter,
      signedIn(repos, OTHER_ORG_EDITOR_ID),
    );

    await expect(
      caller.listEventListings({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "event_application_required",
    });
    expect(listByEventEnriched).not.toHaveBeenCalled();
  });

  it("a human owner's VIEWER delegate gets a gated event's listings (as an org VIEWER would)", async () => {
    const { repos } = buildRepos("APPLICATION", { owner: "human" });
    const { caller } = createCaller(
      resaleRouter,
      signedIn(repos, OWNER_DELEGATE_ID),
    );

    await expect(caller.listEventListings({ eventId: EVENT_ID })).resolves.toEqual(
      served,
    );
  });

  it("a delegate of an UNRELATED human is refused, and no listing is read", async () => {
    const { repos, listByEventEnriched } = buildRepos("APPLICATION", {
      owner: "human",
    });
    const { caller } = createCaller(
      resaleRouter,
      signedIn(repos, UNRELATED_DELEGATE_ID),
    );

    await expect(
      caller.listEventListings({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "event_application_required",
    });
    expect(listByEventEnriched).not.toHaveBeenCalled();
  });
});
