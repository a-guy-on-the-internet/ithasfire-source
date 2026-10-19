import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  assignBookingRequest,
  assignBookingRequestInputSchema,
  assignBookingRequestOutputSchema,
  claimBookingRequest,
  claimBookingRequestInputSchema,
  claimBookingRequestOutputSchema,
  createBookingRequest,
  createBookingRequestBaseSchema,
  createBookingRequestWireOutputSchema,
  countOpenBookingRequests,
  countOpenBookingRequestsBaseSchema,
  countOpenBookingRequestsOutputSchema,
  createOrganizerBookingRequest,
  createOrganizerBookingRequestBaseSchema,
  createOrganizerBookingRequestOutputSchema,
  listBookingRequests,
  listBookingRequestsInputSchema,
  listBookingRequestsOutputSchema,
  markBookingRequestViewed,
  markBookingRequestViewedInputSchema,
  markBookingRequestViewedOutputSchema,
  notifyBookingRequestReceived,
  type NotifyBookingRequestReceivedArgs,
  notifyBookingLineupInvited,
  type NotifyBookingLineupInvitedArgs,
  notifyOrganizerBookingRequestReceived,
  type NotifyOrganizerBookingRequestReceivedArgs,
  notifyBookingRequestResponded,
  type NotifyBookingRequestRespondedArgs,
  notifyBookingCancelled,
  type NotifyBookingCancelledArgs,
  closeBookingRequest,
  closeBookingRequestInputSchema,
  closeBookingRequestWireOutputSchema,
  cancelBooking,
  cancelBookingInputSchema,
  cancelBookingWireOutputSchema,
  resendBookingRequestInvite,
  resendBookingRequestInviteInputSchema,
  resendBookingRequestInviteOutputSchema,
  respondToBookingRequest,
  respondToBookingRequestBaseSchema,
  respondToBookingRequestWireOutputSchema,
  withdrawBookingRequest,
  withdrawBookingRequestInputSchema,
  withdrawBookingRequestWireOutputSchema,
  postBookingRequestMessage,
  postBookingRequestMessageInputSchema,
  bookingRequestMessageOutputSchema,
  listBookingRequestMessages,
  listBookingRequestMessagesInputSchema,
  listBookingRequestMessagesOutputSchema,
  markBookingRequestMessagesRead,
  markBookingRequestMessagesReadInputSchema,
  markBookingRequestMessagesReadOutputSchema,
  notifyBookingInquirer,
  notifyBookingRequestMessage,
  type NotifyBookingRequestMessageArgs,
  addBookingRequestAttachment,
  addBookingRequestAttachmentInputSchema,
  listBookingRequestAttachments,
  listBookingRequestAttachmentsInputSchema,
  deleteBookingRequestAttachment,
  deleteBookingRequestAttachmentInputSchema,
  bookingRequestAttachmentOutputSchema,
  confirmBookingRequestAct,
  confirmBookingRequestActInputSchema,
  declineBookingRequestAct,
  declineBookingRequestActInputSchema,
  bookingRequestActAnswerOutputSchema,
  getBookingRequestActInvite,
  getBookingRequestActInviteInputSchema,
  getBookingRequestActInviteOutputSchema,
  editBookingRequestBill,
  editBookingRequestBillInputSchema,
  editBookingRequestBillOutputSchema,
  notifyBookingLineupAnswered,
  type NotifyBookingLineupAnsweredArgs,
  notifyBookingLineupRemoved,
  type NotifyBookingLineupRemovedArgs,
  notifyBookingLineupRequestClosed,
  type NotifyBookingLineupRequestClosedArgs,
} from "@th/core/use-cases/booking-requests";
// ── P3b (asks) ── venue-booking-standards v1.1 FR-009
import {
  answerBookingRequestAsk,
  answerBookingRequestAskInputSchema,
  askOnBookingRequest,
  bookingRequestAskOutputSchema,
  getBookingAttachmentUrl,
  getBookingAttachmentUrlInputSchema,
  getBookingAttachmentUrlOutputSchema,
  listBookingRequestAskSuggestions,
  listBookingRequestAskSuggestionsInputSchema,
  listBookingRequestAskSuggestionsOutputSchema,
  listBookingRequestAsks,
  listBookingRequestAsksInputSchema,
  listBookingRequestAsksOutputSchema,
  notifyBookingRequestAsk,
  requestBookingAttachmentUpload,
  requestBookingAttachmentUploadInputSchema,
  requestBookingAttachmentUploadOutputSchema,
  withdrawBookingRequestAsk,
  withdrawBookingRequestAskInputSchema,
  type NotifyBookingRequestAskArgs,
} from "@th/core/use-cases/booking-requests";
import { listEventOwnerEntities } from "@th/core/use-cases/events";
import { ORG_EDIT_ROLES } from "@th/core/lib/rbac";

import { makeBookingHoldIntentsNotifier } from "../booking-hold-notifier";
import type { Ctx } from "../context";
import { makeLineupNoticeNotifier } from "../lineup-notice-notifier";
import { authedProcedure, rateLimit } from "../init";
import { toTrpcError } from "../utils";

