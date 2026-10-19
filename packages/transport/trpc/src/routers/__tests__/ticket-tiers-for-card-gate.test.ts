import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { makeTicketCapacityUsageFake } from "@th/test-utils/fakes/ticket-capacity";

import type { Ctx } from "../../context";
import {
  ensureFullEventReadAccessByEventId,
  hasFullEventReadAccessByEventId,
} from "../../event-read-access";
import { eventsRouter } from "../events";
import { buildBaseCtx, createCaller } from "./test-helpers";

/**
 * `events.ticketTiersForCard` is the hover teaser behind an event card, and a
 * card cannot know its event is gated. A viewer who fails the gate is answered
 * `{ tiers: [] }` (HTTP 200) instead of FORBIDDEN, so a hover stops logging a
 * console error. The gate itself is unchanged: the same decision runs, a
 * failing viewer gets no tier data and no tier read happens, and every other
 * read behind the gate still refuses.
 *
 * Through the REAL router, the REAL gate use case and the REAL tier use case;
 * only the repos are fakes.
 */

const SECRET = "event-unlock-secret-with-at-least-32-chars";
const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const TT_GA = "33333333-3333-4333-8333-333333333333";
const TT_VIP = "44444444-4444-4444-8444-444444444444";
const FEE_POLICY_ID = "66666666-6666-4666-8666-666666666666";
const APPROVED_AT_MS = 1764936000123;

/** `th_ea_<eventId>` v2, as the web signs it (see application-grant.test.ts). */
const grantCookie = (): string => {
  const exp = String(Date.now() + 60_000);
  const sig = createHmac("sha256", SECRET)
    .update(`th_ea|v2|${EVENT_ID}|${SUBMISSION_ID}|${APPROVED_AT_MS}|${exp}`)
    .digest("base64url");
  return `th_ea_${EVENT_ID}=${SUBMISSION_ID}.${APPROVED_AT_MS}.${exp}.${sig}`;
};

/** `th_eu_<eventId>`, the password unlock cookie. */
const passwordCookie = (): string => {
  const exp = Date.now() + 60_000;
  const sig = createHmac("sha256", SECRET)
    .update(`${EVENT_ID}|${exp}`)
    .digest("base64url");
  return `th_eu_${EVENT_ID}=${exp}.${sig}`;
};

const ticketType = (id: string, name: string, priceCents: number) => ({
  id,
  name,
  description: null,
  priceCents,
  pricingMode: "FIXED",
  minimumCents: null,
  suggestedCents: null,
  capacity: 100,
  status: "ACTIVE",
  seatSectionId: null,
  resaleAllowed: false,
  resaleCapCents: null,
  transferAllowed: true,
});

// A zero-fee policy and a stamped 0% tax rate, so buyer total == face and the
// expected tiers below are readable (same fixture idea as core's
// ticket-tiers-for-card.test.ts).
const feePolicy = {
  id: FEE_POLICY_ID,
  scopeType: "ORG",
  scopeId: ORG_ID,
  status: "ACTIVE",
  version: 1,
  effectiveFrom: new Date("2025-01-01T00:00:00.000Z"),
  effectiveTo: null,
  buyerFeePct: 0,
  maxFeeCents: null,
  minFeeCents: 0,
  platformFixedCents: 0,
  feeMode: "PASS_THROUGH",
  processsorFeePct: 0,
  processorFixedCents: 0,
  payoutPct: 0.9,
  payoutFixedCents: 0,
  monthlyPayoutCents: 0,
};

const REAL_TIERS = {
  tiers: [
    {
      id: TT_GA,
      name: "GA",
      buyerTotalCents: 2500,
      faceCents: 2500,
      soldOut: false,
      onSale: true,
    },
    {
      id: TT_VIP,
      name: "VIP",
      buyerTotalCents: 5000,
      faceCents: 5000,
      soldOut: false,
      onSale: true,
    },
  ],
};

