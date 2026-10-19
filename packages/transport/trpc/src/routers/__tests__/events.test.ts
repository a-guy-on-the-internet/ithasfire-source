import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@th/errors";

import type { Ctx } from "../../context";
import { withConsumeMany } from "@th/test-utils/fakes/rate-limit";
import { eventsRouter } from "../events";
import * as eventsUseCases from "@th/core/use-cases/events";
import * as shortLinkUseCase from "@th/core/use-cases/events/resolve-event-short-link";
import { createTestLogger } from "@th/test-utils";
import { createCaller as createCallerFromHelpers } from "./test-helpers";

const hasOwn = <T extends object>(obj: T | undefined, key: keyof T): boolean =>
  !!obj && Object.prototype.hasOwnProperty.call(obj, key);

const buildBaseCtx = (overrides?: Partial<Ctx>): Ctx => {
  const repos = hasOwn(overrides, "repos")
    ? (overrides!.repos as Ctx["repos"])
    : ({} as unknown as Ctx["repos"]);
  const payments = hasOwn(overrides, "payments")
    ? overrides!.payments!
    : ({} as unknown as Ctx["payments"]);
  const authn =
    overrides?.authn ??
    ({
      ensureAuthedHuman: vi.fn(),
      ensureAuthedHumanFromApiKey: vi.fn(),
      getProviderUserId: vi.fn().mockResolvedValue({ providerUserId: null }),
    } as unknown as Ctx["authn"]);
  const authz =
    overrides?.authz ??
    ({
      hasOrgRole: vi.fn(),
      requireOrgRole: vi.fn(),
      canEditEvent: vi.fn(),
      canManagePlace: vi.fn(),
      canFinanceOrg: vi.fn(),
      hasStaffRole: vi.fn(async () => ({ allowed: false })),
    } as unknown as Ctx["authz"]);
  const idempotency =
    overrides?.idempotency ??
    ({
      begin: vi.fn(),
      get: vi.fn(),
      commit: vi.fn(),
      fail: vi.fn(),
    } as unknown as Ctx["idempotency"]);
  const clock =
    overrides?.clock ??
    ({
      now: vi.fn(() => new Date("2024-01-01T00:00:00.000Z")),
    } as unknown as Ctx["clock"]);
  const logger = hasOwn(overrides, "logger")
    ? (overrides!.logger as Ctx["logger"])
    : createTestLogger();
  const placeLayoutParser =
    overrides?.placeLayoutParser ??
    ({
      parse: vi.fn(),
    } as unknown as Ctx["placeLayoutParser"]);
  const placeLayoutStreaming =
    overrides?.placeLayoutStreaming ??
    ({
      publishPlaceLayoutReplaced: vi.fn(),
    } as unknown as Ctx["placeLayoutStreaming"]);
  const searchQuery =
    overrides?.searchQuery ??
    ({
      autocomplete: vi.fn(),
      search: vi.fn(),
      related: vi.fn(),
    } as unknown as Ctx["searchQuery"]);
  const searchPrompts =
    overrides?.searchPrompts ??
    ({
      listPrompts: vi.fn(),
    } as unknown as Ctx["searchPrompts"]);
  const geo = hasOwn(overrides, "geo")
    ? (overrides!.geo as Ctx["geo"])
    : ({
        nearbyEvents: vi.fn(),
        nearbyPlaces: vi.fn(),
        boxSearch: vi.fn(),
        distance: vi.fn(),
        health: vi.fn(),
      } as unknown as Ctx["geo"]);

  const notify =
    overrides?.notify ??
    (vi.fn(async () => ({ ok: true })) as unknown as Ctx["notify"]);

  const fileStorage =
    overrides?.fileStorage ?? ({} as unknown as Ctx["fileStorage"]);

  return {
    repos,
    fileStorage,
    payments,
    authn,
    authz,
    idempotency,
    clock,
    logger,
    notify,
    placeLayoutParser,
    placeLayoutStreaming,
    searchQuery,
    searchPrompts,
    geo,
    auth: hasOwn(overrides, "auth")
      ? (overrides!.auth ?? null)
      : { userId: "user-1", sessionId: null, token: "token" },
    authToken: hasOwn(overrides, "authToken")
      ? (overrides!.authToken ?? null)
      : "token",
    apiKey: hasOwn(overrides, "apiKey") ? (overrides!.apiKey ?? null) : null,
    actorHumanId: hasOwn(overrides, "actorHumanId")
      ? (overrides!.actorHumanId ?? null)
      : "11111111-1111-4111-8111-111111111111",
    viewerLocation: hasOwn(overrides, "viewerLocation")
      ? (overrides!.viewerLocation ?? null)
      : null,
    clientIp: hasOwn(overrides, "clientIp")
      ? (overrides!.clientIp ?? null)
      : "203.0.113.44",
    userAgent: hasOwn(overrides, "userAgent")
      ? (overrides!.userAgent ?? null)
      : "vitest",
    cookieHeader: hasOwn(overrides, "cookieHeader")
      ? (overrides!.cookieHeader ?? null)
      : null,
  } satisfies Ctx;
};

// The hold-intents dispatcher is the ONE seam the events router touches for
// FR-018 notifications; mocked at the module boundary exactly as the
// booking-holds router test does.
vi.mock("@th/core/use-cases/booking-holds/notify-booking-hold-intents", () => ({
  dispatchBookingHoldIntents: vi.fn(async () => undefined),
  BOOKING_HOLD_VARIANTS: {},
  buildIdempotencyKey: vi.fn(),
}));
import { dispatchBookingHoldIntents } from "@th/core/use-cases/booking-holds";
// Event-first (venue-confirmation spec): the save's booking-request intents
// go through the same dispatcher `bookingRequests.create` uses, mocked at
// the module boundary the same way.
vi.mock("@th/core/use-cases/booking-requests/notify-booking-request-intents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/core/use-cases/booking-requests/notify-booking-request-intents")>()),
  dispatchBookingRequestIntents: vi.fn(async () => undefined),
}));
import { dispatchBookingRequestIntents } from "@th/core/use-cases/booking-requests";

const createCaller = (ctxOverrides?: Partial<Ctx>) =>
  createCallerFromHelpers(eventsRouter, ctxOverrides);

const ORIGINAL_DEFAULT_EVENTS_REGION =
  process.env.THC_EVENTS_DEFAULT_REGION_CODE;

const viewerLocationFixture = {
  source: "vercel",
  ip: "203.0.113.1",
  city: "New York",
  regionCode: "ny",
  countryCode: "US",
  latitude: null,
  longitude: null,
  geohash: null,
  postalCode: "10001",
  timezone: "America/New_York",
  accuracyRadiusKm: null,
} satisfies NonNullable<Ctx["viewerLocation"]>;

const buildLockedEventReadRepos = (
  eventId: string,
  overrides: Record<string, unknown> = {},
): Ctx["repos"] => {
  const event = {
    id: eventId,
    orgId: "org-1",
    humanId: null,
    gateType: "PASSWORD",
    visibility: "PUBLIC",
    status: "PUBLISHED",
    publishedAt: new Date("2025-12-01T00:00:00.000Z"),
    stewardship: "OWNED",
    passwordHash: "set",
    waitlistStatus: "DISABLED",
    waitlistPublishAt: null,
    waitlistDescription: null,
    waitlistCap: null,
    ...overrides,
  };

  return {
    events: {
      resolveBySlug: vi.fn(async (slug: string) => ({
        eventId,
        currentSlug: slug,
        redirect: false,
      })),
      getById: vi.fn(async (id: string) => (id === eventId ? event : null)),
    },
    authz: {
      getOrgMembership: vi.fn(),
    },
    eventUnlocks: {
      isUnlocked: vi.fn(async () => false),
    },
  } as unknown as Ctx["repos"];
};

const buildEventUnlockCookie = (eventId: string, secret: string): string => {
  const exp = Date.now() + 60_000;
  const signature = createHmac("sha256", secret)
    .update(`${eventId}|${exp}`)
    .digest("base64url");
  return `th_eu_${eventId}=${exp}.${signature}`;
};

afterEach(() => {
  if (ORIGINAL_DEFAULT_EVENTS_REGION === undefined) {
    delete process.env.THC_EVENTS_DEFAULT_REGION_CODE;
  } else {
    process.env.THC_EVENTS_DEFAULT_REGION_CODE = ORIGINAL_DEFAULT_EVENTS_REGION;
  }
});