// Derived from the pre-refine base object — the create schema's cross-field
// `.refine()` (fee amount requires GUARANTEE/DOOR_SPLIT) blocks `.omit()` on the
// full input schema; the use case re-validates the refinement rule.
const createInput = createBookingRequestBaseSchema.omit({
  actorHumanId: true,
});
// Same pre-refine derivation as `createInput` (the organizer schema's
// cross-field fee refine blocks `.omit()` on the full input schema).
const createToPerformerInput = createOrganizerBookingRequestBaseSchema.omit({
  actorHumanId: true,
});
const listInput = listBookingRequestsInputSchema.omit({ actorHumanId: true });
// Derived from the pre-refine base object — the "exactly one of orgId/owner"
// `.superRefine()` blocks `.omit()` on the full input schema; the use case
// re-validates the selector rule.
const countOpenInput = countOpenBookingRequestsBaseSchema.omit({
  actorHumanId: true,
});
const markViewedInput = markBookingRequestViewedInputSchema.omit({
  actorHumanId: true,
});
// Derived from the use case's pre-refine base object (the `.refine()` —
// decline requires a reason — blocks `.omit()` on the full input schema);
// the use case re-validates the refinement rule.
const respondInput = respondToBookingRequestBaseSchema.omit({
  actorHumanId: true,
});
const withdrawInput = withdrawBookingRequestInputSchema.omit({
  actorHumanId: true,
});
// booking-the-night FR-010 / FR-009: strict, derived from the core schemas
// (the reason is sanitized + bounded there).
const closeInput = closeBookingRequestInputSchema.omit({ actorHumanId: true });
const cancelBookingInput = cancelBookingInputSchema.omit({ actorHumanId: true });
const claimInput = claimBookingRequestInputSchema.omit({ actorHumanId: true });
const resendInviteInput = resendBookingRequestInviteInputSchema.omit({
  actorHumanId: true,
});
const assignInput = assignBookingRequestInputSchema.omit({ actorHumanId: true });
// The bill (lineup-booking-requests v2, FR-003): a tagged artist's answer
// and their invite read. Strict, derived from the core schemas.
const confirmActInput = confirmBookingRequestActInputSchema.omit({
  actorHumanId: true,
});
const declineActInput = declineBookingRequestActInputSchema.omit({
  actorHumanId: true,
});
const getActInviteInput = getBookingRequestActInviteInputSchema.omit({
  actorHumanId: true,
});
// The sender edits the bill (lineup v3 FR-009). Strict, derived from core.
const editBillInput = editBookingRequestBillInputSchema.omit({
  actorHumanId: true,
});

/**
 * booking-the-night N9 / FR-008: whoever SENT a request hears the answer
 * (accept / decline / close), both directions, with the reason. Composed
 * once for every answering path (respond, close). Deps assembly only; the
 * use cases fire it post-commit inside their own swallow.
 */
function makeRequestRespondedNotifier(
  ctx: Pick<
    Ctx,
    "repos" | "notify" | "notifyWithEmail" | "logger" | "reportError" | "publicAppUrl"
  >,
) {
  return (args: NotifyBookingRequestRespondedArgs) =>
    notifyBookingRequestResponded(
      {
        repos: ctx.repos,
        notify: ctx.notifyWithEmail ?? ctx.notify,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
        publicAppUrl: ctx.publicAppUrl ?? null,
      },
      args,
    );
}

/**
 * cancelEvent's ports for an exit after accept that cancels the request's
 * still-DRAFT event (booking-the-night review round 1). Deps assembly only.
 */
function exitEventCancellation(
  ctx: Pick<Ctx, "payments" | "idempotency" | "authz" | "multiSearch">,
) {
  return {
    payments: ctx.payments,
    idempotency: ctx.idempotency,
    authz: ctx.authz,
    search: ctx.multiSearch ?? undefined,
  };
}

/**
 * Lineup v3 (L7 / FR-012b): the "request isn't going ahead" notice to the
 * acts that JOINED a closed request's bill — composed once for every close
 * path (respond-decline, withdraw, close, cancel booking). Deps assembly only; the use cases fire it
 * post-commit inside their own swallow.
 */
function makeLineupRequestClosedNotifier(
  ctx: Pick<
    Ctx,
    "repos" | "notify" | "notifyWithEmail" | "logger" | "reportError" | "publicAppUrl"
  >,
) {
  return (args: NotifyBookingLineupRequestClosedArgs) =>
    notifyBookingLineupRequestClosed(
      {
        repos: ctx.repos,
        notify: ctx.notifyWithEmail ?? ctx.notify,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
        publicAppUrl: ctx.publicAppUrl ?? null,
      },
      args,
    );
}

// ── Thread messages + attachments (booking-conversation 2026-07-14 /
// venue-hierarchy FR-012, FR-008) ──
const postMessageInput = postBookingRequestMessageInputSchema.omit({
  actorHumanId: true,
});
const listMessagesInput = listBookingRequestMessagesInputSchema.omit({
  actorHumanId: true,
});
const markMessagesReadInput = markBookingRequestMessagesReadInputSchema.omit({
  actorHumanId: true,
});
// addBookingRequestAttachmentInputSchema carries a `.superRefine()` (the
// storageKey must live under the request's own namespace), so `.omit()` fails
// in zod v4 — same trap as setPlaceDirectoryListing in routers/places.ts.
// Built by hand; the use case re-parses with the real schema, refinement and
// sanitizers included.
const addAttachmentInput = z
  .object({
    bookingRequestId: z.string().uuid(),
    side: z.enum(["VENUE", "PERFORMER"]),
    storageKey: z.string().min(1).max(512),
    fileName: z.string().min(1).max(200),
    contentType: z.string().min(1).max(100),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024),
    // ── P3b (asks) ── the ask this file answers (FR-009a).
    askId: z.string().uuid().optional(),
  })
  .strict();
const listAttachmentsInput = listBookingRequestAttachmentsInputSchema.omit({
  actorHumanId: true,
});
const deleteAttachmentInput = deleteBookingRequestAttachmentInputSchema.omit({
  actorHumanId: true,
});

// ── P3b (asks) ── inputs without the actor (the auth middleware supplies it).
// The ask input carries a `.superRefine()` (useAsEventImage ⇒ IMAGE), so it is
// built by hand like `addAttachmentInput`; the use case re-parses with the
// real schema, sanitizers included.
const askInput = z
  .object({
    bookingRequestId: z.string().uuid(),
    kind: z.enum(["IMAGE", "FILE", "LINK", "TEXT", "SET_LENGTH"]),
    label: z.string().max(400),
    note: z.string().max(1200).optional(),
    standardField: z.string().max(40).optional(),
    useAsEventImage: z.boolean().optional(),
  })
  .strict();