const buildRepos = (
  opts: {
    gateType?: "NONE" | "PASSWORD" | "APPLICATION";
    isUnlocked?: boolean;
    getById?: () => Promise<unknown>;
  } = {},
) => {
  const event = {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    gateType: opts.gateType ?? "APPLICATION",
    visibility: "PUBLIC",
    status: "PUBLISHED",
    publishedAt: new Date("2025-12-01T00:00:00.000Z"),
    stewardship: "OWNED",
    passwordHash: "set",
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    slug: "secret",
    admissionTaxRateBps: 0,
  };
  const getById = vi.fn(
    opts.getById ?? (async (id: string) => (id === EVENT_ID ? event : null)),
  );
  const listTicketTypes = vi.fn(async () => [
    ticketType(TT_VIP, "VIP", 5000),
    ticketType(TT_GA, "GA", 2500),
  ]);
  const feePolicies = {
    getById: vi.fn(async () => feePolicy),
    resolveEffective: vi.fn(async (args: { scopeType: string }) =>
      args.scopeType === "ORG" ? feePolicy : null,
    ),
  };
  const payoutTerms = {
    listByEvent: vi.fn(async () => []),
    listLines: vi.fn(async () => []),
  };
  const repos = {
    events: { getById, listTicketTypes },
    authz: { getOrgMembership: vi.fn(async () => null) },
    eventUnlocks: { isUnlocked: vi.fn(async () => opts.isUnlocked ?? false) },
    eventApplications: {
      getSubmissionById: vi.fn(async (id: string) =>
        id === SUBMISSION_ID
          ? {
              id: SUBMISSION_ID,
              formId: "form-attend",
              purpose: "ATTEND",
              eventId: EVENT_ID,
              humanId: null,
              contactEmail: "guest@example.com",
              status: "APPROVED",
              reviewedAt: new Date(APPROVED_AT_MS),
            }
          : null,
      ),
    },
    eventInvites: { getById: vi.fn(async () => null) },
    ...makeTicketCapacityUsageFake({}),
    payoutTerms,
    feePolicies,
  };
  return {
    repos: repos as unknown as Ctx["repos"],
    getById,
    listTicketTypes,
    feePolicies,
    payoutTerms,
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

describe("events.ticketTiersForCard — a gate-failing viewer gets an empty answer", () => {
  it("APPLICATION gate, no grant → { tiers: [] } and no tier read", async () => {
    const { repos, listTicketTypes, feePolicies, payoutTerms } = buildRepos({
      gateType: "APPLICATION",
    });
    const { caller } = createCaller(eventsRouter, anonymous(repos, null));

    await expect(
      caller.ticketTiersForCard({ eventId: EVENT_ID }),
    ).resolves.toEqual({ tiers: [] });

    expect(listTicketTypes).not.toHaveBeenCalled();
    expect(feePolicies.resolveEffective).not.toHaveBeenCalled();
    expect(payoutTerms.listByEvent).not.toHaveBeenCalled();
  });

  it("PASSWORD gate, no cookie → { tiers: [] } and no tier read", async () => {
    const { repos, listTicketTypes, feePolicies, payoutTerms } = buildRepos({
      gateType: "PASSWORD",
    });
    const { caller } = createCaller(eventsRouter, anonymous(repos, null));

    await expect(
      caller.ticketTiersForCard({ eventId: EVENT_ID }),
    ).resolves.toEqual({ tiers: [] });

    expect(listTicketTypes).not.toHaveBeenCalled();
    expect(feePolicies.resolveEffective).not.toHaveBeenCalled();
    expect(payoutTerms.listByEvent).not.toHaveBeenCalled();
  });

  it("a grant for the OTHER gate type is still a failing viewer → empty", async () => {
    // A password cookie never opens an APPLICATION gate.
    const { repos, listTicketTypes } = buildRepos({ gateType: "APPLICATION" });
    const { caller } = createCaller(
      eventsRouter,
      anonymous(repos, passwordCookie()),
    );

    await expect(
      caller.ticketTiersForCard({ eventId: EVENT_ID }),
    ).resolves.toEqual({ tiers: [] });
    expect(listTicketTypes).not.toHaveBeenCalled();
  });

  it("a signed-in viewer with no unlock is a failing viewer too → empty", async () => {
    const { repos, listTicketTypes } = buildRepos({ gateType: "PASSWORD" });
    const { caller } = createCaller(eventsRouter, {
      repos,
      actorHumanId: VIEWER_ID,
      eventUnlockSecret: SECRET,
      cookieHeader: null,
    });

    await expect(
      caller.ticketTiersForCard({ eventId: EVENT_ID }),
    ).resolves.toEqual({ tiers: [] });
    expect(listTicketTypes).not.toHaveBeenCalled();
  });
});

describe("events.ticketTiersForCard — a viewer who passes the gate gets tiers as before", () => {
  it("APPLICATION gate + valid application grant → real tiers", async () => {
    const { repos, listTicketTypes } = buildRepos({ gateType: "APPLICATION" });
    const { caller } = createCaller(
      eventsRouter,
      anonymous(repos, grantCookie()),
    );

    await expect(
      caller.ticketTiersForCard({ eventId: EVENT_ID }),
    ).resolves.toEqual(REAL_TIERS);
    expect(listTicketTypes).toHaveBeenCalledWith(EVENT_ID);
  });

  it("PASSWORD gate + valid password cookie → real tiers", async () => {
    const { repos } = buildRepos({ gateType: "PASSWORD" });
    const { caller } = createCaller(
      eventsRouter,
      anonymous(repos, passwordCookie()),
    );

    await expect(
      caller.ticketTiersForCard({ eventId: EVENT_ID }),
    ).resolves.toEqual(REAL_TIERS);
  });

  it("signed-in viewer with a durable unlock → real tiers", async () => {
    const { repos } = buildRepos({ gateType: "APPLICATION", isUnlocked: true });
    const { caller } = createCaller(eventsRouter, {
      repos,
      actorHumanId: VIEWER_ID,
      eventUnlockSecret: SECRET,
      cookieHeader: null,
    });

    await expect(
      caller.ticketTiersForCard({ eventId: EVENT_ID }),
    ).resolves.toEqual(REAL_TIERS);
  });

  it("ungated event → real tiers", async () => {
    const { repos } = buildRepos({ gateType: "NONE" });
    const { caller } = createCaller(eventsRouter, anonymous(repos, null));

    await expect(
      caller.ticketTiersForCard({ eventId: EVENT_ID }),
    ).resolves.toEqual(REAL_TIERS);
  });
});

describe("events.ticketTiersForCard — a failed gate read is never answered as empty", () => {
  it("the gate's event read throws → the call rejects", async () => {
    const { repos, listTicketTypes } = buildRepos({
      getById: async () => {
        throw new Error("db down");
      },
    });
    const { caller } = createCaller(eventsRouter, anonymous(repos, null));

    await expect(
      caller.ticketTiersForCard({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(listTicketTypes).not.toHaveBeenCalled();
  });

  it("an event the viewer may not read at all is still NOT_FOUND", async () => {
    const { repos } = buildRepos({ getById: async () => null });
    const { caller } = createCaller(eventsRouter, anonymous(repos, null));

    await expect(
      caller.ticketTiersForCard({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the gate everywhere else is unchanged", () => {
  it("ensureFullEventReadAccessByEventId throws the identical error value", async () => {
    const application = buildRepos({ gateType: "APPLICATION" });
    await expect(
      ensureFullEventReadAccessByEventId(
        buildBaseCtx(anonymous(application.repos, null)),
        EVENT_ID,
      ),
    ).rejects.toStrictEqual({
      code: "forbidden",
      message: "event_application_required",
    });

    const password = buildRepos({ gateType: "PASSWORD" });
    await expect(
      ensureFullEventReadAccessByEventId(
        buildBaseCtx(anonymous(password.repos, null)),
        EVENT_ID,
      ),
    ).rejects.toStrictEqual({
      code: "forbidden",
      message: "event_password_required",
    });
  });

  it("hasFullEventReadAccessByEventId agrees with it, case by case", async () => {
    const has = (
      gateType: "NONE" | "PASSWORD" | "APPLICATION",
      cookieHeader: string | null,
    ) =>
      hasFullEventReadAccessByEventId(
        buildBaseCtx(anonymous(buildRepos({ gateType }).repos, cookieHeader)),
        EVENT_ID,
      );

    await expect(has("NONE", null)).resolves.toBe(true);
    await expect(has("PASSWORD", null)).resolves.toBe(false);
    await expect(has("PASSWORD", passwordCookie())).resolves.toBe(true);
    await expect(has("PASSWORD", grantCookie())).resolves.toBe(false);
    await expect(has("APPLICATION", null)).resolves.toBe(false);
    await expect(has("APPLICATION", grantCookie())).resolves.toBe(true);
    await expect(has("APPLICATION", passwordCookie())).resolves.toBe(false);
  });

  it("the sibling ticket-type read still refuses a gate-failing viewer", async () => {
    const { repos, listTicketTypes } = buildRepos({ gateType: "APPLICATION" });
    const { caller } = createCaller(eventsRouter, anonymous(repos, null));

    await expect(
      caller.listEventTicketTypes({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "event_application_required",
    });
    expect(listTicketTypes).not.toHaveBeenCalled();
  });
});
