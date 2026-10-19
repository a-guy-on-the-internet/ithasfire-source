import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as updateOrderItemsModule from "@th/core/use-cases/orders/update-order-items";
import { fail } from "@th/errors";

import { router } from "../../trpc";
import { router as trpcRouter } from "../../init";
import type { Ctx } from "../../context";
import { ensureFullEventReadAccessByEventId } from "../../event-read-access";
import {
  hasEventUnlockCookie,
  readEventApplicationGrantCookie,
  verifyEventUnlockCookie,
} from "../../event-unlock-cookie";
import { eventsRouter } from "../events";
import { ordersRouter } from "../orders";
import { buildBaseCtx, createCaller } from "./test-helpers";

/**
 * The APPLICATION grant (`th_ea_<eventId>`): an anonymous approved applicant's
 * revocable way through an APPLICATION gate. The transport checks the HMAC;
 * core requires the named submission to belong to the event and be APPROVED
 * under the same approval (`reviewedAt` === the grant's `approvedAtMs`).
 */

const SECRET = "event-unlock-secret-with-at-least-32-chars";
const EVENT_ID = "40000000-0000-4000-8000-000000000004";
const OTHER_EVENT_ID = "40000000-0000-4000-8000-00000000000a";
const SUBMISSION_ID = "70000000-0000-4000-8000-000000000007";
const BUYER_ID = "11111111-1111-4111-8111-111111111111";
/** `reviewedAt` of the approval the golden grant was issued under. */
const APPROVED_AT_MS = 1764936000123;
const APPROVED_AT = new Date(APPROVED_AT_MS);
const GRANT = { submissionId: SUBMISSION_ID, approvedAtMs: APPROVED_AT_MS };

/**
 * Golden vector shared with `apps/web/src/lib/__tests__/event-unlock-cookie.test.ts`
 * (the web SIGNS, the API VERIFIES — two implementations, one format).
 * v2: `<submissionId>.<approvedAtMs>.<expMs>.<sig>`.
 */
const GOLDEN_COOKIE = `th_ea_${EVENT_ID}=${SUBMISSION_ID}.${APPROVED_AT_MS}.4102444800000.ofUph3shHCaisM2M2ZnLmfdpWzXlv93iXBvdly5VV5U`;
/** The pre-v2 golden vector (no approval stamp). Must no longer verify. */
const V1_GOLDEN_COOKIE = `th_ea_${EVENT_ID}=${SUBMISSION_ID}.4102444800000.4RtJbjQjJ_MTvIPkMaonRHl6t8XpDLSK_Xr0vwTc-DY`;

const grantCookie = (
  opts: {
    eventId?: string;
    signedForEventId?: string;
    submissionId?: string;
    approvedAtMs?: number;
    exp?: number;
    secret?: string;
  } = {},
): string => {
  const eventId = opts.eventId ?? EVENT_ID;
  const submissionId = opts.submissionId ?? SUBMISSION_ID;
  const approvedAtMs = opts.approvedAtMs ?? APPROVED_AT_MS;
  const exp = String(opts.exp ?? Date.now() + 60_000);
  const sig = createHmac("sha256", opts.secret ?? SECRET)
    .update(
      `th_ea|v2|${opts.signedForEventId ?? eventId}|${submissionId}|${approvedAtMs}|${exp}`,
    )
    .digest("base64url");
  return `th_ea_${eventId}=${submissionId}.${approvedAtMs}.${exp}.${sig}`;
};

const passwordCookie = (eventId = EVENT_ID): string => {
  const exp = Date.now() + 60_000;
  const sig = createHmac("sha256", SECRET)
    .update(`${eventId}|${exp}`)
    .digest("base64url");
  return `th_eu_${eventId}=${exp}.${sig}`;
};

const cookieCtx = (cookieHeader: string | null, secret: string | null = SECRET) => ({
  cookieHeader,
  eventUnlockSecret: secret,
});