const answerAskInput = answerBookingRequestAskInputSchema.omit({
  actorHumanId: true,
});
const withdrawAskInput = withdrawBookingRequestAskInputSchema.omit({
  actorHumanId: true,
});
const listAsksInput = listBookingRequestAsksInputSchema.omit({
  actorHumanId: true,
});
const askSuggestionsInput = listBookingRequestAskSuggestionsInputSchema.omit({
  actorHumanId: true,
});
const requestUploadInput = requestBookingAttachmentUploadInputSchema.omit({
  actorHumanId: true,
});
const attachmentUrlInput = getBookingAttachmentUrlInputSchema.omit({
  actorHumanId: true,
});

/**
 * The ask notices (`booking.ask-received` to the sender side, in-app + email;
 * `booking.ask-answered` to the venue side, in-app). Deps assembly only; the
 * use cases fire it post-commit inside their own swallow. `notifyWithEmail`
 * binds the mailer so the email leg sends inline.
 */
function makeAskNotifier(
  ctx: Pick<
    Ctx,
    "repos" | "notify" | "notifyWithEmail" | "logger" | "reportError" | "publicAppUrl"
  >,
) {
  return (args: NotifyBookingRequestAskArgs) =>
    notifyBookingRequestAsk(
      {
        repos: ctx.repos,
        notify: ctx.notifyWithEmail ?? ctx.notify,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
        publicAppUrl: ctx.publicAppUrl ?? null,
      },
      args,
    );
}

/** One fixed-window limiter per actor per ask/upload family. */
const askLimited = (family: string, maxRequests: number, message: string) =>
  authedProcedure.use(
    rateLimit({
      key: (ctx) => `bookingRequests:${family}:${ctx.actorHumanId}`,
      maxRequests,
      windowSeconds: 3600,
      message,
    }),
  );

/**
 * A sender identity the actor may submit booking requests as (FR-011):
 * themselves, or an org they hold edit roles in. `ownerType`/`ownerId` feed
 * straight into `bookingRequests.create`'s `performerOwnerType`/`performerOwnerId`
 * (ownership is re-verified server-side there — this list is a UI affordance,
 * not an authorization grant).
 */
const bookingSenderSchema = z
  .object({
    ownerType: z.enum(["human", "org"]),
    ownerId: z.uuid(),
    displayName: z.string(),
    isDefault: z.boolean(),
  })
  .strict();

const listMySendersOutputSchema = z
  .object({ senders: z.array(bookingSenderSchema) })
  .strict();

function requireActor(actorHumanId: string | null | undefined): string {
  if (!actorHumanId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Missing actor human id",
    });
  }
  return actorHumanId;
}

/**
 * The answer procedures — join (CONFIRMED) and pass (DECLINED) — built once
 * each and shared by the v3 names and their v2 aliases so the four can never
 * drift: same input schema, same output, ONE rate-limit bucket for every
 * answer under either name.
 */
const answerActLimited = () =>
  authedProcedure.use(
    rateLimit({
      key: (ctx) => `bookingRequests:answerAct:${ctx.actorHumanId}`,
      maxRequests: 30,
      windowSeconds: 3600,
      message: "answering lineup invites",
    }),
  );

/**
 * What an answer tells, composed once for join and pass (lineup v3): the
 * sender hears it in-app (FR-012a), and a late joiner who lands on the event
 * lineup gets the lineup consent notice (FR-010, the `eventHumans.attach`
 * hooks). Deps assembly only; the use case fires both post-commit and
 * swallows + reports their failures. Also composes the pass that
 * `eventHumans.leave` runs when a tagged act leaves a booked show's lineup.
 */
export function answerActNotices(
  ctx: Parameters<typeof makeLineupNoticeNotifier>[0],
) {
  return {
    lineupNotices: makeLineupNoticeNotifier(ctx),
    notifyBookingLineupAnswered: (args: NotifyBookingLineupAnsweredArgs) =>
      notifyBookingLineupAnswered(
        {
          repos: ctx.repos,
          // In-app only: the plain pipeline is enough (no email leg).
          notify: ctx.notify,
          logger: ctx.logger,
          reportError: ctx.reportError ?? undefined,
          publicAppUrl: ctx.publicAppUrl ?? null,
        },
        args,
      ),
    publicAppUrl: ctx.publicAppUrl ?? null,
    reportError: ctx.reportError ?? undefined,
  };
}

const joinActProcedure = () =>
  answerActLimited()
    .input(confirmActInput)
    .output(bookingRequestActAnswerOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        ...answerActNotices(ctx),
      } satisfies Parameters<typeof confirmBookingRequestAct>[0];
      try {
        return await confirmBookingRequestAct(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    });

const passActProcedure = () =>
  answerActLimited()
    .input(declineActInput)
    .output(bookingRequestActAnswerOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        ...answerActNotices(ctx),
      } satisfies Parameters<typeof declineBookingRequestAct>[0];
      try {
        return await declineBookingRequestAct(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    });