describe("eventsRouter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("listMine", () => {
    const actorHumanId = "11111111-1111-4111-8111-111111111111";
    const ownerId = "22222222-2222-4222-8222-222222222222";
    const emptyPage = {
      items: [],
      pageInfo: {
        total: 0,
        limit: 100,
        offset: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    };

    it("refuses expandDates without BOTH dateRange bounds at the wire (same rule as core)", async () => {
      const spy = vi
        .spyOn(eventsUseCases, "listMyEvents")
        .mockResolvedValue(emptyPage);
      const { caller } = createCaller({ actorHumanId });

      await expect(
        caller.listMine({
          ownerType: "HUMAN",
          ownerId,
          expandDates: true,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        caller.listMine({
          ownerType: "HUMAN",
          ownerId,
          expandDates: true,
          dateRange: { from: new Date("2026-09-01T00:00:00Z") },
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(spy).not.toHaveBeenCalled();
    });

    it("forwards a bounded expanding read with the actor injected", async () => {
      const spy = vi
        .spyOn(eventsUseCases, "listMyEvents")
        .mockResolvedValue(emptyPage);
      const { caller } = createCaller({ actorHumanId });
      const dateRange = {
        from: new Date("2026-09-01T00:00:00Z"),
        to: new Date("2026-10-12T00:00:00Z"),
      };

      const result = await caller.listMine({
        ownerType: "ORGANIZATION",
        ownerId,
        limit: 100,
        expandDates: true,
        dateRange,
      });

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorHumanId,
          ownerType: "ORGANIZATION",
          ownerId,
          expandDates: true,
          dateRange,
        }),
      );
      expect(result.items).toEqual([]);
    });
  });

  describe("validatePassword", () => {
    it("keys rate limits on trusted clientIp and actor instead of viewerLocation ip", async () => {
      const eventId = "33333333-3333-4333-8333-333333333333";
      const rateLimit = withConsumeMany({
        consume: vi.fn(async () => ({
          allowed: true,
          remaining: Number.POSITIVE_INFINITY,
          retryAfterSeconds: 0,
        })),
      }) as unknown as Ctx["rateLimit"];
      vi.spyOn(eventsUseCases, "validateEventPassword").mockResolvedValue({
        eventId,
        unlocked: true,
        bypassed: false,
        persisted: false,
      });

      const { caller, ctx } = createCaller({
        actorHumanId: "11111111-1111-4111-8111-111111111111",
        clientIp: "198.51.100.10",
        viewerLocation: {
          ...viewerLocationFixture,
          ip: "203.0.113.250",
        },
        rateLimit,
      });

      await caller.validatePassword({ eventId, password: "open-sesame" });

      // `optionalProcedure` also runs the global default rate-limit floor
      // (see guard.ts `defaultRateLimit`), so we don't assert absolute call
      // positions — just that the two `validatePassword`-specific limiters
      // fired, in the documented per-event-then-per-IP order, with trusted
      // clientIp (not the spoofable viewerLocation ip).
      const validatePasswordCalls = rateLimit.consume.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          call[0].startsWith("event:validatePassword:"),
      );
      expect(validatePasswordCalls[0]).toEqual([
        `event:validatePassword:${eventId}:human:${ctx.actorHumanId}:ip:198.51.100.10`,
        5,
        60,
      ]);
      expect(validatePasswordCalls[1]).toEqual([
        "event:validatePassword:ip:198.51.100.10",
        20,
        60,
      ]);
    });
  });

  describe("submitApplication", () => {
    const eventId = "33333333-3333-4333-8333-333333333333";

    const buildRateLimit = () =>
      (withConsumeMany({
        consume: vi.fn(async () => ({
          allowed: true,
          remaining: Number.POSITIVE_INFINITY,
          retryAfterSeconds: 0,
        })),
      })) as unknown as Ctx["rateLimit"];

    const submitApplicationCalls = (rateLimit: Ctx["rateLimit"]) =>
      (
        rateLimit as unknown as { consume: ReturnType<typeof vi.fn> }
      ).consume.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          call[0].startsWith("event:submitApplication:"),
      );

    beforeEach(() => {
      vi.spyOn(eventsUseCases, "submitEventApplication").mockResolvedValue({
        eventId,
        submissionId: "44444444-4444-4444-8444-444444444444",
        status: "PENDING",
        bypassed: false,
      });
    });

    it("keys the tight per-event limiter on the ACTOR for authed submitters (shared-IP wifi safe)", async () => {
      const rateLimit = buildRateLimit();
      const { caller, ctx } = createCaller({
        actorHumanId: "11111111-1111-4111-8111-111111111111",
        clientIp: "198.51.100.10",
        rateLimit,
      });

      await caller.submitApplication({ eventId, answers: {} });

      const calls = submitApplicationCalls(rateLimit);
      // Tight per-event limiter: actor-differentiated (two signed-in humans
      // behind one venue NAT get separate buckets), same convention as
      // validatePassword.
      expect(calls[0]).toEqual([
        `event:submitApplication:${eventId}:human:${ctx.actorHumanId}:ip:198.51.100.10`,
        10,
        60,
      ]);
      // Loose cross-event backstop stays IP-only.
      expect(calls[1]).toEqual([
        "event:submitApplication:ip:198.51.100.10",
        30,
        60,
      ]);
    });

    it("collapses the tight limiter to anonymous+IP for guests", async () => {
      const rateLimit = buildRateLimit();
      const { caller } = createCaller({
        actorHumanId: null,
        clientIp: "198.51.100.10",
        rateLimit,
      });

      await caller.submitApplication({
        eventId,
        contactEmail: "guest@example.com",
        answers: {},
      });

      const calls = submitApplicationCalls(rateLimit);
      expect(calls[0]).toEqual([
        `event:submitApplication:${eventId}:anonymous:ip:198.51.100.10`,
        10,
        60,
      ]);
      expect(calls[1]).toEqual([
        "event:submitApplication:ip:198.51.100.10",
        30,
        60,
      ]);
    });

    it("maps the Phase-2 window/cap codes to CONFLICT", async () => {
      vi.spyOn(eventsUseCases, "submitEventApplication").mockRejectedValue(
        new AppError("APPLICATION_WINDOW_CLOSED"),
      );

      const { caller } = createCaller({
        actorHumanId: "11111111-1111-4111-8111-111111111111",
      });

      await expect(
        caller.submitApplication({ eventId, answers: {} }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("maps the Phase-3 dedupe code APPLICATION_ALREADY_SUBMITTED to CONFLICT", async () => {
      vi.spyOn(eventsUseCases, "submitEventApplication").mockRejectedValue(
        new AppError("APPLICATION_ALREADY_SUBMITTED"),
      );

      const { caller } = createCaller({ actorHumanId: null, auth: null });

      await expect(
        caller.submitApplication({
          eventId,
          contactEmail: "guest@example.com",
          answers: {},
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("stays reachable UNAUTHENTICATED and still forwards the Turnstile token + client IP", async () => {
      const spy = vi.spyOn(eventsUseCases, "submitEventApplication");

      const { caller } = createCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
        clientIp: "198.51.100.10",
      });

      await caller.submitApplication({
        eventId,
        contactEmail: "guest@example.com",
        turnstileToken: "tt-token",
        answers: {},
      });

      // Turnstile is enforced INSIDE the use case for anonymous submitters —
      // the transport's job is only to hand it the token plus the trusted,
      // server-observed IP (never a client-suppliable one).
      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          turnstileToken: "tt-token",
          viewerHumanId: null,
          requestIp: "198.51.100.10",
        }),
      );
    });

    it("cannot be tricked into a client-supplied viewerHumanId / requestIp", async () => {
      const spy = vi.spyOn(eventsUseCases, "submitEventApplication");

      const { caller } = createCaller({
        actorHumanId: null,
        auth: null,
        clientIp: "198.51.100.10",
      });

      await caller.submitApplication({
        eventId,
        contactEmail: "guest@example.com",
        answers: {},
        // Both are `.omit()`ed from the client-facing schema, so zod STRIPS
        // them (the repo's allow-and-strip stance, not a 400) — and the
        // router's server-injected values are spread in AFTER the input, so
        // even an un-stripped key could not win.
        // @ts-expect-error — not part of the client-facing input schema.
        viewerHumanId: "11111111-1111-4111-8111-111111111111",
        // @ts-expect-error — not part of the client-facing input schema.
        requestIp: "10.0.0.1",
      });

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          viewerHumanId: null,
          requestIp: "198.51.100.10",
        }),
      );
    });
  });

  // ── Phase 3 item 1: public form read ────────────────────────────────────
  describe("getPublicApplicationForm", () => {
    const eventId = "33333333-3333-4333-8333-333333333333";

    const formPayload = {
      eventId,
      introText: "Tell us about your act.",
      opensAt: null,
      closesAt: null,
      questions: [],
    };

    const buildRateLimit = () =>
      (withConsumeMany({
        consume: vi.fn(async () => ({
          allowed: true,
          remaining: Number.POSITIVE_INFINITY,
          retryAfterSeconds: 0,
        })),
      })) as unknown as Ctx["rateLimit"];

    it("serves a fully UNAUTHENTICATED caller", async () => {
      vi.spyOn(
        eventsUseCases,
        "getPublicEventApplicationForm",
      ).mockResolvedValue(formPayload);

      const { caller } = createCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      await expect(
        caller.getPublicApplicationForm({ eventId }),
      ).resolves.toEqual(formPayload);
    });

    it("rate-limits per (event, IP) then per IP, keyed on the trusted clientIp", async () => {
      vi.spyOn(
        eventsUseCases,
        "getPublicEventApplicationForm",
      ).mockResolvedValue(formPayload);
      const rateLimit = buildRateLimit();

      const { caller } = createCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
        clientIp: "198.51.100.10",
        viewerLocation: { ...viewerLocationFixture, ip: "203.0.113.250" },
        rateLimit,
      });

      await caller.getPublicApplicationForm({ eventId });

      const calls = (
        rateLimit as unknown as { consume: ReturnType<typeof vi.fn> }
      ).consume.mock.calls.filter(
        (call) =>
          typeof call[0] === "string" &&
          call[0].startsWith("event:getPublicApplicationForm:"),
      );
      // IP-only keys (an authed viewer has no extra claim on a public read),
      // and the trusted clientIp — never the spoofable viewerLocation ip.
      expect(calls[0]).toEqual([
        `event:getPublicApplicationForm:${eventId}:ip:198.51.100.10`,
        30,
        60,
      ]);
      expect(calls[1]).toEqual([
        "event:getPublicApplicationForm:ip:198.51.100.10",
        60,
        60,
      ]);
    });

    it("maps the collapsed EVENT_NOT_FOUND to NOT_FOUND", async () => {
      vi.spyOn(
        eventsUseCases,
        "getPublicEventApplicationForm",
      ).mockRejectedValue(new AppError("EVENT_NOT_FOUND"));

      const { caller } = createCaller({ actorHumanId: null, auth: null });

      await expect(
        caller.getPublicApplicationForm({ eventId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("withdrawApplication", () => {
    const eventId = "33333333-3333-4333-8333-333333333333";
    const submissionId = "44444444-4444-4444-8444-444444444444";

    it("injects the actor human id and forwards dependencies", async () => {
      const spy = vi
        .spyOn(eventsUseCases, "withdrawEventApplication")
        .mockResolvedValue({
          eventId,
          submissionId,
          status: "WITHDRAWN",
        });

      const { caller, ctx } = createCaller({
        actorHumanId: "11111111-1111-4111-8111-111111111111",
      });

      const result = await caller.withdrawApplication({ eventId });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          clock: ctx.clock,
        }),
        {
          eventId,
          actorHumanId: "11111111-1111-4111-8111-111111111111",
        },
      );
      expect(result.status).toBe("WITHDRAWN");
    });

    it("forwards an explicit submissionId target", async () => {
      const spy = vi
        .spyOn(eventsUseCases, "withdrawEventApplication")
        .mockResolvedValue({
          eventId,
          submissionId,
          status: "WITHDRAWN",
        });

      const { caller } = createCaller({
        actorHumanId: "11111111-1111-4111-8111-111111111111",
      });

      await caller.withdrawApplication({ eventId, submissionId });

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ submissionId }),
      );
    });

    it("never accepts a client-supplied actorHumanId", async () => {
      vi.spyOn(eventsUseCases, "withdrawEventApplication").mockResolvedValue({
        eventId,
        submissionId,
        status: "WITHDRAWN",
      });

      const { caller } = createCaller({
        actorHumanId: "11111111-1111-4111-8111-111111111111",
      });

      await expect(
        caller.withdrawApplication({
          eventId,
          actorHumanId: "22222222-2222-4222-8222-222222222222",
        } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("maps use case errors to TRPC errors", async () => {
      vi.spyOn(eventsUseCases, "withdrawEventApplication").mockRejectedValue(
        new AppError("INVALID_STATUS"),
      );

      const { caller } = createCaller({
        actorHumanId: "11111111-1111-4111-8111-111111111111",
      });

      await expect(
        caller.withdrawApplication({ eventId }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  describe("rescindEventApplicationDecision", () => {
    const eventId = "33333333-3333-4333-8333-333333333333";
    const submissionId = "44444444-4444-4444-8444-444444444444";
    const pendingSubmission = {
      id: submissionId,
      eventId,
      humanId: "55555555-5555-4555-8555-555555555555",
      contactEmail: "applicant@example.com",
      contactPhone: null,
      status: "PENDING",
      answers: {},
      decisionReason: null,
      questionsSnapshot: {},
      reviewerHumanId: null,
      reviewedAt: null,
      approvalToken: null,
      tokenExpiresAt: null,
      inviteId: null,
      metadata: {},
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    } as const;

    it("wires the back-in-review notify + mailer deps (same composition as review)", async () => {
      const spy = vi
        .spyOn(eventsUseCases, "rescindEventApplicationDecision")
        .mockResolvedValue({ eventId, submission: pendingSubmission } as never);
      const notifyWithEmail = vi.fn(async () => ({ ok: true }));
      const mailer = { send: vi.fn() };
      const reportError = vi.fn();

      const { caller, ctx } = createCaller({
        actorHumanId: "11111111-1111-4111-8111-111111111111",
        notifyWithEmail: notifyWithEmail as never,
        mailer: mailer as never,
        publicAppUrl: "https://app.test",
        reportError: reportError as never,
      });

      await caller.rescindEventApplicationDecision({ eventId, submissionId });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          clock: ctx.clock,
          // notifyWithEmail (mailer-bound) wins over plain notify.
          notify: notifyWithEmail,
          mailer,
          appBaseUrl: "https://app.test",
          reportError,
        }),
        {
          eventId,
          submissionId,
          actorHumanId: "11111111-1111-4111-8111-111111111111",
        },
      );
    });

    it("falls back to plain notify when notifyWithEmail is not bound", async () => {
      const spy = vi
        .spyOn(eventsUseCases, "rescindEventApplicationDecision")
        .mockResolvedValue({ eventId, submission: pendingSubmission } as never);

      const { caller, ctx } = createCaller({
        actorHumanId: "11111111-1111-4111-8111-111111111111",
      });

      await caller.rescindEventApplicationDecision({ eventId, submissionId });

      expect(spy.mock.calls[0]![0].notify).toBe(ctx.notify);
    });
  });

  describe("gated public reads", () => {
    const eventId = "33333333-3333-4333-8333-333333333333";

    it("rejects locked viewers before full SEO, body, or ticket data use cases run", async () => {
      const getEventSeoSpy = vi
        .spyOn(eventsUseCases, "getEventSeo")
        .mockResolvedValue({} as any);
      const getPublicEventBodySpy = vi
        .spyOn(eventsUseCases, "getPublicEventBody")
        .mockResolvedValue({} as any);
      const listTicketTypesSpy = vi
        .spyOn(eventsUseCases, "listEventTicketTypes")
        .mockResolvedValue({} as any);
      const getCheckoutFeeRatesSpy = vi
        .spyOn(eventsUseCases, "getCheckoutFeeRates")
        .mockResolvedValue({} as any);
      const estimateCheckoutTaxSpy = vi
        .spyOn(eventsUseCases, "estimateCheckoutTax")
        .mockResolvedValue({} as any);
      const listSeatAvailabilitySpy = vi
        .spyOn(eventsUseCases, "listEventSeatAvailability")
        .mockResolvedValue({} as any);

      const { caller } = createCaller({
        repos: buildLockedEventReadRepos(eventId),
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      await expect(caller.getEventSeo({ slug: "secret" })).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "event_password_required",
      });
      await expect(
        caller.getPublicEventBody({ slug: "secret" }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "event_password_required",
      });
      await expect(caller.listEventTicketTypes({ eventId })).rejects.toMatchObject(
        {
          code: "FORBIDDEN",
          message: "event_password_required",
        },
      );
      await expect(caller.getCheckoutFeeRates({ eventId })).rejects.toMatchObject(
        {
          code: "FORBIDDEN",
          message: "event_password_required",
        },
      );
      await expect(
        caller.estimateCheckoutTax({
          eventId,
          items: [
            {
              ticketTypeId: "44444444-4444-4444-8444-444444444444",
              qty: 1,
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "event_password_required",
      });
      await expect(
        caller.listEventSeatAvailability({ eventId }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "event_password_required",
      });

      expect(getEventSeoSpy).not.toHaveBeenCalled();
      expect(getPublicEventBodySpy).not.toHaveBeenCalled();
      expect(listTicketTypesSpy).not.toHaveBeenCalled();
      expect(getCheckoutFeeRatesSpy).not.toHaveBeenCalled();
      expect(estimateCheckoutTaxSpy).not.toHaveBeenCalled();
      expect(listSeatAvailabilitySpy).not.toHaveBeenCalled();
    });

    it("N3 before the gate: a gated DRAFT is NOT_FOUND to a stranger (not event_password_required), and the gate is never asked", async () => {
      const getEventSeoSpy = vi
        .spyOn(eventsUseCases, "getEventSeo")
        .mockResolvedValue({} as any);
      const repos = buildLockedEventReadRepos(eventId, {
        status: "DRAFT",
        publishedAt: null,
      });
      const { caller } = createCaller({
        repos,
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      await expect(caller.getEventSeo({ slug: "secret" })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      // The gate check (unlock lookup) never ran, so its answer cannot leak
      // that the slug is a real, gated event.
      expect(repos.eventUnlocks.isUnlocked).not.toHaveBeenCalled();
      expect(getEventSeoSpy).not.toHaveBeenCalled();
    });

    it("N3 before the gate: the draft's EDITOR still reads it (and bypasses the gate)", async () => {
      vi.spyOn(eventsUseCases, "getEventSeo").mockResolvedValue({
        id: eventId,
        slug: "secret",
        title: "Secret Draft",
        startsAt: "2026-01-01T00:00:00.000Z",
        status: "DRAFT",
        attendanceMode: "TICKETED",
        stewardship: "OWNED",
        visibility: "PUBLIC",
        performers: [],
      });
      const editorId = "11111111-1111-4111-8111-111111111111";
      const repos = buildLockedEventReadRepos(eventId, {
        status: "DRAFT",
        publishedAt: null,
      });
      vi.mocked(repos.authz.getOrgMembership).mockResolvedValue({
        orgId: "org-1",
        humanId: editorId,
        role: "EDITOR",
      } as never);
      const { caller } = createCaller({ repos, actorHumanId: editorId });

      await expect(caller.getEventSeo({ slug: "secret" })).resolves.toMatchObject({
        id: eventId,
        status: "DRAFT",
      });
    });

    describe("getEventSeo: the act address follows the arrivalAreas gate (arrival-areas FR-009 / FR-017)", () => {
      const viewerId = "11111111-1111-4111-8111-111111111111";
      const seoStub = {
        id: eventId,
        slug: "open",
        title: "Open Show",
        startsAt: "2026-01-01T00:00:00.000Z",
        status: "PUBLISHED",
        attendanceMode: "TICKETED",
        stewardship: "OWNED",
        visibility: "PUBLIC",
        performers: [],
      } as const;
      const reposWithGate = (gateOn: boolean) => {
        const getAll = vi.fn(async () =>
          gateOn ? [{ key: "feature:arrivalAreas", value: "true" }] : [],
        );
        const repos = {
          ...buildLockedEventReadRepos(eventId, {
            gateType: "NONE",
            passwordHash: null,
          }),
          platformSettings: { getAll },
        } as unknown as Ctx["repos"];
        return { repos, getAll };
      };

      it("gate on + signed-in viewer: actAddressEnabled true reaches the use case", async () => {
        const spy = vi
          .spyOn(eventsUseCases, "getEventSeo")
          .mockResolvedValue(seoStub as never);
        const { repos } = reposWithGate(true);
        const { caller } = createCaller({ repos, actorHumanId: viewerId });
        await caller.getEventSeo({ slug: "open" });
        expect(spy.mock.calls[0]![0].actAddressEnabled).toBe(true);
        expect(spy.mock.calls[0]![1]).toMatchObject({ viewerHumanId: viewerId });
      });

      it("gate off: false", async () => {
        const spy = vi
          .spyOn(eventsUseCases, "getEventSeo")
          .mockResolvedValue(seoStub as never);
        const { repos } = reposWithGate(false);
        const { caller } = createCaller({ repos, actorHumanId: viewerId });
        await caller.getEventSeo({ slug: "open" });
        expect(spy.mock.calls[0]![0].actAddressEnabled).toBe(false);
      });

      it("anonymous: false, and no settings read", async () => {
        const spy = vi
          .spyOn(eventsUseCases, "getEventSeo")
          .mockResolvedValue(seoStub as never);
        const { repos, getAll } = reposWithGate(true);
        const { caller } = createCaller({
          repos,
          actorHumanId: null,
          auth: null,
          authToken: null,
        });
        await caller.getEventSeo({ slug: "open" });
        expect(spy.mock.calls[0]![0].actAddressEnabled).toBe(false);
        expect(getAll).not.toHaveBeenCalled();
      });

      it("a client cannot switch it on through the input", async () => {
        const spy = vi
          .spyOn(eventsUseCases, "getEventSeo")
          .mockResolvedValue(seoStub as never);
        const { repos } = reposWithGate(false);
        const { caller } = createCaller({ repos, actorHumanId: viewerId });
        // The input schema is `.strict()`: an unknown key is refused before
        // the use case runs, so there is no call to forward a flag from.
        // The deeper guarantee is that `actAddressEnabled` is a dep the
        // router sets, never read from `input`; if the schema is ever relaxed,
        // assert the forwarded dep instead of deleting this test.
        await expect(
          caller.getEventSeo({ slug: "open", actAddressEnabled: true } as never),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        expect(spy).not.toHaveBeenCalled();
      });
    });

    // resolveAudio runs the N3 gate (getEventGateState) BEFORE the use case's
    // own `authz.canEditEvent` check. The two used to disagree on a human
    // owner's delegates: canEditEvent admitted an OWNER/ADMIN/EDITOR delegate,
    // the gate did not, so the delegate got NOT_FOUND for audio they could
    // upload. They now share `actorHoldsEventEditRole`.
    describe("resolveAudio on a human-owned DRAFT: the gate's editor bar is canEditEvent's", () => {
      const ownerId = "55555555-5555-4555-8555-555555555555";
      const delegateId = "66666666-6666-4666-8666-666666666666";

      const setup = (
        delegateRole: string | null,
        gate: Record<string, unknown> = { gateType: "NONE", passwordHash: null },
      ) => {
        const resolveSpy = vi
          .spyOn(eventsUseCases, "resolveEventAudio")
          .mockResolvedValue({ items: [] });
        const repos = buildLockedEventReadRepos(eventId, {
          orgId: null,
          humanId: ownerId,
          status: "DRAFT",
          publishedAt: null,
          ...gate,
        });
        (repos.authz as unknown as Record<string, unknown>).getHumanDelegation =
          vi.fn(async () =>
            delegateRole
              ? { orgId: ownerId, humanId: delegateId, role: delegateRole }
              : null,
          );
        const { caller } = createCaller({ repos, actorHumanId: delegateId });
        return { caller, resolveSpy, repos };
      };

      it.each(["OWNER", "ADMIN", "EDITOR"])(
        "a %s delegate reads through the gate to the use case",
        async (role) => {
          const { caller, resolveSpy } = setup(role);
          await expect(caller.resolveAudio({ eventId })).resolves.toEqual({
            items: [],
          });
          expect(resolveSpy).toHaveBeenCalledTimes(1);
        },
      );

      it.each([["VIEWER"], ["FINANCE"], ["SCANNER"], [null]])(
        "a %s delegate (or a stranger) gets NOT_FOUND and the use case never runs",
        async (role) => {
          const { caller, resolveSpy } = setup(role);
          await expect(caller.resolveAudio({ eventId })).rejects.toMatchObject({
            code: "NOT_FOUND",
          });
          expect(resolveSpy).not.toHaveBeenCalled();
        },
      );

      // Owner ruling 2026-09-28: edit-role delegates get the builder, so they
      // also BYPASS the principal's own password / application gate — the
      // bypass (`viewerCanBypass`) is `actorHoldsEventEditRole`, the same bar
      // as the read gate and `canEditEvent`. A VIEWER / FINANCE / SCANNER
      // delegate still cannot even see the draft.
      it.each([
        ["PASSWORD", { gateType: "PASSWORD", passwordHash: "set" }],
        ["APPLICATION", { gateType: "APPLICATION", passwordHash: null }],
      ] as const)(
        "a %s-gated draft: an EDITOR delegate bypasses the gate on resolveAudio and getEventSeo",
        async (_label, gate) => {
          const seoSpy = vi.spyOn(eventsUseCases, "getEventSeo").mockResolvedValue({
            id: eventId,
            slug: "secret",
            title: "Secret Draft",
            startsAt: "2026-01-01T00:00:00.000Z",
            status: "DRAFT",
            attendanceMode: "TICKETED",
            stewardship: "OWNED",
            visibility: "PUBLIC",
            performers: [],
          });
          const { caller, resolveSpy, repos } = setup("EDITOR", gate);

          await expect(caller.resolveAudio({ eventId })).resolves.toEqual({
            items: [],
          });
          await expect(
            caller.getEventSeo({ slug: "secret" }),
          ).resolves.toMatchObject({ id: eventId, status: "DRAFT" });
          await expect(
            eventsUseCases.getEventGateState(
              {
                repos,
                clock: { now: () => new Date() } as never,
                // No staff role: the bypass below is the delegate's own.
                authz: { hasStaffRole: async () => ({ allowed: false }) },
              },
              { eventId, viewerHumanId: delegateId },
            ),
          ).resolves.toMatchObject({ viewerCanBypass: true });
          expect(resolveSpy).toHaveBeenCalledTimes(1);
          expect(seoSpy).toHaveBeenCalledTimes(1);
        },
      );

      it.each([["VIEWER"], ["FINANCE"], ["SCANNER"]])(
        "a PASSWORD-gated draft: a %s delegate gets NOT_FOUND, not the gate",
        async (role) => {
          const { caller, resolveSpy, repos } = setup(role, {
            gateType: "PASSWORD",
            passwordHash: "set",
          });

          await expect(caller.resolveAudio({ eventId })).rejects.toMatchObject({
            code: "NOT_FOUND",
          });
          expect(repos.eventUnlocks.isUnlocked).not.toHaveBeenCalled();
          expect(resolveSpy).not.toHaveBeenCalled();
        },
      );
    });

    it("N3 before the gate on getPublicEventBody too: a gated DRAFT is NOT_FOUND via slug to a stranger, and the gate is never asked", async () => {
      const bodySpy = vi
        .spyOn(eventsUseCases, "getPublicEventBody")
        .mockResolvedValue({} as any);
      const repos = buildLockedEventReadRepos(eventId, {
        status: "DRAFT",
        publishedAt: null,
      });
      const { caller } = createCaller({
        repos,
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      const err: unknown = await caller
        .getPublicEventBody({ slug: "secret" })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "NOT_FOUND" });
      expect((err as { meta?: unknown }).meta).toMatchObject({
        via: "slug",
        appCode: "EVENT_NOT_FOUND",
      });
      expect(repos.eventUnlocks.isUnlocked).not.toHaveBeenCalled();
      expect(bodySpy).not.toHaveBeenCalled();
    });

    it("getPublicEventBody injects the session viewer, and rejects one smuggled in the input", async () => {
      const bodySpy = vi
        .spyOn(eventsUseCases, "getPublicEventBody")
        .mockResolvedValue({ eventId, body: null, imageMap: {} });
      const editorId = "11111111-1111-4111-8111-111111111111";
      const repos = buildLockedEventReadRepos(eventId, {
        status: "DRAFT",
        publishedAt: null,
      });
      vi.mocked(repos.authz.getOrgMembership).mockResolvedValue({
        orgId: "org-1",
        humanId: editorId,
        role: "EDITOR",
      } as never);
      const { caller } = createCaller({ repos, actorHumanId: editorId });

      await caller.getPublicEventBody({ slug: "secret" });
      expect(bodySpy).toHaveBeenCalledWith(expect.anything(), {
        slug: "secret",
        viewerHumanId: editorId,
      });

      await expect(
        caller.getPublicEventBody({
          slug: "secret",
          viewerHumanId: editorId,
        } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("allows full SEO reads with a valid signed password unlock cookie", async () => {
      const secret = "event-unlock-secret-with-at-least-32-chars";
      vi.spyOn(eventsUseCases, "getEventSeo").mockResolvedValue({
        id: eventId,
        slug: "secret",
        title: "Secret Show",
        startsAt: "2026-01-01T00:00:00.000Z",
        status: "PUBLISHED",
        attendanceMode: "TICKETED",
        stewardship: "OWNED",
        visibility: "PUBLIC",
        performers: [],
      });

      const { caller } = createCaller({
        repos: buildLockedEventReadRepos(eventId),
        actorHumanId: null,
        auth: null,
        authToken: null,
        eventUnlockSecret: secret,
        cookieHeader: buildEventUnlockCookie(eventId, secret),
      });

      const result = await caller.getEventSeo({ slug: "secret" });

      expect(result).toMatchObject({ id: eventId, title: "Secret Show" });
    });
  });

  describe("publishEvent", () => {
    const eventId = "33333333-3333-4333-8333-333333333333";
    const attestation = {
      legalRightToHost: true,
      zoningAndNoiseCompliance: true,
      alcoholCompliance: true,
      taxResponsibility: true,
      organizerFaqReviewed: true,
    };

    it("injects actor id and trusted request evidence", async () => {
      const publishedAt = new Date("2026-05-15T12:00:00.000Z");
      const publishSpy = vi
        .spyOn(eventsUseCases, "publishEvent")
        .mockResolvedValue({
          eventId,
          status: "PUBLISHED",
          publishedAt,
        });

      const { caller, ctx } = createCaller({
        clientIp: "198.51.100.10",
        userAgent: "PublishTest/1.0",
      });

      const result = await caller.publishEvent({
        eventId,
        clientKey: "publish-key-123",
        attestation,
      });

      expect(result).toEqual({ eventId, status: "PUBLISHED", publishedAt });
      expect(publishSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          idempotency: ctx.idempotency,
          clock: ctx.clock,
          logger: expect.anything(),
        }),
        expect.objectContaining({
          actorHumanId: ctx.actorHumanId,
          eventId,
          clientKey: "publish-key-123",
          ipAddress: "198.51.100.10",
          userAgent: "PublishTest/1.0",
          attestation,
        }),
      );
    });

    it("FR-018: dispatches the hold intents the publish owes AFTER it returns, with core's hint — and strips them from the wire", async () => {
      const dispatchMock = vi.mocked(dispatchBookingHoldIntents);
      dispatchMock.mockReset();
      dispatchMock.mockResolvedValue(undefined);
      const publishedAt = new Date("2026-05-15T12:00:00.000Z");
      const requestId = "44444444-4444-4444-8444-444444444444";
      const holdId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      const intents = [
        { kind: "hold.released" as const, bookingRequestId: requestId, holdId, audience: "act" as const, date: "2026-05-20", reason: "EVENT_SCHEDULED" as const },
      ];
      const staffRecipientHint = {
        assigneeHumanId: null,
        placedByHumanId: "00000000-0000-4000-8000-000000000003",
        orgId: "22222222-2222-4222-8222-222222222222",
        placeId: "33333333-3333-4333-8333-333333333333",
      };
      vi.spyOn(eventsUseCases, "publishEvent").mockResolvedValue({
        eventId,
        status: "PUBLISHED",
        publishedAt,
        notificationIntents: intents,
        staffRecipientHint,
      });
      const { caller } = createCaller();

      const result = await caller.publishEvent({ eventId, clientKey: "publish-key-123", attestation });

      expect(result).toEqual({ eventId, status: "PUBLISHED", publishedAt });
      expect("notificationIntents" in result).toBe(false);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock.mock.calls[0]![1]).toEqual({ intents, hint: staffRecipientHint, bookingRequestId: requestId });
    });

    it("FR-018: a publish that owes nothing never calls the dispatcher", async () => {
      const dispatchMock = vi.mocked(dispatchBookingHoldIntents);
      dispatchMock.mockReset();
      vi.spyOn(eventsUseCases, "publishEvent").mockResolvedValue({
        eventId,
        status: "PUBLISHED",
        publishedAt: new Date("2026-05-15T12:00:00.000Z"),
      });
      const { caller } = createCaller();
      await caller.publishEvent({ eventId, clientKey: "publish-key-123", attestation });
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("FR-018: a dispatcher outage never fails the committed publish (swallowed + reported)", async () => {
      const dispatchMock = vi.mocked(dispatchBookingHoldIntents);
      dispatchMock.mockReset();
      dispatchMock.mockRejectedValue(new Error("mailer down"));
      const publishedAt = new Date("2026-05-15T12:00:00.000Z");
      vi.spyOn(eventsUseCases, "publishEvent").mockResolvedValue({
        eventId,
        status: "PUBLISHED",
        publishedAt,
        notificationIntents: [
          { kind: "hold.released", bookingRequestId: "44444444-4444-4444-8444-444444444444", holdId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", audience: "act", date: "2026-05-20", reason: "EVENT_SCHEDULED" },
        ],
        staffRecipientHint: {
          assigneeHumanId: null,
          placedByHumanId: "00000000-0000-4000-8000-000000000003",
          orgId: null,
          placeId: "33333333-3333-4333-8333-333333333333",
        },
      });
      const reportError = vi.fn();
      const { caller } = createCaller({ reportError });

      const result = await caller.publishEvent({ eventId, clientKey: "publish-key-123", attestation });

      expect(result).toEqual({ eventId, status: "PUBLISHED", publishedAt });
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { area: "booking_holds", step: "notify_intents" } }));
    });

    it("FR-018: HOLD_LINE_HAS_OPEN_CHALLENGE maps to CONFLICT with the line meta", async () => {
      vi.spyOn(eventsUseCases, "publishEvent").mockRejectedValue(
        new AppError("HOLD_LINE_HAS_OPEN_CHALLENGE", {
          meta: { holdId: null, challengedHoldId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", calendarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", date: "2026-05-20" },
        }),
      );
      const { caller } = createCaller();

      await expect(
        caller.publishEvent({ eventId, clientKey: "publish-key-123", attestation }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        cause: { meta: { challengedHoldId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", date: "2026-05-20" } },
      });
      expect(vi.mocked(dispatchBookingHoldIntents)).not.toHaveBeenCalled();
    });

    it("maps incomplete attestation errors to precondition failures", async () => {
      vi.spyOn(eventsUseCases, "publishEvent").mockRejectedValue({
        code: "attestation_incomplete",
        message: "attestation_incomplete",
        meta: {
          missingFields: ["alcoholCompliance", "organizerFaqReviewed"],
        },
      });

      const { caller } = createCaller();

      await expect(
        caller.publishEvent({
          eventId,
          clientKey: "publish-key-123",
          attestation,
        }),
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message: "attestation_incomplete",
        cause: {
          meta: {
            missingFields: ["alcoholCompliance", "organizerFaqReviewed"],
          },
        },
      });
    });
  });

  describe("getRandomEvent", () => {
    it("forwards dependencies to the use case", async () => {
      const sampleEvent: eventsUseCases.GetRandomEventOutput = {
        id: "evt-test",
        slug: "lucky-night",
        title: "Lucky Night",
        startsAt: new Date("2025-02-01T00:00:00.000Z"),
        endsAt: null,
        status: "PUBLISHED",
        org: { id: "org-1", name: "Lucky Org" },
        place: { id: "place-1", name: "Lucky Venue" },
        location: {
          lat: 40.7128,
          lng: -74.006,
          addressText: "Brooklyn, NY",
          distanceKm: 4.2,
        },
        source: "geo",
        algo: {
          radiusKm: 25,
          windowFrom: new Date("2025-01-01T00:00:00.000Z"),
          windowTo: new Date("2025-03-01T00:00:00.000Z"),
          qPresent: false,
          hadGeoIndex: true,
        },
      };

      const getSpy = vi
        .spyOn(eventsUseCases, "getRandomEvent")
        .mockResolvedValue(sampleEvent);

      const { caller, ctx } = createCaller({ actorHumanId: null });
      const input = {
        seed: "ui-test",
        window: {
          from: new Date("2025-01-01T00:00:00.000Z"),
          to: new Date("2025-02-01T00:00:00.000Z"),
        },
      } satisfies Parameters<typeof eventsUseCases.getRandomEvent>[1];

      const result = await caller.getRandomEvent(input);

      expect(result).toEqual(sampleEvent);
      expect(getSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          idempotency: ctx.idempotency,
          clock: ctx.clock,
          logger: ctx.logger,
        }),
        input,
      );
    });

    it("H3: REJECTS publishedOnly: false at the boundary — the use case never runs", async () => {
      const spy = vi.spyOn(eventsUseCases, "getRandomEvent");
      const { caller } = createCaller({ actorHumanId: null });

      await expect(
        caller.getRandomEvent({ publishedOnly: false } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(spy).not.toHaveBeenCalled();
    });

    it("maps use case errors to TRPC errors", async () => {
      vi.spyOn(eventsUseCases, "getRandomEvent").mockRejectedValue({
        code: "invalid_input",
        message: "window_out_of_range",
      });

      const { caller } = createCaller({ actorHumanId: null });

      await expect(
        caller.getRandomEvent({
          seed: "ui-test",
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "window_out_of_range",
      });
    });
  });

  describe("localEvents", () => {
    it("forwards dependencies when region provided", async () => {
      const listSpy = vi
        .spyOn(eventsUseCases, "listEventsByLocation")
        .mockResolvedValue({
          events: [],
        });

      const { caller, ctx } = createCaller({
        actorHumanId: null,
        viewerLocation: viewerLocationFixture,
      });

      await caller.localEvents({ regionCode: "co", limit: 4 });

      expect(listSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          logger: ctx.logger,
        }),
        expect.objectContaining({
          regionCode: "co",
          limit: 4,
        }),
      );
    });

    it("falls back to viewer region when not provided", async () => {
      const listSpy = vi
        .spyOn(eventsUseCases, "listEventsByLocation")
        .mockResolvedValue({
          events: [],
        });

      const viewerRegion = {
        ...viewerLocationFixture,
        regionCode: "or",
      } as const;
      const { caller, ctx } = createCaller({
        actorHumanId: null,
        viewerLocation: viewerRegion,
      });

      await caller.localEvents({ limit: 3 });

      expect(listSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          logger: ctx.logger,
        }),
        expect.objectContaining({
          regionCode: "or",
          limit: 3,
          offset: 0,
        }),
      );
    });

    it("uses configured fallback region when viewer location missing", async () => {
      const listSpy = vi
        .spyOn(eventsUseCases, "listEventsByLocation")
        .mockResolvedValue({
          events: [],
        });

      process.env.THC_EVENTS_DEFAULT_REGION_CODE = "il";

      const { caller, ctx } = createCaller({
        actorHumanId: null,
        viewerLocation: null,
      });

      await caller.localEvents({ limit: 2 });

      expect(listSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          logger: ctx.logger,
        }),
        expect.objectContaining({
          regionCode: "il",
          limit: 2,
        }),
      );
    });

    it("throws when no region can be determined", async () => {
      vi.spyOn(eventsUseCases, "listEventsByLocation").mockResolvedValue({
        events: [],
      });

      const { caller } = createCaller({
        actorHumanId: null,
        viewerLocation: null,
      });

      await expect(caller.localEvents({ limit: 1 })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "region_required",
      });
    });

    it("maps use case errors to TRPC errors", async () => {
      vi.spyOn(eventsUseCases, "listEventsByLocation").mockRejectedValue({
        code: "transient",
        message: "no_events",
      });

      const { caller } = createCaller({
        actorHumanId: null,
        viewerLocation: viewerLocationFixture,
      });

      await expect(
        caller.localEvents({ limit: 1, regionCode: "ny" }),
      ).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: "no_events",
      });
    });
  });

  describe("nearbyEvents", () => {
    it("forwards geo dependencies to the use case", async () => {
      const listSpy = vi
        .spyOn(eventsUseCases, "listEventsNearCoordinate")
        .mockResolvedValue({
          events: [],
        });

      const { caller, ctx } = createCaller({ actorHumanId: null });

      const input = {
        lat: 40.7128,
        lng: -74.006,
        radiusM: 10_000,
        limit: 4,
        offset: 1,
      };
      await caller.nearbyEvents(input);

      expect(listSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          geo: ctx.geo,
          logger: ctx.logger,
        }),
        input,
      );
    });

    it("maps use case errors to TRPC errors", async () => {
      vi.spyOn(eventsUseCases, "listEventsNearCoordinate").mockRejectedValue({
        code: "invalid_input",
        message: "bad_coords",
      });

      const { caller } = createCaller({ actorHumanId: null });

      await expect(
        caller.nearbyEvents({
          lat: 40.7,
          lng: -73.9,
          radiusM: 5_000,
          limit: 2,
          offset: 0,
        }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "bad_coords",
      });
    });
  });

  describe("searchPublishedEvents", () => {
    it("forwards dependencies to the use case", async () => {
      const searchSpy = vi
        .spyOn(eventsUseCases, "searchPublishedEvents")
        .mockResolvedValue({
          suggestions: [],
        });

      const { caller, ctx } = createCaller({ actorHumanId: null });

      await caller.searchPublishedEvents({ query: "summer" });

      expect(searchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          logger: ctx.logger,
        }),
        expect.objectContaining({ query: "summer" }),
      );
    });

    it("maps use case errors to TRPC errors", async () => {
      vi.spyOn(eventsUseCases, "searchPublishedEvents").mockRejectedValue({
        code: "invalid_input",
        message: "query_too_short",
      });

      const { caller } = createCaller({ actorHumanId: null });

      await expect(
        caller.searchPublishedEvents({ query: "s" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });
  });

  describe("resolveEventBySlug", () => {
    it("forwards repos and logger to resolveEventBySlug use case", async () => {
      const resolveSpy = vi
        .spyOn(eventsUseCases, "resolveEventBySlug")
        .mockResolvedValue({
          eventId: "123e4567-e89b-12d3-a456-426614174000",
          currentSlug: "new-hotness",
          redirect: false,
        });

      const { caller, ctx } = createCaller({ actorHumanId: null });

      const input = { slug: "old-slug" };
      const result = await caller.resolveEventBySlug(input);

      expect(result).toEqual({
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        currentSlug: "new-hotness",
        redirect: false,
      });
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          logger: ctx.logger,
        }),
        { ...input, viewerHumanId: null },
      );
    });

    it("injects the session viewer, and ignores one smuggled in the input", async () => {
      const resolveSpy = vi
        .spyOn(eventsUseCases, "resolveEventBySlug")
        .mockResolvedValue({
          eventId: "123e4567-e89b-12d3-a456-426614174000",
          currentSlug: "new-hotness",
          redirect: true,
        });

      const { caller } = createCaller({ actorHumanId: "human-actor" });

      await caller.resolveEventBySlug({ slug: "old-slug" });

      expect(resolveSpy).toHaveBeenCalledWith(expect.anything(), {
        slug: "old-slug",
        viewerHumanId: "human-actor",
      });

      await expect(
        caller.resolveEventBySlug({
          slug: "old-slug",
          viewerHumanId: "123e4567-e89b-12d3-a456-426614174999",
        } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("maps use case errors to TRPC errors", async () => {
      vi.spyOn(eventsUseCases, "resolveEventBySlug").mockRejectedValue({
        code: "not_found",
        message: "event_slug_not_found",
      });

      const { caller } = createCaller({ actorHumanId: null });

      await expect(
        caller.resolveEventBySlug({ slug: "missing" }),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
        message: "event_slug_not_found",
      });
    });
  });

  describe("resolveEventShortLink", () => {
    it("forwards repos and logger to the use case, with no viewer", async () => {
      const resolveSpy = vi
        .spyOn(shortLinkUseCase, "resolveEventShortLink")
        .mockResolvedValue({ currentSlug: "org/us/general/show--wqsdk6pxzi" });

      const { caller, ctx } = createCaller({ actorHumanId: "human-actor" });

      const result = await caller.resolveEventShortLink({
        shortId: "wqsdk6pxzi",
      });

      expect(result).toEqual({
        currentSlug: "org/us/general/show--wqsdk6pxzi",
      });
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      // The session viewer never reaches the use case: the answer is the
      // same for everybody.
      expect(resolveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ repos: ctx.repos, logger: ctx.logger }),
        { shortId: "wqsdk6pxzi" },
      );
    });

    it("maps EVENT_NOT_FOUND to NOT_FOUND", async () => {
      vi.spyOn(shortLinkUseCase, "resolveEventShortLink").mockRejectedValue(
        new AppError("EVENT_NOT_FOUND", { meta: { via: "slug" } }),
      );

      const { caller } = createCaller({ actorHumanId: null });

      await expect(
        caller.resolveEventShortLink({ shortId: "zzzzzzzzzz" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects a smuggled viewer in the input", async () => {
      const resolveSpy = vi.spyOn(shortLinkUseCase, "resolveEventShortLink");
      const { caller } = createCaller({ actorHumanId: null });

      await expect(
        caller.resolveEventShortLink({
          shortId: "wqsdk6pxzi",
          viewerHumanId: "123e4567-e89b-12d3-a456-426614174999",
        } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(resolveSpy).not.toHaveBeenCalled();
    });
  });

  describe("regenerateEventSlug", () => {
    it("injects actor human id and forwards dependencies", async () => {
      const regenerateSpy = vi
        .spyOn(eventsUseCases, "regenerateEventSlug")
        .mockResolvedValue({
          eventId: "123e4567-e89b-12d3-a456-426614174000",
          previousSlug: "old-slug",
          newSlug: "new-slug",
        });

      const { caller, ctx } = createCaller();

      const input = {
        eventId: "33333333-3333-4333-8333-333333333333",
        clientKey: "abcdefghi",
      };

      const result = await caller.regenerateEventSlug(input);

      expect(result).toEqual({
        eventId: "123e4567-e89b-12d3-a456-426614174000",
        previousSlug: "old-slug",
        newSlug: "new-slug",
      });

      expect(regenerateSpy).toHaveBeenCalledTimes(1);
      expect(regenerateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          idempotency: ctx.idempotency,
          clock: ctx.clock,
          logger: expect.anything(),
        }),
        expect.objectContaining({
          actorHumanId: ctx.actorHumanId,
          eventId: input.eventId,
          clientKey: input.clientKey,
        }),
      );
    });

    it("rejects when actor human id is missing", async () => {
      const regenerateSpy = vi
        .spyOn(eventsUseCases, "regenerateEventSlug")
        .mockResolvedValue({
          eventId: "123e4567-e89b-12d3-a456-426614174000",
          previousSlug: "old-slug",
          newSlug: "new-slug",
        });

      const { caller } = createCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      await expect(
        caller.regenerateEventSlug({
          eventId: "33333333-3333-4333-8333-333333333333",
          clientKey: "abcdefghi",
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      expect(regenerateSpy).not.toHaveBeenCalled();
    });

    it("maps use case errors to TRPC errors", async () => {
      vi.spyOn(eventsUseCases, "regenerateEventSlug").mockRejectedValue({
        code: "conflict",
        message: "event_slug_conflict",
      });

      const { caller } = createCaller();

      await expect(
        caller.regenerateEventSlug({
          eventId: "33333333-3333-4333-8333-333333333333",
          clientKey: "abcdefghi",
        }),
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "event_slug_conflict",
      });
    });
  });

  describe("featureEvent", () => {
    it("injects actor human id and forwards dependencies", async () => {
      const featureSpy = vi
        .spyOn(eventsUseCases, "featureEvent")
        .mockResolvedValue({
          eventId: "22222222-2222-4222-8222-222222222222",
          curatedUntil: new Date("2025-05-02T00:00:00.000Z"),
          featuredAt: new Date("2025-04-15T00:00:00.000Z"),
        });

      const { caller, ctx } = createCaller();

      const input = {
        eventId: "22222222-2222-4222-8222-222222222222",
        curatedUntil: new Date("2025-05-02T00:00:00.000Z"),
        notes: "priority placement",
      };

      await caller.featureEvent(input);

      expect(featureSpy).toHaveBeenCalledTimes(1);
      const [depsArg, payloadArg] = featureSpy.mock.calls[0] ?? [];
      expect(depsArg).toMatchObject({
        repos: ctx.repos,
        clock: ctx.clock,
      });
      expect(typeof (depsArg as any)?.logger?.info).toBe("function");
      expect(payloadArg).toMatchObject({
        actorHumanId: ctx.actorHumanId,
        eventId: input.eventId,
        notes: input.notes,
      });
      const featurePayload = payloadArg as
        | { curatedUntil?: Date | null }
        | undefined;
      expect(featurePayload?.curatedUntil?.toISOString()).toEqual(
        input.curatedUntil.toISOString(),
      );
    });

    it("rejects when actor human id missing", async () => {
      const featureSpy = vi
        .spyOn(eventsUseCases, "featureEvent")
        .mockResolvedValue({
          eventId: "22222222-2222-4222-8222-222222222222",
          curatedUntil: new Date("2025-05-02T00:00:00.000Z"),
          featuredAt: new Date("2025-04-15T00:00:00.000Z"),
        });

      const { caller } = createCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      await expect(
        caller.featureEvent({
          eventId: "22222222-2222-4222-8222-222222222222",
          curatedUntil: new Date(),
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      expect(featureSpy).not.toHaveBeenCalled();
    });

    it("maps use case errors", async () => {
      vi.spyOn(eventsUseCases, "featureEvent").mockRejectedValue({
        code: "forbidden",
        message: "admin_required",
      });

      const { caller } = createCaller();

      await expect(
        caller.featureEvent({
          eventId: "22222222-2222-4222-8222-222222222222",
          curatedUntil: new Date(),
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", message: "admin_required" });
    });
  });

  describe("setEventListingPriority", () => {
    it("injects actor id and forwards dependencies", async () => {
      const setSpy = vi
        .spyOn(eventsUseCases, "setEventListingPriority")
        .mockResolvedValue({
          eventId: "22222222-2222-4222-8222-222222222222",
          listingPriority: 10,
        });

      const { caller, ctx } = createCaller();

      await caller.setEventListingPriority({
        eventId: "22222222-2222-4222-8222-222222222222",
        priority: 10,
      });

      expect(setSpy).toHaveBeenCalledTimes(1);
      const [setDepsArg, setPayloadArg] = setSpy.mock.calls[0] ?? [];
      expect(setDepsArg).toMatchObject({
        repos: ctx.repos,
        clock: ctx.clock,
      });
      expect(typeof (setDepsArg as any)?.logger?.info).toBe("function");
      expect(setPayloadArg).toMatchObject({
        actorHumanId: ctx.actorHumanId,
        eventId: "22222222-2222-4222-8222-222222222222",
        priority: 10,
      });
    });

    it("rejects when actor id missing", async () => {
      const setSpy = vi
        .spyOn(eventsUseCases, "setEventListingPriority")
        .mockResolvedValue({
          eventId: "22222222-2222-4222-8222-222222222222",
          listingPriority: 5,
        });

      const { caller } = createCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      await expect(
        caller.setEventListingPriority({
          eventId: "22222222-2222-4222-8222-222222222222",
          priority: 5,
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      expect(setSpy).not.toHaveBeenCalled();
    });

    it("maps use case errors", async () => {
      vi.spyOn(eventsUseCases, "setEventListingPriority").mockRejectedValue({
        code: "forbidden",
        message: "not_allowed",
      });

      const { caller } = createCaller();

      await expect(
        caller.setEventListingPriority({
          eventId: "22222222-2222-4222-8222-222222222222",
          priority: -1,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", message: "not_allowed" });
    });
  });

  describe("createEventForHuman", () => {
    it("injects actor human id and forwards dependencies", async () => {
      const createSpy = vi
        .spyOn(eventsUseCases, "saveEventForHuman")
        .mockResolvedValue({
          eventId: "99999999-9999-4999-8999-999999999999",
          status: "DRAFT",
          bookingRequest: null,
        });

      const { caller, ctx } = createCaller();

      const content = {
        layoutId: "default",
        blocks: [
          {
            id: "block-1",
            type: "richText",
            doc: { type: "doc", content: [] },
          },
        ],
      };

      const result = await caller.createEventForHuman({
        title: "My human event",
        startsAt: "2024-02-01T10:00:00.000Z",
        endsAt: "2024-02-01T12:00:00.000Z",
        location: { placeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        content,
        clientKey: "abcdefgh",
      });

      expect(result).toEqual({
        eventId: "99999999-9999-4999-8999-999999999999",
        status: "DRAFT",
        bookingRequest: null,
      });

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          idempotency: ctx.idempotency,
          clock: ctx.clock,
          logger: expect.objectContaining({ info: expect.any(Function) }),
        }),
        expect.objectContaining({
          actorHumanId: ctx.actorHumanId,
          title: "My human event",
          startsAt: "2024-02-01T10:00:00.000Z",
          endsAt: "2024-02-01T12:00:00.000Z",
          location: { placeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          content,
          clientKey: "abcdefgh",
        }),
      );
    });

    it("rejects when actor human id is missing", async () => {
      const createSpy = vi
        .spyOn(eventsUseCases, "saveEventForHuman")
        .mockResolvedValue({
          eventId: "99999999-9999-4999-8999-999999999999",
          status: "DRAFT",
          bookingRequest: null,
        });

      const { caller } = createCaller({
        actorHumanId: null,
        auth: null,
        authToken: null,
      });

      await expect(
        caller.createEventForHuman({
          title: "hello",
          startsAt: "2024-02-01T10:00:00.000Z",
          endsAt: "2024-02-01T12:00:00.000Z",
          location: {},
          clientKey: "abcdefgh",
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      expect(createSpy).not.toHaveBeenCalled();
    });

    it("maps use case errors to TRPC errors", async () => {
      vi.spyOn(eventsUseCases, "saveEventForHuman").mockRejectedValue({
        code: "invalid_input",
        message: "title_required",
      });

      const { caller } = createCaller();

      await expect(
        caller.createEventForHuman({
          title: "Human Event",
          startsAt: "2024-02-01T10:00:00.000Z",
          endsAt: "2024-02-01T12:00:00.000Z",
          location: {},
          clientKey: "abcdefgh",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("createEventForOrg / createEventForHuman — event-first booking-request intents", () => {
    const eventId = "99999999-9999-4999-8999-999999999999";
    const requestId = "44444444-4444-4444-8444-444444444444";
    const placeId = "33333333-3333-4333-8333-333333333333";
    const at = new Date("2026-09-07T12:00:00.000Z");
    const baseInput = {
      title: "Basement Show",
      startsAt: "2026-10-03T01:30:00.000Z",
      endsAt: "2026-10-03T04:00:00.000Z",
      location: { placeId },
      calendarId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      clientKey: "abcdefgh",
    };

    it("createEventForOrg: dispatches the intents the save owes AFTER it returns, and strips them from the wire", async () => {
      const dispatchMock = vi.mocked(dispatchBookingRequestIntents);
      dispatchMock.mockReset();
      dispatchMock.mockResolvedValue(undefined);
      const intents = [{ kind: "request.received" as const, bookingRequestId: requestId, placeId, at }];
      const saveSpy = vi.spyOn(eventsUseCases, "saveEventForOrg").mockResolvedValue({
        eventId,
        status: "DRAFT",
        bookingRequestNotificationIntents: intents,
        bookingRequest: null,
      });
      const { caller } = createCaller({ publicAppUrl: "https://ithasfire.test" });

      const result = await caller.createEventForOrg({
        ...baseInput,
        orgId: "22222222-2222-4222-8222-222222222222",
        bookingIntent: "PERFORM",
      });

      expect(result).toEqual({ eventId, status: "DRAFT", bookingRequest: null });
      expect("bookingRequestNotificationIntents" in result).toBe(false);
      // The intent reaches the use case through the input schema.
      expect(saveSpy.mock.calls[0]![1]).toEqual(expect.objectContaining({ bookingIntent: "PERFORM" }));
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock.mock.calls[0]![1]).toEqual({ intents });
    });

    it("createEventForHuman: the received notice is dispatched; a save that owes nothing never calls the dispatcher", async () => {
      const dispatchMock = vi.mocked(dispatchBookingRequestIntents);
      dispatchMock.mockReset();
      dispatchMock.mockResolvedValue(undefined);
      const intents = [
        // The only intent kind since the 2026-09-25 amendment removed the
        // claim invite with parking.
        { kind: "request.received" as const, bookingRequestId: requestId, placeId, at },
      ];
      vi.spyOn(eventsUseCases, "saveEventForHuman").mockResolvedValueOnce({
        eventId,
        status: "DRAFT",
        bookingRequestNotificationIntents: intents,
        bookingRequest: null,
      });
      const { caller } = createCaller({ publicAppUrl: "https://ithasfire.test" });

      const result = await caller.createEventForHuman(baseInput);
      expect(result).toEqual({ eventId, status: "DRAFT", bookingRequest: null });
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock.mock.calls[0]![1]).toEqual({ intents });

      dispatchMock.mockReset();
      vi.spyOn(eventsUseCases, "saveEventForHuman").mockResolvedValueOnce({ eventId, status: "DRAFT", bookingRequest: null });
      await caller.createEventForHuman(baseInput);
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it("a dispatcher outage never fails the committed save (swallowed + reported)", async () => {
      const dispatchMock = vi.mocked(dispatchBookingRequestIntents);
      dispatchMock.mockReset();
      dispatchMock.mockRejectedValue(new Error("mailer down"));
      vi.spyOn(eventsUseCases, "saveEventForHuman").mockResolvedValue({
        eventId,
        status: "DRAFT",
        bookingRequestNotificationIntents: [{ kind: "request.received", bookingRequestId: requestId, placeId, at }],
        bookingRequest: null,
      });
      const reportError = vi.fn();
      const { caller } = createCaller({ reportError, publicAppUrl: "https://ithasfire.test" });

      const result = await caller.createEventForHuman(baseInput);

      expect(result).toEqual({ eventId, status: "DRAFT", bookingRequest: null });
      expect(reportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { area: "booking_requests", step: "notify_intents" } }),
      );
    });
  });

  describe("createEventForOrg", () => {
    it("injects actor human id and forwards dependencies (incl body)", async () => {
      const upsertSpy = vi
        .spyOn(eventsUseCases, "saveEventForOrg")
        .mockResolvedValue({
          eventId: "88888888-8888-4888-8888-888888888888",
          status: "DRAFT",
          bookingRequest: null,
        });

      const { caller, ctx } = createCaller();

      const content = {
        layoutId: "default",
        blocks: [
          {
            id: "block-1",
            type: "richText",
            doc: { type: "doc", content: [] },
          },
        ],
      };

      const result = await caller.createEventForOrg({
        orgId: "11111111-1111-4111-8111-111111111111",
        title: "My org event",
        startsAt: "2024-02-01T10:00:00.000Z",
        endsAt: "2024-02-01T12:00:00.000Z",
        location: { placeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        content,
        clientKey: "abcdefgh",
      });

      expect(result).toEqual({
        eventId: "88888888-8888-4888-8888-888888888888",
        status: "DRAFT",
        bookingRequest: null,
      });

      expect(upsertSpy).toHaveBeenCalledTimes(1);
      expect(upsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repos: ctx.repos,
          idempotency: ctx.idempotency,
          clock: ctx.clock,
          logger: expect.objectContaining({ info: expect.any(Function) }),
        }),
        expect.objectContaining({
          actorHumanId: ctx.actorHumanId,
          orgId: "11111111-1111-4111-8111-111111111111",
          title: "My org event",
          startsAt: "2024-02-01T10:00:00.000Z",
          endsAt: "2024-02-01T12:00:00.000Z",
          location: { placeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
          content,
          clientKey: "abcdefgh",
        }),
      );
    });
  });

  // ── venue-hierarchy placement pass-through (FR-011) ──────────────────────
  // The procedure inputs DERIVE from the use-case schemas, so these keys ride
  // through with no transport code of their own. That is exactly why they need
  // a test: a future `.pick()`/`.omit()` on either input would silently drop
  // the placement and the calendar cell would stop persisting its space again.
  describe("venue-hierarchy placement", () => {
    const CALENDAR_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const SPACE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const PLACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    it("forwards calendarId + spaceId to saveEventForOrg", async () => {
      const spy = vi
        .spyOn(eventsUseCases, "saveEventForOrg")
        .mockResolvedValue({
          eventId: "88888888-8888-4888-8888-888888888888",
          status: "DRAFT",
          bookingRequest: null,
        });

      const { caller } = createCaller();
      await caller.createEventForOrg({
        orgId: "11111111-1111-4111-8111-111111111111",
        title: "Placed org event",
        startsAt: "2024-02-01T10:00:00.000Z",
        endsAt: "2024-02-01T12:00:00.000Z",
        location: { placeId: PLACE_ID },
        calendarId: CALENDAR_ID,
        spaceId: SPACE_ID,
        clientKey: "abcdefgh",
      });

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          calendarId: CALENDAR_ID,
          spaceId: SPACE_ID,
        }),
      );
    });

    it("threads the timezone lookup + reporter into the org save deps", async () => {
      // Without the port the freeform-address branch of the save chain has
      // nothing to derive from and the event silently lands on the platform
      // default — the exact gap this wiring closes (venue-hierarchy FR-004).
      const timezoneLookup = vi.fn(() => "America/New_York");
      const reportError = vi.fn();
      const spy = vi
        .spyOn(eventsUseCases, "saveEventForOrg")
        .mockResolvedValue({
          eventId: "88888888-8888-4888-8888-888888888888",
          status: "DRAFT",
          bookingRequest: null,
        });

      const { caller } = createCaller({ timezoneLookup, reportError });
      await caller.createEventForOrg({
        orgId: "11111111-1111-4111-8111-111111111111",
        title: "Freeform org event",
        startsAt: "2024-02-01T10:00:00.000Z",
        endsAt: "2024-02-01T12:00:00.000Z",
        location: {
          addressText: "85 Delancey St, New York, NY 10002",
          lat: 40.7182,
          lng: -73.9884,
        },
        clientKey: "abcdefgh",
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ timezoneLookup, reportError }),
        expect.anything(),
      );
    });

    it("threads the timezone lookup + reporter into the human save deps", async () => {
      const timezoneLookup = vi.fn(() => "America/New_York");
      const reportError = vi.fn();
      const spy = vi
        .spyOn(eventsUseCases, "saveEventForHuman")
        .mockResolvedValue({
          eventId: "99999999-9999-4999-8999-999999999999",
          status: "DRAFT",
          bookingRequest: null,
        });

      const { caller } = createCaller({ timezoneLookup, reportError });
      await caller.createEventForHuman({
        title: "Freeform human event",
        startsAt: "2024-02-01T10:00:00.000Z",
        endsAt: "2024-02-01T12:00:00.000Z",
        location: {
          addressText: "85 Delancey St, New York, NY 10002",
          lat: 40.7182,
          lng: -73.9884,
        },
        clientKey: "abcdefgh",
      });

      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ timezoneLookup, reportError }),
        expect.anything(),
      );
    });

    it("forwards calendarId + spaceId to saveEventForHuman", async () => {
      const spy = vi
        .spyOn(eventsUseCases, "saveEventForHuman")
        .mockResolvedValue({
          eventId: "99999999-9999-4999-8999-999999999999",
          status: "DRAFT",
          bookingRequest: null,
        });

      const { caller } = createCaller();
      await caller.createEventForHuman({
        title: "Placed human event",
        startsAt: "2024-02-01T10:00:00.000Z",
        endsAt: "2024-02-01T12:00:00.000Z",
        location: { placeId: PLACE_ID },
        calendarId: CALENDAR_ID,
        spaceId: SPACE_ID,
        clientKey: "abcdefgh",
      });

      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          calendarId: CALENDAR_ID,
          spaceId: SPACE_ID,
        }),
      );
    });

    it("stays optional — an unplaced create sends neither key", async () => {
      const spy = vi
        .spyOn(eventsUseCases, "saveEventForHuman")
        .mockResolvedValue({
          eventId: "99999999-9999-4999-8999-999999999999",
          status: "DRAFT",
          bookingRequest: null,
        });

      const { caller } = createCaller();
      await caller.createEventForHuman({
        title: "Unplaced",
        startsAt: "2024-02-01T10:00:00.000Z",
        endsAt: "2024-02-01T12:00:00.000Z",
        location: { placeId: PLACE_ID },
        clientKey: "abcdefgh",
      });

      const payload = spy.mock.calls[0]![1] as Record<string, unknown>;
      expect("calendarId" in payload).toBe(false);
      expect("spaceId" in payload).toBe(false);
    });

    it("rejects a malformed placement id at the transport boundary", async () => {
      const spy = vi.spyOn(eventsUseCases, "saveEventForHuman");

      const { caller } = createCaller();
      await expect(
        caller.createEventForHuman({
          title: "Bad placement",
          startsAt: "2024-02-01T10:00:00.000Z",
          endsAt: "2024-02-01T12:00:00.000Z",
          location: { placeId: PLACE_ID },
          calendarId: "not-a-uuid",
          clientKey: "abcdefgh",
        } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("getEventProvenance", () => {
    const PROVENANCE_EVENT_ID = "06a63d13-ee9d-468b-9e81-c1a5b57d94c3";
    const CTX_ACTOR = "11111111-1111-4111-8111-111111111111";
    const CLIENT_SUPPLIED_ACTOR = "99999999-9999-4999-8999-999999999999";

    it("passes the CTX actor through and accepts a null provenance answer", async () => {
      const spy = vi
        .spyOn(eventsUseCases, "getEventProvenance")
        .mockResolvedValue(null);

      const { caller } = createCaller({ actorHumanId: CTX_ACTOR });

      // Null is the common case (most events were never booked), so it has to
      // survive the procedure's `.output()` schema, not just the use case.
      await expect(
        caller.getEventProvenance({ eventId: PROVENANCE_EVENT_ID }),
      ).resolves.toBeNull();
      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        { eventId: PROVENANCE_EVENT_ID, actorHumanId: CTX_ACTOR },
      );
    });

    it("returns the full breadcrumb through the output schema", async () => {
      vi.spyOn(eventsUseCases, "getEventProvenance").mockResolvedValue({
        agreement: {
          id: "3ce6d991-e9be-4990-955a-4597085e1454",
          status: "ACCEPTED",
          linkedVia: "DRAFT_EVENT",
          title: "Dev Login MXN — The Basement",
          proposedDate: new Date("2026-09-04T01:00:00.000Z"),
          proposedEndDate: null,
          guaranteeCents: 30_000,
          payoutLineCount: 2,
        },
        bookingRequest: {
          id: "162150b9-2668-436e-86d7-f58943a4a9d6",
          status: "ACCEPTED",
          direction: "TO_VENUE",
          senderDisplayName: "Dev Login MXN",
          lastMessageAt: new Date("2026-08-20T20:42:29.721Z"),
          // The venue-confirmation leg (event-first builder band) — required
          // on the wire, read off the same request row for both chains.
          intent: "PERFORM",
          placeId: "00000000-0000-4000-8000-00000000d030",
          placeName: "The Basement",
          parked: false,
        },
        // Venue-confirmation spec: the editor's banner needs the venue's
        // stance, whose event it is, and the place's name.
        venueConfirmation: {
          state: "confirmed",
          ownerSide: "requester",
          placeName: "The Basement",
        },
      });

      const { caller } = createCaller({ actorHumanId: CTX_ACTOR });

      await expect(
        caller.getEventProvenance({ eventId: PROVENANCE_EVENT_ID }),
      ).resolves.toMatchObject({
        agreement: {
          linkedVia: "DRAFT_EVENT",
          guaranteeCents: 30_000,
          payoutLineCount: 2,
        },
        bookingRequest: { senderDisplayName: "Dev Login MXN" },
        venueConfirmation: {
          state: "confirmed",
          ownerSide: "requester",
          placeName: "The Basement",
        },
      });
    });

    it("refuses a client-supplied actorHumanId outright", async () => {
      const spy = vi.spyOn(eventsUseCases, "getEventProvenance");

      const { caller } = createCaller({ actorHumanId: CTX_ACTOR });

      // The input schema omits `actorHumanId` and is `.strict()`, so a client
      // trying to name someone else is rejected at the boundary rather than
      // silently overridden.
      await expect(
        caller.getEventProvenance({
          eventId: PROVENANCE_EVENT_ID,
          actorHumanId: CLIENT_SUPPLIED_ACTOR,
        } as never),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(spy).not.toHaveBeenCalled();
    });

    it("maps a typed authorization failure through toTrpcError", async () => {
      vi.spyOn(eventsUseCases, "getEventProvenance").mockRejectedValue(
        new AppError("INSUFFICIENT_ROLE"),
      );

      const { caller } = createCaller({ actorHumanId: CTX_ACTOR });

      await expect(
        caller.getEventProvenance({ eventId: PROVENANCE_EVENT_ID }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// joinEventWaitlist — `waitlists` feature gate (server-side enforcement)
//
// The gate hides every render site, but `joinEventWaitlist` is an
// `optionalProcedure` (unauthenticated) that persists a fan's email. Events
// whose `waitlistStatus` was already OPEN before the gate landed would keep
// accepting anonymous POSTs — and EventGateSettings now hides the control an
// organiser would use to close them. So the write must be blocked too.
// ─────────────────────────────────────────────────────────────────────────────

describe("eventsRouter.joinEventWaitlist — waitlists gate", () => {
  const EVENT_ID = "55555555-5555-4555-8555-555555555555";

  const platformSettingsRepo = (rows: Array<{ key: string; value: string }>) =>
    ({
      platformSettings: { getAll: vi.fn().mockResolvedValue(rows) },
    }) as unknown as Ctx["repos"];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects with FORBIDDEN when the gate is off (env default)", async () => {
    const spy = vi.spyOn(eventsUseCases, "joinEventWaitlist");

    // No enableWaitlists override and no platformSettings repo → the gate
    // resolves to its default-OFF state.
    const { caller } = createCaller({ actorHumanId: null });

    await expect(
      caller.joinEventWaitlist({
        eventId: EVENT_ID,
        contactEmail: "fan@example.com",
        contactPhone: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The use case must never run — no WaitlistEntry row, no PII persisted.
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects with FORBIDDEN when the gate is explicitly disabled via env", async () => {
    const spy = vi.spyOn(eventsUseCases, "joinEventWaitlist");
    const { caller } = createCaller({
      actorHumanId: null,
      enableWaitlists: false,
    });

    await expect(
      caller.joinEventWaitlist({
        eventId: EVENT_ID,
        contactEmail: "fan@example.com",
        contactPhone: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("honours a DB override turning waitlists ON when env leaves it off", async () => {
    const spy = vi
      .spyOn(eventsUseCases, "joinEventWaitlist")
      .mockResolvedValue({
        eventId: EVENT_ID,
        alreadyJoined: false,
        entry: {
          id: "66666666-6666-4666-8666-666666666666",
          eventId: EVENT_ID,
          humanId: null,
          contactEmail: "fan@example.com",
          contactPhone: null,
          source: "PUBLIC",
          status: "PENDING",
          metadata: {},
          notifiedAt: null,
          convertedOrderId: null,
          createdAt: new Date("2026-08-04T00:00:00.000Z"),
          updatedAt: new Date("2026-08-04T00:00:00.000Z"),
        },
      } as unknown as Awaited<
        ReturnType<typeof eventsUseCases.joinEventWaitlist>
      >);

    const { caller } = createCaller({
      actorHumanId: null,
      repos: platformSettingsRepo([
        { key: "feature:waitlists", value: "true" },
      ]),
    });

    await caller.joinEventWaitlist({
      eventId: EVENT_ID,
      contactEmail: "fan@example.com",
      contactPhone: null,
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("honours a DB override turning waitlists OFF even when env enables it", async () => {
    const spy = vi.spyOn(eventsUseCases, "joinEventWaitlist");

    const { caller } = createCaller({
      actorHumanId: null,
      enableWaitlists: true,
      repos: platformSettingsRepo([
        { key: "feature:waitlists", value: "false" },
      ]),
    });

    await expect(
      caller.joinEventWaitlist({
        eventId: EVENT_ID,
        contactEmail: "fan@example.com",
        contactPhone: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the platform-settings read throws", async () => {
    const spy = vi.spyOn(eventsUseCases, "joinEventWaitlist");

    const { caller } = createCaller({
      actorHumanId: null,
      repos: {
        platformSettings: {
          getAll: vi.fn().mockRejectedValue(new Error("DB down")),
        },
      } as unknown as Ctx["repos"],
    });

    await expect(
      caller.joinEventWaitlist({
        eventId: EVENT_ID,
        contactEmail: "fan@example.com",
        contactPhone: null,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(spy).not.toHaveBeenCalled();
  });
});

// The public lists swallow a failed venue read inside
// `resolveVenueConfirmationByEvent` (degrade, don't fail the page). The
// ReporterPort convention needs that swallow in Sentry — so each route must
// hand `ctx.reportError` to its use case.
describe("eventsRouter — public lists forward the reporter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("localEvents", async () => {
    const reportError = vi.fn();
    const spy = vi
      .spyOn(eventsUseCases, "listEventsByLocation")
      .mockResolvedValue({ events: [] });
    const { caller } = createCaller({ actorHumanId: null, reportError });

    await caller.localEvents({ regionCode: "co", limit: 4 });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ reportError }),
      expect.anything(),
    );
  });

  it("countryEvents", async () => {
    const reportError = vi.fn();
    const spy = vi
      .spyOn(eventsUseCases, "listEventsByCountry")
      .mockResolvedValue({ events: [] });
    const { caller } = createCaller({ actorHumanId: null, reportError });

    await caller.countryEvents({ countryCode: "US", limit: 4 });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ reportError }),
      expect.anything(),
    );
  });

  it("geoCategoryEvents", async () => {
    const reportError = vi.fn();
    const spy = vi
      .spyOn(eventsUseCases, "listEventsByCategoryAndCity")
      .mockResolvedValue({
        events: [],
        total: 0,
        indexableTotal: 0,
        categoryName: "Music",
        names: { en: "Music", es: "Música" },
        cityLabel: "Nashville, TN",
        regionCode: "tn",
      });
    const { caller } = createCaller({ actorHumanId: null, reportError });

    await caller.geoCategoryEvents({
      categorySlug: "music",
      citySegment: "nashville-tn",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ reportError }),
      expect.anything(),
    );
  });

  it("geoCategoryEvents passes the ungated count through", async () => {
    vi.spyOn(eventsUseCases, "listEventsByCategoryAndCity").mockResolvedValue({
      events: [],
      total: 3,
      indexableTotal: 2,
      categoryName: "Music",
      names: { en: "Music", es: "Música" },
      cityLabel: "Nashville, TN",
      regionCode: "tn",
    });
    const { caller } = createCaller({ actorHumanId: null });

    const result = await caller.geoCategoryEvents({
      categorySlug: "music",
      citySegment: "nashville-tn",
    });

    expect(result).toMatchObject({
      total: 3,
      indexableTotal: 2,
      names: { en: "Music", es: "Música" },
    });
  });

  it("discoverPublic", async () => {
    const reportError = vi.fn();
    const spy = vi
      .spyOn(eventsUseCases, "discoverPublicEvents")
      .mockResolvedValue({ events: [], total: 0 });
    const { caller } = createCaller({ actorHumanId: null, reportError });

    await caller.discoverPublic({});

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ reportError }),
      expect.anything(),
    );
  });
});