describe("readEventApplicationGrantCookie", () => {
  it("accepts the web-signed golden vector and returns its submissionId + approval stamp", () => {
    expect(
      readEventApplicationGrantCookie(cookieCtx(GOLDEN_COOKIE), EVENT_ID),
    ).toEqual(GRANT);
  });

  it("rejects a v1 grant (no approval stamp) — it fails closed", () => {
    expect(
      readEventApplicationGrantCookie(cookieCtx(V1_GOLDEN_COOKIE), EVENT_ID),
    ).toBeNull();
    // Re-signed v1 bytes under the v2 cookie shape still fail: the tag differs.
    const exp = String(Date.now() + 60_000);
    const v1Sig = createHmac("sha256", SECRET)
      .update(`th_ea|v1|${EVENT_ID}|${SUBMISSION_ID}|${exp}`)
      .digest("base64url");
    expect(
      readEventApplicationGrantCookie(
        cookieCtx(`th_ea_${EVENT_ID}=${SUBMISSION_ID}.${APPROVED_AT_MS}.${exp}.${v1Sig}`),
        EVENT_ID,
      ),
    ).toBeNull();
  });

  it("rejects a swapped approval stamp (signature covers it)", () => {
    const swapped = grantCookie().replace(
      `.${APPROVED_AT_MS}.`,
      `.${APPROVED_AT_MS + 1}.`,
    );
    expect(readEventApplicationGrantCookie(cookieCtx(swapped), EVENT_ID)).toBeNull();
  });

  it("accepts a freshly signed grant among other cookies", () => {
    expect(
      readEventApplicationGrantCookie(
        cookieCtx(`th-theme=dark; ${grantCookie()}; th_consent=1`),
        EVENT_ID,
      ),
    ).toEqual(GRANT);
  });

  it("rejects a tampered signature", () => {
    const tampered = grantCookie().replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    expect(readEventApplicationGrantCookie(cookieCtx(tampered), EVENT_ID)).toBeNull();
  });

  it("rejects a swapped submissionId (signature covers it)", () => {
    const swapped = grantCookie().replace(
      SUBMISSION_ID,
      "70000000-0000-4000-8000-0000000000ff",
    );
    expect(readEventApplicationGrantCookie(cookieCtx(swapped), EVENT_ID)).toBeNull();
  });

  it("rejects an expired grant", () => {
    expect(
      readEventApplicationGrantCookie(
        cookieCtx(grantCookie({ exp: Date.now() - 1 })),
        EVENT_ID,
      ),
    ).toBeNull();
  });

  it("rejects a grant signed for another event, even under this event's cookie name", () => {
    expect(
      readEventApplicationGrantCookie(
        cookieCtx(grantCookie({ signedForEventId: OTHER_EVENT_ID })),
        EVENT_ID,
      ),
    ).toBeNull();
    // …and a genuine grant for event A is not read for event B at all.
    expect(
      readEventApplicationGrantCookie(cookieCtx(grantCookie()), OTHER_EVENT_ID),
    ).toBeNull();
  });

  it("rejects a grant signed with a different secret", () => {
    expect(
      readEventApplicationGrantCookie(
        cookieCtx(grantCookie({ secret: "x".repeat(40) })),
        EVENT_ID,
      ),
    ).toBeNull();
  });

  it("returns null without a usable secret", () => {
    expect(readEventApplicationGrantCookie(cookieCtx(grantCookie(), null), EVENT_ID)).toBeNull();
    expect(readEventApplicationGrantCookie(cookieCtx(grantCookie(), "short"), EVENT_ID)).toBeNull();
  });

  it("never mistakes a password cookie for a grant, nor a grant for a password cookie", () => {
    // A password cookie's value moved under the grant's name.
    const pwValue = passwordCookie().split("=")[1];
    expect(
      readEventApplicationGrantCookie(cookieCtx(`th_ea_${EVENT_ID}=${pwValue}`), EVENT_ID),
    ).toBeNull();
    // A grant's value moved under the password cookie's name.
    const grantValue = grantCookie().split("=")[1];
    const ctx = buildBaseCtx({
      eventUnlockSecret: SECRET,
      cookieHeader: `th_eu_${EVENT_ID}=${grantValue}`,
    });
    expect(verifyEventUnlockCookie(ctx, EVENT_ID)).toBe(false);
    // And the genuine grant alone does not satisfy the password check.
    expect(
      verifyEventUnlockCookie(
        buildBaseCtx({ eventUnlockSecret: SECRET, cookieHeader: grantCookie() }),
        EVENT_ID,
      ),
    ).toBe(false);
  });

  it("hasEventUnlockCookie counts a grant, so it keeps the request off shared caches", () => {
    expect(hasEventUnlockCookie(`th-theme=dark; ${grantCookie()}`)).toBe(true);
    expect(hasEventUnlockCookie("th-theme=dark; th_consent=1")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

type SubmissionStatus =
  | "APPROVED"
  | "PENDING"
  | "REJECTED"
  | "WITHDRAWN"
  | "WAITLISTED"
  | "EXPIRED";

const buildRepos = (
  opts: {
    gateType?: "APPLICATION" | "PASSWORD";
    status?: SubmissionStatus;
    submissionEventId?: string;
    submissionHumanId?: string | null;
    reviewedAt?: Date | null;
    isUnlocked?: boolean;
  } = {},
) => {
  const event = {
    id: EVENT_ID,
    orgId: "org-1",
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
  };
  // Stateful: tests flip `status` / `reviewedAt` to model rescind and
  // re-approval between requests.
  const submissionRow = {
    id: SUBMISSION_ID,
    // Open calls v1: the attendee gate's (ATTEND) form.
    formId: "form-attend",
    purpose: "ATTEND" as "ATTEND" | "PERFORM",
    eventId: opts.submissionEventId ?? EVENT_ID,
    humanId: opts.submissionHumanId === undefined ? null : opts.submissionHumanId,
    contactEmail: "guest@example.com",
    status: (opts.status ?? "APPROVED") as SubmissionStatus,
    reviewedAt: opts.reviewedAt === undefined ? APPROVED_AT : opts.reviewedAt,
  };
  const eventApplications = {
    getSubmissionById: vi.fn(async (id: string) =>
      id === SUBMISSION_ID ? { ...submissionRow } : null,
    ),
    attachSubmissionToHuman: vi.fn(async () => null),
    lockApprovedSubmission: vi.fn(
      async (input: {
        submissionId: string;
        eventId: string;
        purpose: "ATTEND" | "PERFORM";
        reviewedAt: Date;
      }) =>
        input.submissionId === submissionRow.id &&
        input.eventId === submissionRow.eventId &&
        input.purpose === submissionRow.purpose &&
        submissionRow.status === "APPROVED" &&
        submissionRow.reviewedAt?.getTime() === input.reviewedAt.getTime(),
    ),
  };
  const eventUnlocks = {
    isUnlocked: vi.fn(async () => opts.isUnlocked ?? false),
    upsert: vi.fn(async () => ({ id: "unlock-1" })),
  };
  const repos: Record<string, unknown> = {
    events: {
      getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)),
      resolveBySlug: vi.fn(async () => ({
        eventId: EVENT_ID,
        currentSlug: "secret",
        redirect: false,
      })),
    },
    authz: { getOrgMembership: vi.fn(async () => null) },
    eventApplications,
    eventUnlocks,
    humans: {
      getByIdWithIdentity: vi.fn(async () => ({
        human: { id: BUYER_ID },
        identity: { email: "guest@example.com", emailVerified: true },
      })),
    },
  };
  repos.tx = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(repos));
  return {
    repos: repos as unknown as Ctx["repos"],
    eventApplications,
    eventUnlocks,
    submissionRow,
    eventsGetById: (repos.events as { getById: ReturnType<typeof vi.fn> }).getById,
  };
};

const anonymousCtx = (repos: Ctx["repos"], cookieHeader: string | null) =>
  buildBaseCtx({
    repos,
    actorHumanId: null,
    auth: null,
    authToken: null,
    eventUnlockSecret: SECRET,
    cookieHeader,
  });

describe("ensureFullEventReadAccessByEventId — application grant", () => {
  it("valid grant + APPROVED submission → the anonymous viewer may read", async () => {
    const { repos, eventApplications } = buildRepos();
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, grantCookie()), EVENT_ID),
    ).resolves.toBeUndefined();
    expect(eventApplications.getSubmissionById).toHaveBeenCalledWith(SUBMISSION_ID);
  });

  it.each(["PENDING", "REJECTED", "WITHDRAWN", "WAITLISTED", "EXPIRED"] as const)(
    "grant for a %s submission → forbidden (rescind / withdraw revoke immediately)",
    async (status) => {
      const { repos } = buildRepos({ status });
      await expect(
        ensureFullEventReadAccessByEventId(anonymousCtx(repos, grantCookie()), EVENT_ID),
      ).rejects.toMatchObject({
        code: "forbidden",
        message: "event_application_required",
      });
    },
  );

  it("rescind → re-approve: the old grant stays locked, a grant for the new approval opens it", async () => {
    const { repos, submissionRow } = buildRepos();
    const oldGrant = grantCookie();
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, oldGrant), EVENT_ID),
    ).resolves.toBeUndefined();

    // Rescind: back to PENDING, reviewedAt nulled.
    submissionRow.status = "PENDING";
    submissionRow.reviewedAt = null;
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, oldGrant), EVENT_ID),
    ).rejects.toMatchObject({ message: "event_application_required" });

    // Re-approve: APPROVED again, with a FRESH reviewedAt.
    const reApprovedAtMs = APPROVED_AT_MS + 3_600_000;
    submissionRow.status = "APPROVED";
    submissionRow.reviewedAt = new Date(reApprovedAtMs);
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, oldGrant), EVENT_ID),
    ).rejects.toMatchObject({ message: "event_application_required" });

    // The new claim link mints a grant bound to the new approval.
    const newGrant = grantCookie({ approvedAtMs: reApprovedAtMs });
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, newGrant), EVENT_ID),
    ).resolves.toBeUndefined();
  });

  it("grant whose submission belongs to another event → forbidden", async () => {
    const { repos } = buildRepos({ submissionEventId: OTHER_EVENT_ID });
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, grantCookie()), EVENT_ID),
    ).rejects.toMatchObject({ message: "event_application_required" });
  });

  it("tampered / expired grant → forbidden, and the submission is never looked up", async () => {
    const { repos, eventApplications } = buildRepos();
    const expired = grantCookie({ exp: Date.now() - 1 });
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, expired), EVENT_ID),
    ).rejects.toMatchObject({ message: "event_application_required" });
    const forged = grantCookie({ secret: "y".repeat(40) });
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, forged), EVENT_ID),
    ).rejects.toMatchObject({ message: "event_application_required" });
    expect(eventApplications.getSubmissionById).not.toHaveBeenCalled();
  });

  it("a valid PASSWORD cookie does NOT open an APPLICATION gate", async () => {
    const { repos } = buildRepos();
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, passwordCookie()), EVENT_ID),
    ).rejects.toMatchObject({ message: "event_application_required" });
  });

  it("a valid application grant does NOT open a PASSWORD gate", async () => {
    const { repos, eventApplications } = buildRepos({ gateType: "PASSWORD" });
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, grantCookie()), EVENT_ID),
    ).rejects.toMatchObject({ message: "event_password_required" });
    expect(eventApplications.getSubmissionById).not.toHaveBeenCalled();
  });

  it("PASSWORD path unchanged: the password cookie still opens a PASSWORD gate", async () => {
    const { repos } = buildRepos({ gateType: "PASSWORD" });
    await expect(
      ensureFullEventReadAccessByEventId(anonymousCtx(repos, passwordCookie()), EVENT_ID),
    ).resolves.toBeUndefined();
  });

  it("signed-in subject path unchanged: a durable unlock opens it with no cookie", async () => {
    const { repos, eventApplications } = buildRepos({ isUnlocked: true });
    const ctx = buildBaseCtx({ repos, eventUnlockSecret: SECRET, cookieHeader: null });
    await expect(
      ensureFullEventReadAccessByEventId(ctx, EVENT_ID),
    ).resolves.toBeUndefined();
    expect(eventApplications.getSubmissionById).not.toHaveBeenCalled();
  });
});