export const bookingRequestsRouter = {
  create: authedProcedure
    // Per-actor ceiling: one account must not be able to spray venues with
    // requests. Same shape as `resendInvite` (5/h) / `postMessage` (30/h).
    .use(
      rateLimit({
        key: (ctx) => `bookingRequests:create:${ctx.actorHumanId}`,
        maxRequests: 10,
        windowSeconds: 3600,
        message: "creating booking requests",
      }),
    )
    .input(createInput)
    .output(createBookingRequestWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // Venue new-request notification (FR-008), fired post-commit by the
        // use case. Composed here (deps assembly only — no business logic):
        // `notifyWithEmail` binds the mailer so the email leg actually sends
        // inline; plain `notify` (no mailer → email skips) is the fallback
        // for composition roots that haven't bound it. The use case swallows
        // notifier failures (NFR-004) and reports them via `reportError`.
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
        // Lineup v2 (FR-007): the sender's daily tag budget, consumed inside
        // the use case after every gate — same threading as the embed's
        // per-place cap (`rateLimit: ctx.rateLimit` in embeds.ts).
        rateLimit: ctx.rateLimit,
        // Lineup v2 (FR-003): "you're on a bill" to each TAGGED act, fired
        // post-commit by the use case and swallowed + reported there.
        // Composed exactly like the venue notification above.
        notifyBookingLineupInvited: (args: NotifyBookingLineupInvitedArgs) =>
          notifyBookingLineupInvited(
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
      } satisfies Parameters<typeof createBookingRequest>[0];

      let result;
      try {
        result = await createBookingRequest(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      return createBookingRequestWireOutputSchema.parse(result);
    }),

  /**
   * Organizer org → act request (organizer-booking-requests FR-003). Authz
   * (sender ORG_EDIT_ROLES), the target opt-in gate and the one-open-per-pair
   * rule all live inside the use case; this only assembles deps — including
   * the post-commit act notification (FR-006), swallowed + reported by the
   * use case so a notifier failure never fails the submission.
   */
  createToPerformer: authedProcedure
    .input(createToPerformerInput)
    .output(createOrganizerBookingRequestOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        notifyOrganizerBookingRequestReceived: (
          args: NotifyOrganizerBookingRequestReceivedArgs,
        ) =>
          notifyOrganizerBookingRequestReceived(
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
      } satisfies Parameters<typeof createOrganizerBookingRequest>[0];

      try {
        return await createOrganizerBookingRequest(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Booking-request lists, one per surface. Thin per the transport rule: every
   * scope's authz and row scoping lives in the use case, including
   * `scope: "org-venues"` (org membership → the org's OWNED places → one
   * set-shaped TO_VENUE query) and `scope: "human-venues"` (the ACTOR's
   * directly-owned places, same query). `actorHumanId` is omitted from the
   * client input and taken from ctx — a scope must never be able to name its
   * own actor, which for "human-venues" is also what pins the owner.
   */
  list: authedProcedure
    .input(listInput)
    .output(listBookingRequestsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        // Corrupt-row swallows inside the use case (skip-one-row fallback)
        // must reach Sentry — without this the deliberate swallow is
        // invisible in prod (ReporterPort convention).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof listBookingRequests>[0];

      try {
        return await listBookingRequests(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Open-request counts for an owner in one call (booking-inbox-placement
   * FR-006) — the owner-as-act inbox plus per-owned-venue counts. Selector:
   * `{ orgId }` (legacy) / `{ owner: { kind: "org", orgId } }` for an org, or
   * `{ owner: { kind: "human" } }` for the actor's own directly-owned venues.
   * Read-only COUNT/groupBy queries (NFR-003), so it's a query, not a mutation.
   *
   * Thin per the transport rule: authz (`requireOrgMembership(ORG_ANY_ROLE)`
   * for an org; the human case is self-scoped), the owned-places scope and the
   * shared open-status set all live in the use case. `actorHumanId` is omitted
   * from the client input and taken from ctx.
   *
   * No `reportError` in the deps: the use case has no catch-and-fallback
   * branch (NFR-004) — failures propagate and the tRPC backstop captures them.
   */
  countOpen: authedProcedure
    .input(countOpenInput)
    .output(countOpenBookingRequestsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
      } satisfies Parameters<typeof countOpenBookingRequests>[0];

      try {
        return await countOpenBookingRequests(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  markViewed: authedProcedure
    .input(markViewedInput)
    .output(markBookingRequestViewedOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof markBookingRequestViewed>[0];

      try {
        return await markBookingRequestViewed(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Signed-in performer redeems an invite-to-claim link (FR-007): attaches
   * their identity to an ACCEPTED anonymous request and mints the Agreement.
   * Performer-mode + sender-ownership gates run inside the use case; token
   * errors (TOKEN_INVALID / TOKEN_EXPIRED / INVALID_STATUS) pass through as
   * typed errors for the claim landing page to render.
   */
  claim: authedProcedure
    .input(claimInput)
    .output(claimBookingRequestOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        // Pitch-seed calendar lookup is a deliberate swallow inside the use
        // case (degrades the suggested show time); it reports through here.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof claimBookingRequest>[0];

      try {
        return await claimBookingRequest(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Venue-side resend of the invite-to-claim email (FR-007 "resend"
   * affordance). The use case ROTATES the token (old link dies immediately,
   * NFR-003) and deliberately defers abuse control to THIS layer, so the
   * rate limit here is mandatory, not defense-in-depth: each call re-emails a
   * bearer credential to the submitter.
   *
   * Budget: 5/hour per actor. The `rateLimit` middleware takes any fixed
   * window in seconds (Redis fixed-window counter), so 3600s is a supported
   * granularity — chosen over 60s because "resend" is a rare, human-paced
   * action and a per-minute window would still allow 300 emails/hour. Keyed
   * by actor (not IP): it's an authed venue-side action, and per-actor keying
   * also caps a single owner spamming across many requests. Chained after
   * `authedProcedure`'s auth middleware so `ctx.actorHumanId` is resolved;
   * the limiter does not read `input`, so it may safely run before
   * `.input()` (see the ordering note in routers/consent.ts).
   */
  resendInvite: authedProcedure
    .use(
      rateLimit({
        key: (ctx) => `bookingRequests:resendInvite:${ctx.actorHumanId}`,
        maxRequests: 5,
        windowSeconds: 3600,
        message: "resending booking invites",
      }),
    )
    .input(resendInviteInput)
    .output(resendBookingRequestInviteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // Direct MailerPort send (the submitter has no humanId, so notify()
        // is unusable). Failures are swallowed inside the use case (NFR-004)
        // and reported via `reportError` — the rotation itself never fails on
        // a mail outage.
        mailer: ctx.mailer ?? undefined,
        publicAppUrl: ctx.publicAppUrl ?? null,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof resendBookingRequestInvite>[0];

      try {
        return await resendBookingRequestInvite(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Sender picker for the embed's signed-in mode (FR-011): the identities the
   * actor can submit a booking request as — self plus every org they hold
   * ORG_EDIT_ROLES in — with exactly one `isDefault: true`.
   *
   * Read-only COMPOSITION of existing pieces (no new core use case): sender
   * enumeration reuses `listEventOwnerEntities` (self + org memberships with
   * display names — the same source the admin shell uses), filtered down to
   * edit roles. Ownership of whatever the client ultimately picks is
   * re-verified by `createBookingRequest`'s `requireOwnerAccess`, so this
   * query grants nothing.
   *
   * Default resolution (spec FR-011 tiers):
   * 1. Last-selected admin context — SKIPPED: no server-side persistence
   *    exists (the admin shell's context is URL-only), and we don't invent
   *    storage here.
   * 2. Sender of the actor's most recent booking request — implemented via a
   *    newest-first `listForPerformer` probe per candidate (the port has no
   *    cross-sender "most recent" finder; candidates are self + a handful of
   *    orgs, so the fan-out is cheap). Strict `>` comparison means a
   *    timestamp tie resolves to the earlier candidate (self is always
   *    first) — deterministic.
   * 3. Self.
   *
   * Works over Bearer JWT from the embed iframe — plain `authedProcedure`,
   * no cookie assumption.
   */
  listMySenders: authedProcedure
    .output(listMySendersOutputSchema)
    .query(async ({ ctx }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      try {
        const { owners } = await listEventOwnerEntities(
          { repos: ctx.repos, logger: ctx.logger },
          { actorHumanId },
        );

        type SenderCandidate = {
          ownerType: "human" | "org";
          ownerId: string;
          displayName: string;
        };
        const candidates = owners.flatMap((owner): SenderCandidate[] => {
          if (owner.kind === "human") {
            return [
              {
                ownerType: "human",
                ownerId: owner.humanId,
                displayName: owner.humanName,
              },
            ];
          }
          if (!ORG_EDIT_ROLES.includes(owner.role)) return [];
          return [
            {
              ownerType: "org",
              ownerId: owner.orgId,
              displayName: owner.orgName,
            },
          ];
        });

        // Tier 2: most recent booking request across the candidate senders.
        const latestRequestAt = await Promise.all(
          candidates.map(async (candidate) => {
            const records = await ctx.repos.bookingRequests.listForPerformer({
              ownerType:
                candidate.ownerType === "org" ? "organization" : "human",
              ownerId: candidate.ownerId,
            });
            // listForPerformer is newest-first per the port contract.
            return records[0]?.createdAt ?? null;
          }),
        );

        // Tier 3 fallback: self (always present, always first — see
        // listEventOwnerEntities' owners ordering).
        let defaultIndex = 0;
        let bestTime = Number.NEGATIVE_INFINITY;
        latestRequestAt.forEach((at, index) => {
          if (at && at.getTime() > bestTime) {
            bestTime = at.getTime();
            defaultIndex = index;
          }
        });

        return listMySendersOutputSchema.parse({
          senders: candidates.map((candidate, index) => ({
            ...candidate,
            isDefault: index === defaultIndex,
          })),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  respond: authedProcedure
    .input(respondInput)
    .output(respondToBookingRequestWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyHoldIntents = makeBookingHoldIntentsNotifier(ctx);

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        // Invite-to-claim email for ANONYMOUS accepts (FR-007): sent directly
        // through MailerPort post-commit (the submitter has no humanId, so
        // notify() is unusable). The use case swallows email failures
        // (NFR-004) and reports them via `reportError` — the accept itself
        // never fails on a mail outage.
        mailer: ctx.mailer ?? undefined,
        publicAppUrl: ctx.publicAppUrl ?? null,
        // The sender hears the answer, both directions (booking-the-night
        // N9 / FR-008; the organiser variant folded in): post-commit,
        // swallowed + reported by the use case.
        notifyBookingRequestResponded: makeRequestRespondedNotifier(ctx),
        // Lineup v3 (L7): a decline tells the acts that JOINED the bill that
        // it isn't going ahead — never the reason.
        notifyBookingLineupRequestClosed: makeLineupRequestClosedNotifier(ctx),
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof respondToBookingRequest>[0];

      let result;
      try {
        result = await respondToBookingRequest(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      // Hold move-ups (FR-009) from the LIVE return only — an idempotent
      // replay carries none, so a retried decline never re-notifies.
      await notifyHoldIntents({
        output: result,
        bookingRequestId: input.bookingRequestId,
        actorHumanId,
      });
      return respondToBookingRequestWireOutputSchema.parse(result);
    }),

  /**
   * Venue-internal assignee (booking-holds FR-015): set to an edit-role
   * member of an owning org, or `null` to clear. ORG_EDIT_ROLES gate, the
   * eligibility rule and the human-owned-venue refusal
   * (BOOKING_ASSIGNMENT_NOT_APPLICABLE) all live in the use case; idempotent
   * on an unchanged assignee (no write, no ledger line).
   */
  assign: authedProcedure
    .input(assignInput)
    .output(assignBookingRequestOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof assignBookingRequest>[0];

      try {
        return await assignBookingRequest(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  withdraw: authedProcedure
    .input(withdrawInput)
    .output(withdrawBookingRequestWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyHoldIntents = makeBookingHoldIntentsNotifier(ctx);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // An ACCEPTED request's still-DRAFT event is cancelled with it.
        eventCancellation: exitEventCancellation(ctx),
        // Lineup v3 (L7): the acts that JOINED the bill hear it isn't going
        // ahead. Fired post-commit by the use case, swallowed + reported.
        notifyBookingLineupRequestClosed: makeLineupRequestClosedNotifier(ctx),
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof withdrawBookingRequest>[0];

      let result;
      try {
        result = await withdrawBookingRequest(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      // Hold move-ups owed to the OTHER acts in each line (FR-009); the
      // withdrawing act never sees them.
      await notifyHoldIntents({
        output: result,
        bookingRequestId: input.bookingRequestId,
        actorHumanId,
      });
      return withdrawBookingRequestWireOutputSchema.parse(result);
    }),

  /**
   * Venue: "Close request" (booking-the-night N14 / FR-010) — an ACCEPTED
   * request whose night is not booked yet ends, with a required reason:
   * DECLINED, holds released, draft terms cancelled. BOOKING_NIGHT_BOOKED
   * once the night is booked (the undo is `cancelBooking`). The sender
   * hears it with the reason; joined acts hear it isn't going ahead.
   */
  close: authedProcedure
    .input(closeInput)
    .output(closeBookingRequestWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyHoldIntents = makeBookingHoldIntentsNotifier(ctx);

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // The request's still-DRAFT event is cancelled with it.
        eventCancellation: exitEventCancellation(ctx),
        notifyBookingRequestResponded: makeRequestRespondedNotifier(ctx),
        notifyBookingLineupRequestClosed: makeLineupRequestClosedNotifier(ctx),
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof closeBookingRequest>[0];

      let result;
      try {
        result = await closeBookingRequest(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyHoldIntents({
        output: result,
        bookingRequestId: input.bookingRequestId,
        actorHumanId,
      });
      return closeBookingRequestWireOutputSchema.parse(result);
    }),

  /**
   * Venue or sender: "Cancel booking" (booking-the-night N13 / FR-009) — the
   * one undo for a booked night, with a required reason, before the event
   * starts. Terms, booked hold and event end together; the event is
   * cancelled (and refunded) through the existing cancelEvent body, in one
   * commit with the booking's writes. BOOKING_NOT_CANCELLABLE otherwise.
   * Money-moving and reachable by the sender side, so throttled per actor.
   */
  cancelBooking: authedProcedure
    .use(
      rateLimit({
        key: (ctx) => `bookingRequests:cancelBooking:${ctx.actorHumanId}`,
        maxRequests: 10,
        windowSeconds: 3600,
        message: "cancelling bookings",
      }),
    )
    .input(cancelBookingInput)
    .output(cancelBookingWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const notifyHoldIntents = makeBookingHoldIntentsNotifier(ctx);

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        payments: ctx.payments,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        // Best-effort: REMOVE the cancelled event from search promptly.
        search: ctx.multiSearch ?? undefined,
        reportError: ctx.reportError ?? undefined,
        // Both sides hear it — in-app, email (mailer bound) and push, with
        // the reason (review W4).
        notifyBookingCancelled: (args: NotifyBookingCancelledArgs) =>
          notifyBookingCancelled(
            {
              repos: ctx.repos,
              notify: ctx.notifyWithEmail ?? ctx.notify,
              logger: ctx.logger,
              reportError: ctx.reportError ?? undefined,
              publicAppUrl: ctx.publicAppUrl ?? null,
            },
            args,
          ),
        notifyBookingLineupRequestClosed: makeLineupRequestClosedNotifier(ctx),
      } satisfies Parameters<typeof cancelBooking>[0];

      let result;
      try {
        result = await cancelBooking(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyHoldIntents({
        output: result,
        bookingRequestId: input.bookingRequestId,
        actorHumanId,
      });
      return cancelBookingWireOutputSchema.parse(result);
    }),

  // ── The bill (lineup-booking-requests v2 FR-003, v3 FR-003) ────────────
  // A TAGGED act joins or passes its spot on a request's bill. Authz (the
  // actor must BE the tagged person, or hold an org edit role in the tagged
  // group it names with `asOrgId` — read by owner key, no act ids on the
  // wire), the transition table and the mint race all live in the use
  // cases; this layer adds the abuse throttle only. Budget: 30/hour per
  // actor across every answer — a human answers a handful of invites, and a
  // repeat is an idempotent no-op, so anything past that is a script.
  //
  // `joinAct` / `passAct` are the v3 names (CONTEXT.md "Join / Pass");
  // `confirmAct` / `declineAct` are the SAME procedures, kept as aliases for
  // one release so a client built against v2 keeps working.

  joinAct: joinActProcedure(),
  passAct: passActProcedure(),
  /** @deprecated v2 name of `joinAct`; kept one release. */
  confirmAct: joinActProcedure(),
  /** @deprecated v2 name of `passAct`; kept one release. */
  declineAct: passActProcedure(),

  /**
   * The SENDER changes the bill (lineup v3 FR-009): add / remove / move /
   * re-role acts, or put themselves on or off it, until an event exists
   * (then BILL_LOCKED). Authz (the sender pair, as withdraw), every gate,
   * the one ledger entry and the post-commit invites / removal notices live
   * in the use case; this layer adds the abuse throttle and composes the
   * notifiers. Budget: 30 edits an hour per actor — an edit is a handful of
   * ops, and every newly asked act also spends the sender's daily tag budget.
   */
  editBill: authedProcedure
    .use(
      rateLimit({
        key: (ctx) => `bookingRequests:editBill:${ctx.actorHumanId}`,
        maxRequests: 30,
        windowSeconds: 3600,
        message: "editing bills",
      }),
    )
    .input(editBillInput)
    .output(editBookingRequestBillOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // The sender pair's daily tag budget (FR-007), as at create.
        rateLimit: ctx.rateLimit,
        notifyBookingLineupInvited: (args: NotifyBookingLineupInvitedArgs) =>
          notifyBookingLineupInvited(
            {
              repos: ctx.repos,
              notify: ctx.notifyWithEmail ?? ctx.notify,
              logger: ctx.logger,
              reportError: ctx.reportError ?? undefined,
              publicAppUrl: ctx.publicAppUrl ?? null,
            },
            args,
          ),
        notifyBookingLineupRemoved: (args: NotifyBookingLineupRemovedArgs) =>
          notifyBookingLineupRemoved(
            {
              repos: ctx.repos,
              notify: ctx.notifyWithEmail ?? ctx.notify,
              logger: ctx.logger,
              reportError: ctx.reportError ?? undefined,
            },
            args,
          ),
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof editBookingRequestBill>[0];

      try {
        return await editBookingRequestBill(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * The one-tap landing's read (`/bookings/acts/{requestId}`): only the
   * tagged human sees it; everyone else gets the same NOT_FOUND.
   */
  getActInvite: authedProcedure
    // A read, but one that answers "are you on this request's bill" for any
    // id handed to it — throttled per actor so it cannot be swept. Generous:
    // a person opens a handful of invites.
    .use(
      rateLimit({
        key: (ctx) => `bookingRequests:getActInvite:${ctx.actorHumanId}`,
        maxRequests: 60,
        windowSeconds: 60,
        message: "opening lineup invites",
      }),
    )
    .input(getActInviteInput)
    .output(getBookingRequestActInviteOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = requireActor(ctx.actorHumanId);

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof getBookingRequestActInvite>[0];

      try {
        return await getBookingRequestActInvite(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ── Thread messages (booking-conversation FR-001..003 / venue-hierarchy
  // FR-012). The request IS the thread; authz (declared-side verification,
  // open-thread gate) lives in the use cases — this layer adds ONLY the
  // abuse throttle and the notification composition. ──

  messages: {
    /**
     * Append one message. Rate-limited 30/hour per ACTOR — the limit the
     * post use case explicitly delegates to transport (its NOTE(step 6):
     * core stays limiter-free so SYSTEM/backfill paths are never throttled).
     * Same fixed-window per-actor pattern as `resendInvite` above; keyed by
     * actor (not request) so one human can't spray across many threads.
     * Chained after `authedProcedure`'s auth middleware so `ctx.actorHumanId`
     * is resolved; the limiter does not read `input`, so it may safely run
     * before `.input()` (ordering note in routers/consent.ts).
     *
     * The counterparty notification (FR-003) is composed here exactly as
     * `create` composes notifyBookingRequestReceived (deps assembly only):
     * `notifyWithEmail` binds the mailer so the email leg sends inline;
     * plain `notify` is the fallback. The use case fires it POST-COMMIT and
     * swallows notifier failures (guarded `reportError`) — a notify outage
     * never fails a committed message.
     *
     * `notifyBookingInquirer` is composed AHEAD of it for the one recipient
     * notify() structurally cannot serve: an ANONYMOUS embed inquirer, who has
     * no humanId and (once one is minted) an unverified identity the email
     * channel refuses. See its module header; ordering rationale inline
     * below.
     */
    post: authedProcedure
      .use(
        rateLimit({
          key: (ctx) => `bookingRequests:postMessage:${ctx.actorHumanId}`,
          maxRequests: 30,
          windowSeconds: 3600,
          message: "posting booking messages",
        }),
      )
      .input(postMessageInput)
      .output(bookingRequestMessageOutputSchema)
      .mutation(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          clock: ctx.clock,
          logger: ctx.logger,
          notifyBookingRequestMessagePosted: async (
            args: NotifyBookingRequestMessageArgs,
          ) => {
            // ORDER IS LOAD-BEARING. `notifyBookingInquirer` runs FIRST
            // because it may mint the inquirer's shadow identity and attach it
            // to the request; handing its FRESH record to the notifier is what
            // lets the venue→performer notification resolve a recipient at all
            // instead of taking the zero-recipient anonymous skip. It never
            // throws (swallow + guarded reportError inside), so the notifier
            // always runs; on a null return the notifier keeps the snapshot,
            // which is the pre-fix behaviour.
            const bookingRequest =
              (await notifyBookingInquirer(
                {
                  repos: ctx.repos,
                  mailer: ctx.mailer ?? undefined,
                  publicAppUrl: ctx.publicAppUrl ?? null,
                  logger: ctx.logger,
                  reportError: ctx.reportError ?? undefined,
                },
                args,
              )) ?? args.bookingRequest;

            await notifyBookingRequestMessage(
              {
                repos: ctx.repos,
                notify: ctx.notifyWithEmail ?? ctx.notify,
                logger: ctx.logger,
                reportError: ctx.reportError ?? undefined,
                publicAppUrl: ctx.publicAppUrl ?? null,
              },
              { ...args, bookingRequest },
            );
          },
          reportError: ctx.reportError ?? undefined,
        } satisfies Parameters<typeof postBookingRequestMessage>[0];

        try {
          return await postBookingRequestMessage(deps, {
            ...input,
            actorHumanId,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** One thread page, oldest first; works on closed threads (read-only). */
    list: authedProcedure
      .input(listMessagesInput)
      .output(listBookingRequestMessagesOutputSchema)
      .query(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          logger: ctx.logger,
          // The act-confirmation visibility read fails CLOSED inside the use
          // case and reports through here (ReporterPort convention).
          reportError: ctx.reportError ?? undefined,
        } satisfies Parameters<typeof listBookingRequestMessages>[0];

        try {
          return await listBookingRequestMessages(deps, {
            ...input,
            actorHumanId,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** Stamp counterparty messages read up to a timestamp (idempotent). */
    markRead: authedProcedure
      .input(markMessagesReadInput)
      .output(markBookingRequestMessagesReadOutputSchema)
      .mutation(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          clock: ctx.clock,
          logger: ctx.logger,
        } satisfies Parameters<typeof markBookingRequestMessagesRead>[0];

        try {
          return await markBookingRequestMessagesRead(deps, {
            ...input,
            actorHumanId,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),
  },

  // ── Attachments (venue-hierarchy FR-008): riders, stage plots, tech
  // specs. Participant/reader gates + the uploader-or-venue delete posture
  // + the storage-GC enqueue all live in the use cases. ──

  attachments: {
    add: authedProcedure
      .input(addAttachmentInput)
      .output(bookingRequestAttachmentOutputSchema)
      .mutation(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          clock: ctx.clock,
          logger: ctx.logger,
          // ── P3b (asks) ── HEAD the stored object (FR-009a).
          storage: ctx.fileStorage,
          reportError: ctx.reportError ?? undefined,
        } satisfies Parameters<typeof addBookingRequestAttachment>[0];

        try {
          return await addBookingRequestAttachment(deps, {
            ...input,
            actorHumanId,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** Live attachments, oldest first; works on closed threads. */
    list: authedProcedure
      .input(listAttachmentsInput)
      .output(z.array(bookingRequestAttachmentOutputSchema))
      .query(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          clock: ctx.clock,
          logger: ctx.logger,
        } satisfies Parameters<typeof listBookingRequestAttachments>[0];

        try {
          return await listBookingRequestAttachments(deps, {
            ...input,
            actorHumanId,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** Idempotent soft-delete (uploader-or-venue; GC enqueued in the tx). */
    delete: authedProcedure
      .input(deleteAttachmentInput)
      .output(z.object({ deleted: z.boolean() }).strict())
      .mutation(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          clock: ctx.clock,
          logger: ctx.logger,
        } satisfies Parameters<typeof deleteBookingRequestAttachment>[0];

        try {
          return await deleteBookingRequestAttachment(deps, {
            ...input,
            actorHumanId,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    // ── P3b (asks) ── venue-booking-standards v1.1 FR-009a: the upload path
    // and the signed open. Authz lives in the use cases (thread WRITE gate to
    // upload, READ gate to open); this layer adds the abuse throttle.

    /** A 15-minute presigned PUT into the private bucket (≤ 25 MB). */
    requestUpload: askLimited(
      "attachmentUpload",
      60,
      "uploading booking files",
    )
      .input(requestUploadInput)
      .output(requestBookingAttachmentUploadOutputSchema)
      .mutation(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          storage: ctx.fileStorage,
          clock: ctx.clock,
          logger: ctx.logger,
        } satisfies Parameters<typeof requestBookingAttachmentUpload>[0];

        try {
          return await requestBookingAttachmentUpload(deps, {
            ...input,
            actorHumanId,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** A short-lived signed GET for one live attachment (participants only). */
    getUrl: authedProcedure
      .input(attachmentUrlInput)
      .output(getBookingAttachmentUrlOutputSchema)
      .query(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          storage: ctx.fileStorage,
          clock: ctx.clock,
          logger: ctx.logger,
        } satisfies Parameters<typeof getBookingAttachmentUrl>[0];

        try {
          return await getBookingAttachmentUrl(deps, {
            ...input,
            actorHumanId,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),
  },

  // ── P3b (asks) ── venue-booking-standards v1.1 FR-009b/c: typed asks on
  // the thread. Who may ask / answer / withdraw / read, the state machine and
  // the mapping onto the night all live in the use cases; this layer adds
  // the throttle and composes the notices.
  asks: {
    /** The venue asks the sender for one typed thing. */
    ask: askLimited("ask", 30, "asking on booking requests")
      .input(askInput)
      .output(bookingRequestAskOutputSchema)
      .mutation(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          clock: ctx.clock,
          logger: ctx.logger,
          notifyBookingRequestAsk: makeAskNotifier(ctx),
          reportError: ctx.reportError ?? undefined,
        } satisfies Parameters<typeof askOnBookingRequest>[0];

        try {
          return await askOnBookingRequest(deps, { ...input, actorHumanId });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** The sender saves (or replaces) an answer. */
    answer: askLimited("answerAsk", 60, "answering booking asks")
      .input(answerAskInput)
      .output(bookingRequestAskOutputSchema)
      .mutation(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          clock: ctx.clock,
          storage: ctx.fileStorage,
          logger: ctx.logger,
          notifyBookingRequestAsk: makeAskNotifier(ctx),
          reportError: ctx.reportError ?? undefined,
        } satisfies Parameters<typeof answerBookingRequestAsk>[0];

        try {
          return await answerBookingRequestAsk(deps, { ...input, actorHumanId });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** The venue takes back an OPEN ask. */
    withdraw: authedProcedure
      .input(withdrawAskInput)
      .output(bookingRequestAskOutputSchema)
      .mutation(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          clock: ctx.clock,
          logger: ctx.logger,
        } satisfies Parameters<typeof withdrawBookingRequestAsk>[0];

        try {
          return await withdrawBookingRequestAsk(deps, {
            ...input,
            actorHumanId,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** Every ask on the thread with its answer (VENUE | PERFORMER). */
    list: authedProcedure
      .input(listAsksInput)
      .output(listBookingRequestAsksOutputSchema)
      .query(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          logger: ctx.logger,
          reportError: ctx.reportError ?? undefined,
        } satisfies Parameters<typeof listBookingRequestAsks>[0];

        try {
          return await listBookingRequestAsks(deps, { ...input, actorHumanId });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),

    /** "Ask for…": the standards the pitch left empty, pre-typed (venue). */
    suggestions: authedProcedure
      .input(askSuggestionsInput)
      .output(listBookingRequestAskSuggestionsOutputSchema)
      .query(async ({ ctx, input }) => {
        const actorHumanId = requireActor(ctx.actorHumanId);

        const deps = {
          repos: ctx.repos,
          logger: ctx.logger,
          // The standards read degrades (platform defaults) and reports.
          reportError: ctx.reportError ?? undefined,
        } satisfies Parameters<typeof listBookingRequestAskSuggestions>[0];

        try {
          return await listBookingRequestAskSuggestions(deps, {
            ...input,
            actorHumanId,
          });
        } catch (err) {
          throw toTrpcError(err);
        }
      }),
  },
};
