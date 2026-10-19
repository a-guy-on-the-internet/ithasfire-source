import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  upsertEmbed,
  upsertEmbedBaseSchema,
  listEmbeds,
  listEmbedsInputSchema,
  revokeEmbed,
  revokeEmbedInputSchema,
  getEmbedForWidget,
  getEmbedForWidgetInputSchema,
  getEmbedEventDetail,
  getEmbedEventDetailInputSchema,
  createEmbedGuestCheckout,
  createEmbedGuestCheckoutInputSchema,
  confirmEmbedGuestPayment,
  confirmEmbedGuestPaymentInputSchema,
  confirmEmbedGuestPaymentOutputSchema,
  releaseEmbedGuestOrder,
  releaseEmbedGuestOrderInputSchema,
  releaseEmbedGuestOrderOutputSchema,
  listEmbedAvailableSeats,
  listEmbedAvailableSeatsInputSchema,
  getEmbedCalendarEvents,
  getEmbedCalendarEventsInputSchema,
  getBookingWidget,
  getBookingWidgetInputSchema,
  getBookingWidgetOutputSchema,
  getMembershipWidget,
  getMembershipWidgetInputSchema,
  getMembershipWidgetOutputSchema,
  createBookingInquiry,
  createBookingInquiryBaseSchema,
  createBookingInquiryOutputSchema,
} from "@th/core/use-cases/embeds";
import {
  notifyBookingRequestReceived,
  type NotifyBookingRequestReceivedArgs,
} from "@th/core/use-cases/booking-requests";
import {
  getPlatformSettings,
  getPlatformSettingsInputSchema,
} from "@th/core/use-cases/platform";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import { authedProcedure, publicProcedure, rateLimit } from "../init";
import type { Ctx } from "../context";
import { toTrpcError } from "../utils";
import { throttledPublicReadReporter } from "../public-read-reporter";

/**
 * The org/human embed event legs are fully search-served. Fail loud (rather
 * than silently returning an empty widget) when search isn't wired — mirrors
 * the unified-search router's precondition guard.
 */
function requireMultiSearch(ctx: Ctx): MultiSearchPort {
  if (!ctx.multiSearch) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Search service not available",
    });
  }
  return ctx.multiSearch;
}

const embedDtoSchema = z.object({
  id: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  domain: z.string(),
  status: z.string(),
  requireAuth: z.boolean(),
  linkOut: z.boolean(),
  /**
   * Per-embed browse-view config (embed-unified-views FR-001/FR-002). Bare
   * string for `defaultView`, matching the core output schemas and the
   * `subjectType`/`status` convention — the read path surfaces the STORED
   * value. Rows that predate the columns read "list"/false.
   */
  defaultView: z.string(),
  viewToggle: z.boolean(),
  createdAt: z.date(),
});

const createEmbedGuestCheckoutPublicInput =
  createEmbedGuestCheckoutInputSchema.omit({
    requestIp: true,
    requestUserAgent: true,
  });

// Derived from the pre-refine base object (the fee-ask cross-field `.refine()`
// blocks `.omit()` on the full input schema; the use case re-validates it).
// `requestIp`/`requestUserAgent` are server-injected from ctx — a client that
// smuggles either is rejected by the schema's `.strict()` (which `.omit()`
// preserves), mirroring `createEmbedGuestCheckout` exactly.
const createBookingInquiryPublicInput = createBookingInquiryBaseSchema.omit({
  requestIp: true,
  requestUserAgent: true,
});