describe("events.getGateState — application grant", () => {
  it("folds a valid grant into applicationRequired for an anonymous viewer", async () => {
    const { repos } = buildRepos();
    const { caller } = createCaller(eventsRouter, {
      repos,
      actorHumanId: null,
      auth: null,
      authToken: null,
      eventUnlockSecret: SECRET,
      cookieHeader: grantCookie(),
    });
    await expect(caller.getGateState({ eventId: EVENT_ID })).resolves.toMatchObject({
      gateType: "APPLICATION",
      applicationRequired: false,
      viewerHasApplicationGrant: true,
    });
  });

  it("refuses a CLIENT-supplied applicationGrant (server-injected only)", async () => {
    const { repos, eventApplications } = buildRepos();
    const { caller } = createCaller(eventsRouter, {
      repos,
      actorHumanId: null,
      auth: null,
      authToken: null,
      eventUnlockSecret: SECRET,
      cookieHeader: null,
    });
    await expect(
      caller.getGateState({
        eventId: EVENT_ID,
        applicationGrant: GRANT,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(eventApplications.getSubmissionById).not.toHaveBeenCalled();
  });
});

describe("events.recordSignedApplicationUnlock", () => {
  it("persists a submission-linked unlock for the signed-in applicant", async () => {
    const { repos, eventUnlocks } = buildRepos({ submissionHumanId: BUYER_ID });
    const { caller } = createCaller(eventsRouter, {
      repos,
      eventUnlockSecret: SECRET,
      cookieHeader: grantCookie(),
    });
    await expect(
      caller.recordSignedApplicationUnlock({ eventId: EVENT_ID }),
    ).resolves.toMatchObject({ persisted: true, outcome: "persisted" });
    expect(eventUnlocks.upsert).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: BUYER_ID,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_ID,
    });
  });

  it("FORBIDDEN without a valid grant cookie", async () => {
    const { repos, eventUnlocks } = buildRepos();
    const { caller } = createCaller(eventsRouter, {
      repos,
      eventUnlockSecret: SECRET,
      cookieHeader: passwordCookie(),
    });
    await expect(
      caller.recordSignedApplicationUnlock({ eventId: EVENT_ID }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "event_application_required",
    });
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("a grant from a rescinded-then-re-approved approval persists nothing", async () => {
    const { repos, eventUnlocks } = buildRepos({
      submissionHumanId: BUYER_ID,
      reviewedAt: new Date(APPROVED_AT_MS + 3_600_000),
    });
    const { caller } = createCaller(eventsRouter, {
      repos,
      eventUnlockSecret: SECRET,
      cookieHeader: grantCookie(),
    });
    await expect(
      caller.recordSignedApplicationUnlock({ eventId: EVENT_ID }),
    ).resolves.toMatchObject({ persisted: false, outcome: "grant_invalid" });
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
  });

  it("a revoked grant persists nothing", async () => {
    const { repos, eventUnlocks } = buildRepos({
      status: "PENDING",
      submissionHumanId: BUYER_ID,
    });
    const { caller } = createCaller(eventsRouter, {
      repos,
      eventUnlockSecret: SECRET,
      cookieHeader: grantCookie(),
    });
    await expect(
      caller.recordSignedApplicationUnlock({ eventId: EVENT_ID }),
    ).resolves.toMatchObject({ persisted: false, outcome: "grant_invalid" });
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
  });
});

describe("orders checkout — application grant reaching the API", () => {
  const ordersCaller = (repos: Ctx["repos"], cookieHeader: string) => {
    const ctx = buildBaseCtx({ repos, eventUnlockSecret: SECRET, cookieHeader });
    const testRouter = trpcRouter({ orders: router(ordersRouter) });
    return testRouter.createCaller(ctx);
  };
  const holdInput = {
    eventId: EVENT_ID,
    items: [{ ticketTypeId: "44444444-4444-4444-8444-444444444444", qty: 1 }],
  };
  const holdResult = {
    order: {
      id: "123e4567-e89b-12d3-a456-426614174000",
      eventId: EVENT_ID,
      buyerHumanId: BUYER_ID,
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

  it("valid grant: persists the subject's APPLICATION unlock, then holds tickets (no EVENT_NOT_PASSWORD_GATED)", async () => {
    const { repos, eventUnlocks } = buildRepos({ submissionHumanId: BUYER_ID });
    const spy = vi
      .spyOn(updateOrderItemsModule, "updateOrderItems")
      .mockResolvedValue(holdResult as never);

    await ordersCaller(repos, grantCookie()).orders.updateOrderItems(holdInput);

    expect(eventUnlocks.upsert).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      humanId: BUYER_ID,
      source: "APPLICATION",
      applicationSubmissionId: SUBMISSION_ID,
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("non-subject grant + a stale th_eu_ on an APPLICATION event: the password path is skipped, checkout's gate answers FORBIDDEN", async () => {
    // Someone else's submission: the grant is valid but this buyer is not its
    // subject, so nothing persists. The stale password cookie must not be
    // tried on an APPLICATION gate (it would throw EVENT_NOT_PASSWORD_GATED).
    const { repos, eventUnlocks } = buildRepos({
      submissionHumanId: "22222222-2222-4222-8222-222222222222",
    });
    const spy = vi
      .spyOn(updateOrderItemsModule, "updateOrderItems")
      .mockImplementation(async () => fail("FORBIDDEN"));

    await expect(
      ordersCaller(
        repos,
        `${grantCookie()}; ${passwordCookie()}`,
      ).orders.updateOrderItems(holdInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a stale th_eu_ alone on an APPLICATION event is ignored rather than failing with EVENT_NOT_PASSWORD_GATED", async () => {
    const { repos, eventUnlocks } = buildRepos();
    const spy = vi
      .spyOn(updateOrderItemsModule, "updateOrderItems")
      .mockImplementation(async () => fail("FORBIDDEN"));

    await expect(
      ordersCaller(repos, passwordCookie()).orders.updateOrderItems(holdInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("PASSWORD event: a valid th_eu_ still persists the PASSWORD unlock (unchanged)", async () => {
    const { repos, eventUnlocks } = buildRepos({ gateType: "PASSWORD" });
    const spy = vi
      .spyOn(updateOrderItemsModule, "updateOrderItems")
      .mockResolvedValue(holdResult as never);

    await ordersCaller(repos, passwordCookie()).orders.updateOrderItems(holdInput);

    expect(eventUnlocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, source: "PASSWORD" }),
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("revoked grant: persists nothing and leaves the decision to checkout's own gate", async () => {
    const { repos, eventUnlocks } = buildRepos({
      status: "WITHDRAWN",
      submissionHumanId: BUYER_ID,
    });
    // Stand-in for the real use case's `ensureEventAccessible` (no row →
    // FORBIDDEN), which core tests cover directly.
    const spy = vi
      .spyOn(updateOrderItemsModule, "updateOrderItems")
      .mockImplementation(async () => fail("FORBIDDEN"));

    await expect(
      ordersCaller(repos, grantCookie()).orders.updateOrderItems(holdInput),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(eventUnlocks.upsert).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