export const embedsRouter = {
  /**
   * Upsert an embed (activate or re-activate a domain allowlist entry). Auth
   * required. `subjectType` is one of event | organization | place | human;
   * for "human" the `subjectId` MUST be the actor's own humanId (personal
   * admin context — no delegation model). RBAC lives in the use case.
   *
   * Optionally carries the view config (`defaultView`, `viewToggle`). Derived
   * from the PRE-refine base object because zod v4 refuses `.omit()` on a
   * schema carrying refinements; the cross-field rule those refinements encode
   * — place (booking) subjects may not send view fields — is re-validated
   * inside the use case, exactly like `createBookingInquiry`'s fee-ask refine.
   */
  upsert: authedProcedure
    .input(upsertEmbedBaseSchema.omit({ actorHumanId: true }))
    .output(z.object({ embed: embedDtoSchema }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await upsertEmbed(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * List embeds for a given subject (event | organization | place | human).
   * Auth required.
   */
  list: authedProcedure
    .input(listEmbedsInputSchema.omit({ actorHumanId: true }))
    .output(z.object({ embeds: z.array(embedDtoSchema) }))
    .query(async ({ ctx, input }) => {
      try {
        return await listEmbeds(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Revoke an embed (disallow a domain). Auth required. */
  revoke: authedProcedure
    .input(revokeEmbedInputSchema.omit({ actorHumanId: true }))
    .output(
      z.object({ embed: z.object({ id: z.string(), status: z.string() }) }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await revokeEmbed(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, actorHumanId: ctx.actorHumanId! },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public: resolve embed data for widget rendering. No auth needed.
   *
   * Accepts the optional `scope` param (own | venues | all, default "own") for
   * organization/human subjects — see `_shared/embed-scope.ts`. `scope` is a
   * widget param rather than an Embed column precisely so one domain can host
   * differently-scoped widgets on different pages. Origin-enforced fail-closed
   * inside the use case.
   *
   * INPUT IS FROZEN (embed-unified-views FR-005). The browse `view` is resolved
   * CLIENT-SIDE from the URL plus the `embed.defaultView`/`viewToggle` fields
   * in this procedure's OUTPUT — it is deliberately not an input, because the
   * schema is `.strict()` and a stray `?view=` forwarded here would 400 the
   * whole widget. Pinned by
   * routers/__tests__/embeds-frozen-widget-inputs.test.ts.
   */
  getForWidget: publicProcedure
    .input(getEmbedForWidgetInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getEmbedForWidget(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            search: requireMultiSearch(ctx),
            publicAppUrl: ctx.publicAppUrl ?? null,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public: resolve the "Request to book" widget's display data (embed +
   * place summary + accepting flag) for /embed/book/[embedId]
   * (booking-request-embed-button FR-004). Origin-enforced fail-closed inside
   * the use case (NFR-001).
   */
  getBookingWidget: publicProcedure
    .input(getBookingWidgetInputSchema)
    .output(getBookingWidgetOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getBookingWidget(
          {
            repos: ctx.repos,
            publicAppUrl: ctx.publicAppUrl ?? null,
            logger: ctx.logger,
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public: resolve the membership-tiers widget's display data (embed +
   * owner summary + PUBLIC tiers) for /embed/memberships/[embedId]
   * (recurring-memberships owner flow step 3). Origin-enforced fail-closed
   * inside the use case, exactly like `getBookingWidget`. The widget has no
   * in-frame join — its CTA links out to /p/<slug>?tab=memberships (see the
   * use case doc for why subscriptions never run inside a third-party
   * iframe).
   */
  getMembershipWidget: publicProcedure
    .input(getMembershipWidgetInputSchema)
    .output(getMembershipWidgetOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getMembershipWidget(
          {
            repos: ctx.repos,
            publicAppUrl: ctx.publicAppUrl ?? null,
            logger: ctx.logger,
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Public: get event detail + ticket types within an embed context. No auth needed. */
  getEventDetail: publicProcedure
    .input(getEmbedEventDetailInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getEmbedEventDetail(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            publicAppUrl: ctx.publicAppUrl ?? null,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public: create a guest (unauthenticated) checkout within an embed.
   *
   * Rate-limited per client IP (anonymous callers have no actorHumanId),
   * mirroring `orders.createCheckout`'s 10/60s budget. The limiter middleware
   * does not read `input`, so it may safely run before `.input()` (see the
   * ordering note in routers/consent.ts).
   */
  createGuestCheckout: publicProcedure
    .use(
      rateLimit({
        key: (ctx) => `embed:guestCheckout:${ctx.clientIp ?? "no-ip"}`,
        maxRequests: 10,
        windowSeconds: 60,
        message: "creating checkouts",
      }),
    )
    .input(createEmbedGuestCheckoutPublicInput)
    .mutation(async ({ ctx, input }) => {
      if (ctx.enableBuyTickets === false) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Ticket purchasing is currently disabled",
        });
      }

      try {
        return await createEmbedGuestCheckout(
          {
            repos: ctx.repos,
            payments: ctx.payments,
            idempotency: ctx.idempotency,
            clock: ctx.clock,
            logger: ctx.logger,
            turnstile: ctx.turnstile,
            publicAppUrl: ctx.publicAppUrl ?? null,
            // Same as `orders.createCheckout`: without these an unstamped
            // event charges embed buyers $0 tax while main checkout charges
            // the provider's rate, and the resolver's swallows go unreported.
            taxRateLookup: ctx.taxRateLookup ?? null,
            reportError: ctx.reportError ?? undefined,
          },
          {
            ...input,
            requestIp: ctx.clientIp,
            requestUserAgent: ctx.userAgent,
          },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public: the embed widget's `orders.confirmPayment`. After Stripe confirms
   * in the browser, the widget calls this before it shows "Order confirmed",
   * so the server verifies the PaymentIntent with Stripe and finalizes the
   * order then, not only when the webhook arrives (owner ruling 2026-10-11).
   *
   * A guest has no session: the PaymentIntent client secret that
   * `createGuestCheckout` returned is the proof of ownership, checked inside
   * the use case. It answers `confirmed` / `processing` / `not_paid`; every
   * other case throws.
   *
   * NOT gated on `ctx.enableBuyTickets`, unlike `createGuestCheckout`: a
   * payment already made must stay confirmable when buying is switched off.
   *
   * Rate-limited per client IP at 20/60s. A call whose id is linked to one
   * of our orders is a live Stripe retrieve (an id no order carries is
   * refused in the use case with no Stripe call, because this limiter keys
   * on a client IP that can be spoofed off the edge and fails open on a
   * Redis error), so it is bounded; the budget is twice
   * `createGuestCheckout`'s 10/60s because one order can need several calls
   * (a bank payment is asked again while it is still `processing`, a failed
   * call is retried, and the widget may re-ask about one earlier order),
   * and the checkout limiter already caps how many orders an IP can make.
   * The limiter does not read `input`, so it runs before `.input()` and a
   * malformed secret still spends budget.
   *
   * A SECOND limit lives inside the use case (`ctx.rateLimit` threaded as
   * `deps.rateLimit`, like `createBookingInquiry`'s place cap): 20/60s per
   * PaymentIntent id, charged only for an id linked to one of our orders and
   * before the Stripe retrieve. It bounds what the per-IP limit cannot:
   * someone who made one order looping on its id from rotating IPs. Over it
   * the answer is TOO_MANY_REQUESTS (app code RATE_LIMITED), which the
   * widget reads as "ask again later". It fails open on a limiter error.
   *
   * The client secret is in the request body. The tRPC `onError` hook logs
   * the path and the error, never the input; Sentry attaches the body to an
   * error event (`sendDefaultPii`), where `scrubRequestBodyTokens` in
   * apps/api/src/instrument.ts redacts `*secret` keys. The optional
   * `receiptSecret` (the second factor on the ticket codes, which
   * `createGuestCheckout` returns) rides the body the same way and is
   * redacted by the same rule.
   */
  confirmGuestPayment: publicProcedure
    .use(
      rateLimit({
        key: (ctx) => `embed:guestConfirm:${ctx.clientIp ?? "no-ip"}`,
        maxRequests: 20,
        windowSeconds: 60,
        message: "confirming payments",
      }),
    )
    .input(confirmEmbedGuestPaymentInputSchema)
    .output(confirmEmbedGuestPaymentOutputSchema)
    .mutation(async ({ ctx, input }) => {
      // The same deps `orders.confirmPayment` wires: this is that finalize.
      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        notify: ctx.notify,
        reportError: ctx.reportError ?? undefined,
        // Dev/e2e credit maturity, as on `orders.confirmPayment`: with no
        // Stripe CLI running this call is what finalizes a local embed order.
        devInstantPayouts: ctx.devInstantPayouts,
        publicAppUrl: ctx.publicAppUrl ?? null,
        // The second limit, per PaymentIntent id (20/60s), charged inside
        // the use case after the link lookup and before the Stripe call.
        rateLimit: ctx.rateLimit,
      } satisfies Parameters<typeof confirmEmbedGuestPayment>[0];

      try {
        return await confirmEmbedGuestPayment(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public: the embed widget's `orders.releaseCartHold`. A guest who abandons
   * a checkout gives the order back, so its seats and capacity return to sale
   * at once instead of when the reapers run (owner ruling 2026-10-11, "A
   * guest can release it").
   *
   * A guest has no session: the PaymentIntent client secret that
   * `createGuestCheckout` returned is the proof of ownership, by the same
   * check as `confirmGuestPayment`, and the order must have been made through
   * THIS embed (the PaymentIntent's server-written `metadata.embedId`). Both
   * are checked inside the use case. It answers `released` / `gone` / `kept`;
   * `kept` covers an order that is paid or cannot be proven unpaid, so the
   * widget never has to treat a paid order as an error. A caller who proves
   * nothing gets one refusal (CONFLICT), whatever the reason.
   *
   * NOT gated on `ctx.enableBuyTickets`, unlike `createGuestCheckout`: giving
   * a hold back must keep working when buying is switched off.
   *
   * Rate-limited per client IP at 20/60s under its own key, so a spent
   * checkout or confirm budget does not stop a release and a release loop
   * does not spend the confirm budget of a buyer who paid. A call whose id is
   * linked to one of our orders is a live Stripe retrieve, and a proven one
   * a cancel as well; an id no order carries is refused in the use case with
   * no Stripe call, because this limiter keys on a client IP that can be
   * spoofed off the edge and fails open on a Redis error. One order needs one
   * call (plus a retry), and the checkout limiter already caps how many
   * orders an IP can make. The limiter does not read `input`, so it runs
   * before `.input()` and a malformed secret still spends budget.
   *
   * A SECOND limit lives inside the use case, as on `confirmGuestPayment`:
   * 6/60s per PaymentIntent id, charged only for a linked id and before the
   * Stripe retrieve; over it, TOO_MANY_REQUESTS (app code RATE_LIMITED).
   *
   * The client secret is in the request body: see `confirmGuestPayment` for
   * where it is kept out of logs and Sentry.
   */
  releaseGuestOrder: publicProcedure
    .use(
      rateLimit({
        key: (ctx) => `embed:guestRelease:${ctx.clientIp ?? "no-ip"}`,
        maxRequests: 20,
        windowSeconds: 60,
        message: "releasing orders",
      }),
    )
    .input(releaseEmbedGuestOrderInputSchema)
    .output(releaseEmbedGuestOrderOutputSchema)
    .mutation(async ({ ctx, input }) => {
      // Narrow: what `releaseCartHold` needs, plus the two reads that prove
      // the order is this guest's and this embed's.
      const deps = {
        repos: ctx.repos,
        payments: ctx.payments,
        clock: ctx.clock,
        logger: ctx.logger,
        // `releaseCartHold` reports every hold it refuses to release.
        reportError: ctx.reportError ?? undefined,
        publicAppUrl: ctx.publicAppUrl ?? null,
        // The second limit, per PaymentIntent id (6/60s), charged inside
        // the use case after the link lookup and before the Stripe call.
        rateLimit: ctx.rateLimit,
      } satisfies Parameters<typeof releaseEmbedGuestOrder>[0];

      try {
        return await releaseEmbedGuestOrder(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public: create an anonymous booking inquiry from the "Request to book"
   * embed widget (booking-request-embed-button FR-004, NFR-001/002).
   *
   * Rate-limited per client IP at 5/60s — tighter than guest checkout's
   * 10/60s budget because a submission fans out venue notifications (spam
   * cannon risk). The limiter middleware does not read `input`, so it may
   * safely run before `.input()` (see the ordering note in
   * routers/consent.ts). Turnstile + origin allowlist + open-inquiry dedupe
   * are enforced inside the use case; `requestIp`/`requestUserAgent` are
   * server-injected (never client-suppliable — `.strict()` rejects them).
   *
   * A SECOND layer — a per-PLACE daily flood cap (30/day) — lives INSIDE the
   * use case (`ctx.rateLimit` threaded as `deps.rateLimit`), not here:
   * attacker-controlled emails dodge the dedupe and IP rotation dodges the
   * per-IP limit above, but a middleware-level place cap would run
   * pre-Turnstile, letting unverified bots burn a venue's budget with junk
   * requests (turning the cap into a cheap widget DoS). Consuming
   * post-Turnstile, immediately before the row write, means burning the
   * budget costs the attacker a solved Turnstile challenge per token. It's
   * keyed by placeId (not embedId) so multiple embeds for one place share one
   * bucket — embeds are venue-created, so an attacker can't mint fresh
   * buckets for someone else's place either way.
   *
   * The venue new-request notification (FR-008) is composed here exactly as
   * `bookingRequests.create` does (deps assembly only — no business logic):
   * `notifyWithEmail` binds the mailer so the email leg actually sends
   * inline; plain `notify` (no mailer → email skips) is the fallback. The
   * use case swallows notifier failures (NFR-004) and reports them via
   * `reportError`.
   */
  createBookingInquiry: publicProcedure
    .use(
      rateLimit({
        key: (ctx) => `embed:bookingInquiry:${ctx.clientIp ?? "no-ip"}`,
        maxRequests: 5,
        windowSeconds: 60,
        message: "submitting booking inquiries",
      }),
    )
    .input(createBookingInquiryPublicInput)
    .output(createBookingInquiryOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        turnstile: ctx.turnstile,
        // Per-place daily flood cap (see the procedure doc above): consumed
        // inside the use case, post-Turnstile, right before the write.
        rateLimit: ctx.rateLimit,
        publicAppUrl: ctx.publicAppUrl ?? null,
        notifyBookingRequestReceived: (
          args: NotifyBookingRequestReceivedArgs,
        ) =>
          notifyBookingRequestReceived(
            {
              repos: ctx.repos,
              notify: ctx.notifyWithEmail ?? ctx.notify,
              logger: ctx.logger,
              reportError: ctx.reportError ?? undefined,
              publicAppUrl: ctx.publicAppUrl ?? null,
            },
            args,
          ),
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof createBookingInquiry>[0];

      try {
        return await createBookingInquiry(deps, {
          ...input,
          requestIp: ctx.clientIp,
          requestUserAgent: ctx.userAgent,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public: get platform settings needed by the widget (e.g. supportEmail).
   * Only returns a curated subset of keys safe for public consumption.
   */
  getPlatformPublicSettings: publicProcedure
    .input(z.object({}).strict().optional())
    .output(z.object({ supportEmail: z.string().nullable() }).strict())
    .query(async ({ ctx }) => {
      try {
        const result = await getPlatformSettings(
          { repos: ctx.repos, logger: ctx.logger },
          { keys: ["supportEmail"] },
        );
        const supportEmailSetting = result.settings.find(
          (s) => s.key === "supportEmail",
        );
        return {
          supportEmail: supportEmailSetting?.value ?? null,
        };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Public: list seats for a section within an embed context (for seat picker). */
  listAvailableSeats: publicProcedure
    .input(listEmbedAvailableSeatsInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await listEmbedAvailableSeats(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            publicAppUrl: ctx.publicAppUrl ?? null,
            logger: ctx.logger,
            reportError: throttledPublicReadReporter(ctx.reportError),
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Public: get calendar events for the embeddable calendar widget. No auth
   * needed. Accepts the optional `scope` param (own | venues | all, default
   * "own") for organization/human subjects — see `_shared/embed-scope.ts`.
   * Origin-enforced fail-closed inside the use case.
   *
   * INPUT IS FROZEN for the same reason as `getForWidget` above — see that
   * procedure's note and embeds-frozen-widget-inputs.test.ts.
   */
  getCalendarEvents: publicProcedure
    .input(getEmbedCalendarEventsInputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getEmbedCalendarEvents(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            search: requireMultiSearch(ctx),
            publicAppUrl: ctx.publicAppUrl ?? null,
            // FR-022/FR-023 sales-state enrichment degrades instead of
            // throwing, so its swallow branch is the only path to Sentry.
            reportError: ctx.reportError ?? undefined,
            logger: ctx.logger,
          },
          input,
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
