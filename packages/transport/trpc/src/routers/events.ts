import { TRPCError } from "@trpc/server";
import { GoogleAuth } from "google-auth-library";
import type { LoggerPort } from "@th/ports/logger";
import {
  saveEventForHuman,
  saveEventForHumanInputSchema,
  deleteEventApplicationQuestion,
  deleteEventApplicationQuestionInputSchema,
  deleteEventApplicationQuestionOutputSchema,
  featureEvent,
  featureEventInputSchema,
  featureEventOutputSchema,
  finalizeEventImageUpload,
  finalizeEventImageUploadInputSchema,
  finalizeEventImageUploadOutputSchema,
  getEventGatedPreview,
  getEventGatedPreviewInputSchema,
  getEventGatedPreviewOutputSchema,
  getPublicEventApplicationForm,
  getPublicEventApplicationFormInputSchema,
  getPublicEventApplicationFormOutputSchema,
  getEventGateState,
  getEventGateStateInputSchema,
  getEventGateStateOutputSchema,
  getEventForEdit,
  getEventForEditInputSchema,
  getEventForEditOutputSchema,
  getEventApplicationForm,
  getEventProvenance,
  getEventProvenanceInputSchema,
  getEventProvenanceOutputSchema,
  getEventTitle,
  getEventTitleInputSchema,
  getEventTitleOutputSchema,
  getEventCalendarInfo,
  getEventCalendarInfoOutputSchema,
  joinEventWaitlist,
  joinEventWaitlistInputSchema,
  joinEventWaitlistInputSchemaBase,
  joinEventWaitlistOutputSchema,
  getRandomEvent,
  getRandomEventInput,
  getEventSeo,
  getEventSeoInputSchema,
  getEventSeoOutputSchema,
  getPublicEventBody,
  getPublicEventBodyInputSchema,
  getPublicEventBodyOutputSchema,
  listEventTicketTypes,
  listEventTicketTypesInputSchema,
  listEventTicketTypesOutputSchema,
  listEventTicketTypesForEdit,
  listEventTicketTypesForEditInputSchema,
  listEventTicketTypesForEditOutputSchema,
  listEventSeatAvailability,
  listEventSeatAvailabilityInputSchema,
  listEventSeatAvailabilityOutputSchema,
  assignTicketTypeSections,
  assignTicketTypeSectionsInputSchema,
  assignTicketTypeSectionsOutputSchema,
  listEventsNearCoordinate,
  listEventsNearCoordinateInputSchema,
  listEventApplicationSubmissions,
  listEventApplicationSubmissionsInputSchema,
  listEventApplicationSubmissionsOutputSchema,
  listEventOwnerEntities,
  listEventOwnerEntitiesInputSchema,
  listEventOwnerEntitiesOutputSchema,
  listEventSitemapEntries,
  listEventSitemapEntriesInputSchema,
  listEventSitemapEntriesOutputSchema,
  listEventsByLocation,
  listEventsByLocationInputSchema,
  listEventsByLocationOutputSchema,
  listEventsByCountry,
  listEventsByCountryInputSchema,
  listEventsByCountryOutputSchema,
  assertExpandDatesBounded,
  listMyEvents,
  listMyEventsInputSchemaBase,
  listMyEventsOutputSchema,
  publishEvent,
  publishEventInputSchema,
  publishEventWireOutputSchema,
  inviteLineupHumanToRegister,
  inviteLineupHumanToRegisterInputSchema,
  inviteLineupHumanToRegisterOutputSchema,
  getEventSplits,
  getEventSplitsInputSchema,
  getEventSplitsOutputSchema,
  updateEventSplits,
  updateEventSplitsInputSchema,
  updateEventSplitsOutputSchema,
  cancelEvent,
  cancelEventInputSchema,
  cancelEventOutputSchema,
  unpublishEvent,
  unpublishEventInputSchema,
  unpublishEventOutputSchema,
  completeEvent,
  completeEventInputSchema,
  completeEventOutputSchema,
  archiveEvent,
  archiveEventInputSchema,
  archiveEventOutputSchema,
  deleteEvent,
  deleteEventInputSchema,
  deleteEventOutputSchema,
  randomEventDto,
  redeemApplicationApprovalToken,
  redeemApplicationApprovalTokenInputSchema,
  redeemApplicationApprovalTokenOutputSchema,
  // Gated-event invite links
  setEventSharedInvite,
  setEventSharedInviteInputSchema,
  setEventSharedInviteOutputSchema,
  createEventGuestInvites,
  createEventGuestInvitesInputSchema,
  createEventGuestInvitesOutputSchema,
  resendEventGuestInvite,
  resendEventGuestInviteInputSchema,
  resendEventGuestInviteOutputSchema,
  revokeEventGuestInvite,
  revokeEventGuestInviteInputSchema,
  revokeEventGuestInviteOutputSchema,
  listEventInvites,
  listEventInvitesInputSchema,
  listEventInvitesOutputSchema,
  redeemEventInvite,
  redeemEventInviteInputSchema,
  redeemEventInviteDeadReasonSchema,
  redeemEventInviteGrantSchema,
  peekEventInvite,
  peekEventInviteInputSchema,
  peekEventInviteOutputSchema,
  peekInviteOptOut,
  optOutOfOrganiserInvites,
  optOutOfAllInvites,
  inviteOptOutInputSchema,
  inviteOptOutOutputSchema,
  regenerateEventSlug,
  regenerateEventSlugInputSchema,
  regenerateEventSlugOutputSchema,
  requestEventImageUpload,
  requestEventImageUploadInputSchema,
  requestEventImageUploadOutputSchema,
  rescindEventApplicationDecision,
  rescindEventApplicationDecisionInputSchema,
  rescindEventApplicationDecisionOutputSchema,
  getBannedOwnerHolderAccess,
  getBannedOwnerHolderAccessInputSchema,
  getBannedOwnerHolderAccessOutputSchema,
  resolveEventBySlug,
  resolveEventBySlugInputSchema,
  resolveEventBySlugOutputSchema,
  resolveEventImages,
  resolveEventImagesInputSchema,
  resolveEventImagesOutputSchema,
  requestEventAudioUpload,
  requestEventAudioUploadInputSchema,
  requestEventAudioUploadOutputSchema,
  finalizeEventAudioUpload,
  finalizeEventAudioUploadInputSchema,
  finalizeEventAudioUploadOutputSchema,
  type EnqueueTranscodeJob,
  resolveEventAudio,
  resolveEventAudioInputSchema,
  resolveEventAudioOutputSchema,
  reviewEventApplicationSubmission,
  reviewEventApplicationSubmissionInputSchema,
  reviewEventApplicationSubmissionInputSchemaBase,
  reviewEventApplicationSubmissionOutputSchema,
  searchPublishedEvents,
  searchPublishedEventsInputSchema,
  searchPublishedEventsOutputSchema,
  setEventListingPriority,
  setEventListingPriorityInputSchema,
  setEventListingPriorityOutputSchema,
  saveEventForOrg,
  saveEventForOrgInputSchema,
  saveEventWireOutputSchema,
  submitEventApplication,
  submitEventApplicationInputSchema,
  submitEventApplicationInputSchemaBase,
  submitEventApplicationOutputSchema,
  notifyEventApplicationReceived,
  type NotifyEventApplicationReceivedArgs,
  updateEventAccessControls,
  updateEventAccessControlsInputSchema,
  updateEventAccessControlsInputSchemaBase,
  updateEventAccessControlsOutputSchema,
  updateEventSettings,
  updateEventSettingsInputSchemaBase,
  updateEventSettingsOutputSchema,
  setManualEventTaxRate,
  setManualEventTaxRateInputSchema,
  setManualEventTaxRateOutputSchema,
  upsertEventApplicationForm,
  upsertEventApplicationFormInputSchemaBase,
  upsertEventApplicationFormOutputSchema,
  withdrawEventApplication,
  withdrawEventApplicationInputSchema,
  withdrawEventApplicationOutputSchema,
  getViewerApplicationStatus,
  getViewerApplicationStatusOutputSchema,
  upsertEventApplicationQuestion,
  upsertEventApplicationQuestionInputSchema,
  upsertEventApplicationQuestionOutputSchema,
  validateEventPassword,
  validateEventPasswordInputSchema,
  validateEventPasswordOutputSchema,
  recordVerifiedEventPasswordUnlock,
  recordVerifiedEventPasswordUnlockInputSchema,
  recordVerifiedEventPasswordUnlockOutputSchema,
  recordApplicationGrantUnlock,
  recordApplicationGrantUnlockOutputSchema,
  recordInviteGrantUnlock,
  recordInviteGrantUnlockOutputSchema,
  getEventFeePreview,
  getEventFeePreviewInputSchema,
  getEventFeePreviewOutputSchema,
  getCheckoutFeeRates,
  getCheckoutFeeRatesInputSchema,
  getCheckoutFeeRatesOutputSchema,
  ticketTiersForCard,
  ticketTiersForCardInputSchema,
  ticketTiersForCardOutputSchema,
  estimateCheckoutTax,
  estimateCheckoutTaxInputSchema,
  estimateCheckoutTaxOutputSchema,
  setSeatPriceOverrides,
  setSeatPriceOverridesInputSchema,
  setSeatPriceOverridesOutputSchema,
  listEventSeatPriceOverridesForEdit,
  listEventSeatPriceOverridesForEditInputSchema,
  listEventSeatPriceOverridesForEditOutputSchema,
  discoverPublicEvents,
  discoverPublicEventsInputSchema,
  discoverPublicEventsOutputSchema,
  discoverActiveCities,
  discoverActiveCitiesInputSchema,
  discoverActiveCitiesOutputSchema,
  listEventsForMapOverview,
  listEventsForMapOverviewInputSchema,
  listEventsByCategoryAndCity,
  listEventsByCategoryAndCityInputSchema,
  ensureEventReadableBySlug,
} from "@th/core/use-cases/events";
import { categoryNamesSchema } from "@th/core/use-cases/categories";
import { makeEventHoldIntentsNotifier } from "../booking-hold-notifier";
import { dealChangeNoticeDeps } from "../deal-change-notice-deps";
import { makeLineupNoticeNotifier } from "../lineup-notice-notifier";
import { makeBookingRequestIntentsNotifier } from "../booking-request-notifier";
import { getFeatureGates } from "@th/core/use-cases/features";
import { z } from "zod";
import { eventSummaryDtoSchema } from "@th/types";
import {
  authedProcedure,
  optionalProcedure,
  publicProcedure,
  router,
} from "../init";
import type { Ctx } from "../context";
import { chargeFailedAttempt, rateLimit } from "../guard";
import { toTrpcError } from "../utils";
import { throttledPublicReadReporter } from "../public-read-reporter";
import {
  findHeldEventInviteGrantId,
  readEventApplicationGrantCookie,
  readEventInviteGrantCookie,
  verifyEventUnlockCookie,
} from "../event-unlock-cookie";
import { rateLimitIpBucket } from "@th/core/lib/security/rate-limit-ip-bucket";
import { parseInviteToken } from "@th/core/lib/security/invite-token";
import { publicDiscoveryCacheFor } from "../anonymous-request";
import {
  resolveEventShortLink,
  resolveEventShortLinkInputSchema,
  resolveEventShortLinkOutputSchema,
} from "@th/core/use-cases/events/resolve-event-short-link";
import {
  ensureFullEventReadAccessByEventId,
  ensureFullEventReadAccessBySlug,
  hasFullEventReadAccessByEventId,
} from "../event-read-access";
import {
  countryEventsToDto,
  localEventsToDto,
  nearbyEventsToDto,
  nearbyEventsToMapDto,
  mapEventDtoSchema,
  discoverEventsToDto,
} from "../event-summary-mapper";
import { createThrottledReporter } from "@th/core/lib/throttled-reporter";
import {
  createQuoteTaxLookupCooldown,
  type QuoteTaxLookupCooldown,
} from "@th/core/use-cases/events/_shared/quote-tax-lookup-cooldown";
import { makeOpenCallNotifier } from "../open-call-notifier";

/**
 * Server-side enforcement of the `waitlists` feature gate for the WRITE
 * procedure (`joinEventWaitlist`). Mirrors `ensureResaleEnabled` in
 * routers/resale.ts: the UI is dark when the gate is off, but this endpoint is
 * an `optionalProcedure` — unauthenticated — that persists a fan's email as a
 * PENDING WaitlistEntry, so it must not remain callable directly.
 *
 * This matters more here than for a normal ungated write. Any event whose
 * `waitlistStatus` was already OPEN before the gate landed (seed data, or an
 * organiser who opened it earlier) would keep accepting anonymous POSTs, while
 * EventGateSettings now hides the whole Notify-Me section — so the organiser
 * could no longer set it back to DISABLED. Without this check the gate would
 * convert a half-built feature into a permanently-open, invisible PII sink.
 *
 * Resolves the FULL gate (DB override ?? env `ENABLE_WAITLISTS` ?? false) via
 * the same `getFeatureGates` use case the features router serves, so an admin
 * flipping `feature:waitlists` needs no redeploy — fail-closed on a
 * settings-read failure (falls back to the env default, off unless explicitly
 * enabled).
 *
 * NOTE: the read side is unaffected — `getEventGateState` still reports
 * `waitlistOpen`, and `updateAccessControls` (owner-scoped, and the only way
 * to set `waitlistStatus` back to DISABLED) is deliberately NOT gated, so an
 * organiser is never API-blocked from closing a waitlist that is already open.
 */
async function ensureWaitlistsEnabled(ctx: Ctx): Promise<void> {
  const gates = await getFeatureGates({
    enableWaitlists: ctx.enableWaitlists,
    platformSettings: ctx.repos.platformSettings,
    reportError: ctx.reportError ?? undefined,
  });
  if (!gates.waitlists) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Waitlists are currently disabled",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio transcode dispatch
//
// On deployed envs the audio-transcoder Cloud Run service is internal-only and
// only grants run.invoker to a Pub/Sub push service account, so the API cannot
// call its `/transcode` route directly. Instead we publish the transcode payload
// to a Pub/Sub topic (AUDIO_TRANSCODE_TOPIC); the topic's push subscription
// delivers it (OIDC-authenticated) to the transcoder's `/pubsub/push` route.
//
// Locally (AUDIO_TRANSCODE_TOPIC unset) we fall back to the direct
// `${AUDIO_TRANSCODER_URL}/transcode` fetch, where the service is reachable.
// ─────────────────────────────────────────────────────────────────────────────

/** Payload published to the transcoder. Field names MUST match the transcoder's
 * `transcodeAudioInputSchema` (validated in `/pubsub/push`). */
type TranscodePayload = {
  audioUploadId: string;
  sourceKey: string;
  outputPrefix: string;
  eventId: string;
  deleteSourceOnSuccess: boolean;
};

// Cache the GoogleAuth instance at module scope — it lazily discovers ADC and
// caches/refreshes tokens, so re-creating it per call would be wasteful.
let cachedPubSubAuth: GoogleAuth | null = null;
function getPubSubAuth(): GoogleAuth {
  if (!cachedPubSubAuth) {
    cachedPubSubAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/pubsub"],
    });
  }
  return cachedPubSubAuth;
}

/**
 * Publish one message to the transcode topic via the Pub/Sub REST API: a
 * transcode job (`dispatchTranscodeJob`) or the upload-start warm-up
 * (`warmTranscoder`, with a `kind=warm` attribute). Returns the fetch Response
 * so each caller applies its own status handling.
 *
 * @param topic Full Pub/Sub topic resource path, e.g.
 *   `projects/<project>/topics/<svc>-transcode` — used verbatim in the URL.
 */
async function publishToTranscodeTopic(
  topic: string,
  payload: TranscodePayload | TranscoderWarmPayload,
  signal: AbortSignal,
  attributes?: Record<string, string>,
): Promise<Response> {
  const client = await getPubSubAuth().getClient();
  const tokenResponse = await client.getAccessToken();
  const token = tokenResponse?.token;
  if (!token) {
    throw new Error("Failed to obtain Pub/Sub access token");
  }

  const data = Buffer.from(JSON.stringify(payload)).toString("base64");

  return fetch(`https://pubsub.googleapis.com/v1/${topic}:publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal,
    body: JSON.stringify({
      messages: [attributes ? { data, attributes } : { data }],
    }),
  });
}

/**
 * Body of the warm-up message. The transcoder's `/pubsub/push` acks it with a
 * 200 and does no work: delivering the push request is what boots an instance.
 * MUST match `transcoderWarmMessageSchema` in apps/audio-transcoder/src/app.ts.
 */
type TranscoderWarmPayload = { kind: "warm" };
const TRANSCODER_WARM_PAYLOAD: TranscoderWarmPayload = { kind: "warm" };

/**
 * Wake the audio transcoder when an upload STARTS, so its cold start overlaps
 * the browser's PUT of the file rather than following finalize. Prod runs the
 * transcoder at min 0 instances on the strength of this
 * (infra/terraform/envs/prod/prod.tfvars, audio_transcoder_min_instances).
 *
 * Deployed: one warm message on the transcode topic, through the same push
 * subscription that carries real jobs. It rejects on any failure; the caller
 * (`requestEventAudioUpload`) waits a bounded time for it, logs and reports.
 *
 * Local (AUDIO_TRANSCODER_URL only): a GET of `/health`. A local transcoder
 * that is not running is normal, so this path never rejects: it notes the miss
 * at warn and nothing reaches Sentry. Neither env var set: nothing to wake.
 */
export async function warmTranscoder(deps: {
  logger: LoggerPort;
}): Promise<void> {
  const topic = process.env.AUDIO_TRANSCODE_TOPIC;
  const transcoderUrl = process.env.AUDIO_TRANSCODER_URL;
  if (!topic && !transcoderUrl) return;

  // Publishing takes milliseconds; locally the GET waits on the boot itself.
  // The use case stops waiting after WARM_UP_WAIT_MS, so this bound only stops
  // a hung socket.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    if (topic) {
      const res = await publishToTranscodeTopic(
        topic,
        TRANSCODER_WARM_PAYLOAD,
        controller.signal,
        { kind: "warm" },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "<unreadable>");
        throw new Error(
          `Transcoder warm-up responded ${res.status}: ${body.slice(0, 500)}`,
        );
      }
      return;
    }

    try {
      const res = await fetch(`${transcoderUrl}/health`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        deps.logger.warn("Local audio transcoder warm-up got a non-ok status", {
          status: res.status,
        });
      }
    } catch (err) {
      deps.logger.warn("Local audio transcoder not reachable for warm-up", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

type TranscodeDispatchDeps = {
  logger: LoggerPort;
  markTranscoding: (input: { id: string }) => Promise<unknown>;
  markFailed: (input: {
    id: string;
    failedAt: Date;
    failureReason: string;
  }) => Promise<unknown>;
};

/**
 * Mark the upload as TRANSCODING then dispatch the transcode job. Prefers the
 * Pub/Sub publish path (AUDIO_TRANSCODE_TOPIC); falls back to a direct
 * `/transcode` fetch (AUDIO_TRANSCODER_URL) for local dev; otherwise skips with
 * a warning. The dispatch itself is fire-and-forget (not awaited) so it never
 * blocks the client mutation.
 */
export async function dispatchTranscodeJob(
  payload: TranscodePayload,
  deps: TranscodeDispatchDeps,
): Promise<void> {
  const { logger } = deps;
  const topic = process.env.AUDIO_TRANSCODE_TOPIC;
  const transcoderUrl = process.env.AUDIO_TRANSCODER_URL;

  if (!topic && !transcoderUrl) {
    logger.warn(
      "AUDIO_TRANSCODE_TOPIC / AUDIO_TRANSCODER_URL not set — skipping transcode enqueue",
      { audioUploadId: payload.audioUploadId },
    );
    return;
  }

  // Mark as TRANSCODING before dispatching so the UI shows progress.
  await deps.markTranscoding({ id: payload.audioUploadId });

  // Fire-and-forget: dispatch the transcode job but don't block the client
  // mutation. The transcoder runs async; the client polls resolveAudio every
  // 10s to pick up the result. Use a 90s timeout to tolerate Cloud Run cold
  // starts (~30s) plus processing time for small files.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  const dispatch = topic
    ? publishToTranscodeTopic(topic, payload, controller.signal)
    : fetch(`${transcoderUrl}/transcode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload),
      });

  dispatch
    .then(async (res) => {
      clearTimeout(timeout);
      if (!res.ok) {
        const body = await res.text().catch(() => "<unreadable>");
        logger.error("Transcode job failed", {
          audioUploadId: payload.audioUploadId,
          status: res.status,
          body,
        });
        await deps
          .markFailed({
            id: payload.audioUploadId,
            failedAt: new Date(),
            failureReason: `Transcoder responded ${res.status}: ${body}`,
          })
          .catch(() => {});
      } else {
        logger.info("Transcode job dispatched", {
          audioUploadId: payload.audioUploadId,
        });
      }
    })
    .catch(async (err) => {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === "AbortError";
      logger.error("Transcode job dispatch failed", {
        audioUploadId: payload.audioUploadId,
        error: message,
        timedOut: isTimeout,
      });
      await deps
        .markFailed({
          id: payload.audioUploadId,
          failedAt: new Date(),
          failureReason: isTimeout
            ? "Transcoder request timed out (90s) — possible cold start or overload"
            : `Dispatch failed: ${message}`,
        })
        .catch(() => {});
    });
}

// IPv6 is bucketed on its /64 (one allocation = one caller); IPv4 is
// byte-identical to the raw address, so existing counters keep their keys.
// Shared by the validatePassword, getPublicApplicationForm, submitApplication
// and redeemApplicationToken limiters.
const eventPasswordRateLimitIpKey = (ctx: Ctx): string =>
  `ip:${rateLimitIpBucket(ctx.clientIp) ?? "no-ip"}`;

/**
 * INVALID opt-out tokens one IP may present per minute, across ALL three
 * opt-out procedures (peekInviteOptOut, stopOrganiserInvites,
 * stopAllInvites): one bucket, so rotating between them can't triple it.
 */
const INVITE_OPT_OUT_INVALID_PER_MINUTE = 30;

const inviteOptOutInvalidKey = (ctx: Ctx): string =>
  `event:inviteOptOut:invalid:${eventPasswordRateLimitIpKey(ctx)}`;

const eventPasswordRateLimitActorKey = (ctx: Ctx): string =>
  ctx.actorHumanId ? `human:${ctx.actorHumanId}` : "anonymous";

const saveEventForOrgInput = saveEventForOrgInputSchema.omit({
  actorHumanId: true,
});
const createHumanEventInput = saveEventForHumanInputSchema.omit({
  actorHumanId: true,
});
const regenerateEventSlugInput = regenerateEventSlugInputSchema.omit({
  actorHumanId: true,
});
const featureEventInput = featureEventInputSchema.omit({ actorHumanId: true });
const setEventListingPriorityInput = setEventListingPriorityInputSchema.omit({
  actorHumanId: true,
});
const getEventForEditInput = getEventForEditInputSchema.omit({
  actorHumanId: true,
});
const getEventTitleInput = getEventTitleInputSchema.omit({
  actorHumanId: true,
});
const getEventProvenanceInput = getEventProvenanceInputSchema.omit({
  actorHumanId: true,
});
const publishEventInput = publishEventInputSchema.omit({
  actorHumanId: true,
  ipAddress: true,
  userAgent: true,
});
const inviteLineupHumanToRegisterInput =
  inviteLineupHumanToRegisterInputSchema.omit({ actorHumanId: true });
const getEventSplitsInput = getEventSplitsInputSchema.omit({
  actorHumanId: true,
});
const updateEventSplitsInput = updateEventSplitsInputSchema.omit({
  actorHumanId: true,
});
const cancelEventInput = cancelEventInputSchema.omit({ actorHumanId: true });
const unpublishEventInput = unpublishEventInputSchema.omit({
  actorHumanId: true,
});
const completeEventInput = completeEventInputSchema.omit({
  actorHumanId: true,
});
const archiveEventInput = archiveEventInputSchema.omit({
  actorHumanId: true,
});
const deleteEventInput = deleteEventInputSchema.omit({ actorHumanId: true });
const listEventTicketTypesForEditInput =
  listEventTicketTypesForEditInputSchema.omit({ actorHumanId: true });
const listEventApplicationSubmissionsInput =
  listEventApplicationSubmissionsInputSchema.omit({
    actorHumanId: true,
  });
const reviewEventApplicationSubmissionInput =
  reviewEventApplicationSubmissionInputSchemaBase.omit({
    actorHumanId: true,
  });
const rescindEventApplicationDecisionInput =
  rescindEventApplicationDecisionInputSchema.omit({
    actorHumanId: true,
  });
const withdrawEventApplicationInput = withdrawEventApplicationInputSchema.omit({
  actorHumanId: true,
});
const joinEventWaitlistInput = joinEventWaitlistInputSchemaBase.omit({
  viewerHumanId: true,
  // Server-derived (ctx.clientIp) for Turnstile's remoteip; never client-set.
  requestIp: true,
});
const listEventOwnerEntitiesInput = listEventOwnerEntitiesInputSchema.omit({
  actorHumanId: true,
});
const listEventTicketTypesInput = listEventTicketTypesInputSchema;
// Base (unrefined) schema so `.omit()` works; the expandDates-requires-a-
// bounded-dateRange rule is re-attached here from the SAME predicate the
// core schema uses, so an unbounded expanding read is refused at the wire
// (BAD_REQUEST) and the two never drift.
const listMyEventsInput = listMyEventsInputSchemaBase
  .omit({
    actorHumanId: true,
  })
  .superRefine(assertExpandDatesBounded);
const assignTicketTypeSectionsInput = assignTicketTypeSectionsInputSchema.omit({
  actorHumanId: true,
});
const setSeatPriceOverridesInput = setSeatPriceOverridesInputSchema.omit({
  actorHumanId: true,
});
const listEventSeatPriceOverridesForEditInput =
  listEventSeatPriceOverridesForEditInputSchema.omit({ actorHumanId: true });
const getEventFeePreviewInput = getEventFeePreviewInputSchema.omit({
  actorHumanId: true,
});

// Access controls and application form inputs
const updateEventAccessControlsInput =
  updateEventAccessControlsInputSchemaBase.omit({ actorHumanId: true });
const updateEventSettingsInput = updateEventSettingsInputSchemaBase.omit({
  actorHumanId: true,
});
// Base (unrefined) schema so `.omit()` works; the closesAt-after-opensAt
// refinement still runs inside the use case's parseInput.
const upsertEventApplicationFormInput =
  upsertEventApplicationFormInputSchemaBase.omit({ actorHumanId: true });
// Can't use .omit() on intersection types, so build a shape manually
const upsertEventApplicationQuestionInput = z.object({
  eventId: z.string().uuid(),
  formId: z.string().uuid(),
  questionId: z.string().uuid().optional(),
  type: z
    .enum(["SHORT_TEXT", "LONG_TEXT", "SINGLE_CHOICE", "MULTI_CHOICE"])
    .optional(),
  label: z.string().min(1).max(300).optional(),
  description: z.string().max(1000).optional(),
  // Two accepted option shapes: the builder's `{ value, label? }` (display
  // text in `value`) and the canonical at-rest `{ id, label }`. Core
  // (upsert-event-application-question) normalizes both to `{ id, label }` —
  // transport only validates.
  options: z
    .array(
      z.union([
        z.object({
          id: z.string().min(1).max(64),
          label: z.string().min(1).max(200),
        }),
        z.object({
          value: z.string().min(1).max(200),
          label: z.string().max(200).optional(),
        }),
      ]),
    )
    .optional(),
  isRequired: z.boolean().optional(),
  order: z.number().int().min(0).max(10_000).optional(),
});
const deleteEventApplicationQuestionInput =
  deleteEventApplicationQuestionInputSchema.omit({ actorHumanId: true });

// Image upload procedures
const requestEventImageUploadInput = requestEventImageUploadInputSchema.omit({
  actorHumanId: true,
});
const finalizeEventImageUploadInput = finalizeEventImageUploadInputSchema.omit({
  actorHumanId: true,
});
const resolveEventImagesInput = resolveEventImagesInputSchema;

// Audio upload procedures
const requestEventAudioUploadInput = requestEventAudioUploadInputSchema.omit({
  actorHumanId: true,
});
const finalizeEventAudioUploadInput = finalizeEventAudioUploadInputSchema.omit({
  actorHumanId: true,
});
// Identity is server-derived from `ctx.actorHumanId` — never accepted from the
// client. Matches `getEventGateStateInput` below and the `actorHumanId` omits
// above: with `.strict()` but no omit, a hostile body carrying someone else's
// id is ACCEPTED rather than rejected, and the only thing preventing a spoof
// is the order of two lines in the handler's object literal.
const resolveEventAudioInput = resolveEventAudioInputSchema.omit({
  viewerHumanId: true,
});

// Gate state and password validation inputs (viewer is optional to detect bypass)
// `applicationGrant` is server-injected from the HMAC-verified
// `th_ea_<eventId>` cookie. Letting a client name a submission id (and its
// approval stamp) would turn any leaked/guessed APPROVED submission into a
// gate bypass. `inviteGrant` likewise comes only from the verified
// `th_ei_<eventId>` cookie: a client-named invite id would open the gate for
// anyone who learned one.
const getEventGateStateInput = getEventGateStateInputSchema.omit({
  viewerHumanId: true,
  applicationGrant: true,
  inviteGrant: true,
  explainRemoval: true,
});
// `requestIp` is server-injected (ctx.clientIp), never client-suppliable.
// `turnstileToken` stays public: the failure gate asks for it.
const validateEventPasswordInput = validateEventPasswordInputSchema.omit({
  viewerHumanId: true,
  requestIp: true,
});
const recordSignedPasswordUnlockInput =
  recordVerifiedEventPasswordUnlockInputSchema.omit({
    humanId: true,
  });
// Only the event id is client input: the submission id and its approval stamp
// come from the signed grant cookie and the human from the session.
const recordSignedApplicationUnlockInput = z
  .object({ eventId: z.string().uuid() })
  .strict();
// Same for the invite grant: the invite id and expiry come from the signed
// `th_ei_` cookie, never the body.
const recordSignedInviteUnlockInput = z
  .object({ eventId: z.string().uuid() })
  .strict();
const getEventGatedPreviewInput = getEventGatedPreviewInputSchema;
const getPublicEventApplicationFormInput =
  getPublicEventApplicationFormInputSchema;
// `viewerHumanId` and `requestIp` are server-injected (ctx.actorHumanId /
// ctx.clientIp) — never client-suppliable.
const submitEventApplicationInput = submitEventApplicationInputSchemaBase.omit({
  viewerHumanId: true,
  requestIp: true,
});

// Anonymous-allowed: viewerHumanId is injected from ctx, never client-supplied.
const redeemApplicationApprovalTokenInput =
  redeemApplicationApprovalTokenInputSchema.omit({ viewerHumanId: true });

// Gated-event invite links (docs/specs/2026-10-02/completed/gated-event-invite-links.spec.yaml).
// The actor comes from the session on every organizer procedure.
const setSharedInviteInput = setEventSharedInviteInputSchema.omit({
  actorHumanId: true,
});
const [createGuestInvitesByGuestsInput, createGuestInvitesByListInput] =
  createEventGuestInvitesInputSchema.options;
const createGuestInvitesInput = z.union([
  createGuestInvitesByGuestsInput.omit({ actorHumanId: true }),
  createGuestInvitesByListInput.omit({ actorHumanId: true }),
]);
const resendGuestInviteInput = resendEventGuestInviteInputSchema.omit({
  actorHumanId: true,
});
const revokeGuestInviteInput = revokeEventGuestInviteInputSchema.omit({
  actorHumanId: true,
});
const listInvitesInput = listEventInvitesInputSchema.omit({
  actorHumanId: true,
});
// Only the token and `expectedEventId` (the event the caller's URL names; a
// token for another event dies as INVALID before any write) are client
// input. The viewer comes from the session and `currentInviteGrantId` from a
// verified `th_ei_` cookie, never the body.
const redeemInviteInput = redeemEventInviteInputSchema.omit({
  viewerHumanId: true,
  currentInviteGrantId: true,
});
/**
 * What the web redeem route needs to set the right cookie (`th_ei_` for
 * INVITE_GRANT, `th_ea_` for APPLICATION_GRANT, none for UNLOCK). Never
 * carries the token. `expiresAtMs` is the event end: the grant cookie's
 * `expMs` and Max-Age bound (FR-008).
 */
const redeemInviteOutputSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(false),
      reason: redeemEventInviteDeadReasonSchema,
      eventId: z.string().uuid().nullable(),
      slug: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(true),
      eventId: z.string().uuid(),
      slug: z.string().nullable(),
      grant: redeemEventInviteGrantSchema,
      inviteId: z.string().uuid(),
      submissionId: z.string().uuid().nullable(),
      approvedAtMs: z.number().int().nonnegative().nullable(),
      expiresAtMs: z.number().int().nonnegative(),
      created: z.boolean(),
    })
    .strict(),
]);

type SaveEventForOrgProcedureInput = z.infer<typeof saveEventForOrgInput>;
type CreateHumanEventProcedureInput = z.infer<typeof createHumanEventInput>;

const getDefaultEventsRegionCode = (): string | null =>
  process.env.THC_EVENTS_DEFAULT_REGION_CODE?.trim().toLowerCase() ?? null;

const localEventsProcedureInput = z
  .object({
    regionCode: listEventsByLocationInputSchema.shape.regionCode.optional(),
    limit: listEventsByLocationInputSchema.shape.limit,
    offset: listEventsByLocationInputSchema.shape.offset,
  })
  .strict();

const countryEventsProcedureInput = z
  .object({
    countryCode: listEventsByCountryInputSchema.shape.countryCode.optional(),
    limit: listEventsByCountryInputSchema.shape.limit,
    offset: listEventsByCountryInputSchema.shape.offset,
  })
  .strict();

const resolveRegionCode = (
  explicit: string | undefined,
  viewerRegion: string | null,
): string => {
  const candidate = explicit ?? viewerRegion ?? getDefaultEventsRegionCode();
  if (!candidate) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "region_required" });
  }

  return candidate;
};

const resolveCountryCode = (
  explicit: string | undefined,
  viewerCountry: string | null,
): string => {
  const candidate = explicit ?? viewerCountry;
  if (!candidate) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "country_required" });
  }

  return candidate;
};

const toIsoString = (value: Date | string): string => {
  if (value instanceof Date) return value.toISOString();
  return value;
};

const buildOrgUseCaseInput = (
  input: SaveEventForOrgProcedureInput,
  actorHumanId: string,
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    ...input,
    actorHumanId,
    startsAt: toIsoString(input.startsAt),
  };

  if (input.endsAt !== undefined) {
    payload.endsAt = input.endsAt === null ? null : toIsoString(input.endsAt);
  }

  return payload;
};

const buildHumanUseCaseInput = (
  input: CreateHumanEventProcedureInput,
  actorHumanId: string,
): Record<string, unknown> => {
  const payload: Record<string, unknown> = {
    ...input,
    actorHumanId,
    startsAt: toIsoString(input.startsAt),
  };

  if (input.endsAt !== undefined) {
    payload.endsAt = input.endsAt === null ? null : toIsoString(input.endsAt);
  }

  return payload;
};

const baseEventsRouter = {
  listEventOwnerEntities: authedProcedure
    .input(listEventOwnerEntitiesInput)
    .output(listEventOwnerEntitiesOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listEventOwnerEntities>[0];

      try {
        return await listEventOwnerEntities(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  listMine: authedProcedure
    .input(listMyEventsInput)
    .output(listMyEventsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listMyEvents>[0];

      try {
        return await listMyEvents(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  getEventForEdit: authedProcedure
    .input(getEventForEditInput)
    .output(getEventForEditOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        // Required: the community-moderator branch that lets the builder
        // hydrate an ownerless COMMUNITY listing probes `hasStaffRole`.
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof getEventForEdit>[0];

      try {
        return await getEventForEdit(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  /**
   * "This event came from a booking request" breadcrumb — lives on the EVENTS
   * router, not `bookingAgreements`, because the subject is the event: the
   * input is an event id and the gate is the event editor's own
   * `ensureActorCanEditEvent`. The bookingAgreements router gates on
   * AGREEMENT PARTY, which is the wrong question to ask of someone who only
   * has an event in hand.
   *
   * No rate limit, matching the neighbouring admin read queries
   * (`getEventForEdit`, `getEventTitle`): authed, org-scoped, cheap, and
   * already bounded by the same event-edit gate they are.
   */
  getEventProvenance: authedProcedure
    .input(getEventProvenanceInput)
    .output(getEventProvenanceOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getEventProvenance>[0];

      try {
        // actorHumanId comes from ctx and is spread LAST — a client-supplied
        // `actorHumanId` is already impossible (omitted from the input schema,
        // which is `.strict()`), and this keeps it that way if the omit ever
        // slips.
        return await getEventProvenance(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  getEventTitle: authedProcedure
    .input(getEventTitleInput)
    .output(getEventTitleOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        // Required: the community-moderator arm that lets the event admin
        // shell load an ownerless COMMUNITY listing probes `hasStaffRole`.
        authz: ctx.authz,
        logger: ctx.logger,
      } satisfies Parameters<typeof getEventTitle>[0];

      try {
        return await getEventTitle(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  listTicketTypesForEdit: authedProcedure
    .input(listEventTicketTypesForEditInput)
    .output(listEventTicketTypesForEditOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof listEventTicketTypesForEdit>[0];

      try {
        return await listEventTicketTypesForEdit(deps, {
          ...input,
          actorHumanId,
        });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  getEventFeePreview: authedProcedure
    .input(getEventFeePreviewInput)
    .output(getEventFeePreviewOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // Same quote-path lookup as the event page: a venue with no cached
        // rate is looked up once and cached; an unknown rate previews with no
        // tax figure, never 0% (owner ruling 2026-10-06).
        taxLookup: taxLookupFor(ctx),
      } satisfies Parameters<typeof getEventFeePreview>[0];

      try {
        return await getEventFeePreview(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  assignTicketTypeSections: authedProcedure
    .input(assignTicketTypeSectionsInput)
    .output(assignTicketTypeSectionsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof assignTicketTypeSections>[0];

      try {
        return await assignTicketTypeSections(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  setSeatPriceOverrides: authedProcedure
    .input(setSeatPriceOverridesInput)
    .output(setSeatPriceOverridesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof setSeatPriceOverrides>[0];

      try {
        return await setSeatPriceOverrides(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  // The override editor's read: the write's own authz gate, any event status,
  // with the organizer's private `reason` (the public seat map strips it).
  listEventSeatPriceOverridesForEdit: authedProcedure
    .input(listEventSeatPriceOverridesForEditInput)
    .output(listEventSeatPriceOverridesForEditOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof listEventSeatPriceOverridesForEdit>[0];

      try {
        return await listEventSeatPriceOverridesForEdit(deps, {
          ...input,
          actorHumanId,
        });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  publishEvent: authedProcedure
    .input(publishEventInput)
    .output(publishEventWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      // FR-018: the publish may have taken held dates on its calendar; the
      // notifications it owes are dispatched AFTER the commit and never fail
      // the publish. The intents never cross the wire.
      const notifyHoldIntents = makeEventHoldIntentsNotifier(ctx);

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        // Best-effort incremental search-index update on success.
        search: ctx.multiSearch ?? undefined,
        // Surface a dropped fire-and-forget reindex in Sentry.
        reportError: ctx.reportError ?? undefined,
        // Publish-time safety net: last-chance tax lookup when the event's
        // location has no cached rate yet.
        taxRateLookup: ctx.taxRateLookup ?? null,
        // W1: a publisher who manages the event's place stamps the venue
        // confirmation.
        authz: ctx.authz,
        // Tell every person owed a "you're on the lineup" notice.
        lineupNotices: makeLineupNoticeNotifier(ctx),
      } satisfies Parameters<typeof publishEvent>[0];

      let result;
      try {
        result = await publishEvent(deps, {
          ...input,
          actorHumanId,
          ipAddress: ctx.clientIp,
          userAgent: ctx.userAgent,
        });
      } catch (error) {
        throw toTrpcError(error);
      }
      await notifyHoldIntents({ output: result, actorHumanId });
      return publishEventWireOutputSchema.parse(result);
    }),
  cancelEvent: authedProcedure
    .input(cancelEventInput)
    .output(cancelEventOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

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
      } satisfies Parameters<typeof cancelEvent>[0];

      try {
        return await cancelEvent(deps, { ...input, actorHumanId });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  unpublishEvent: authedProcedure
    .input(unpublishEventInput)
    .output(unpublishEventOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await unpublishEvent(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            // Best-effort: REMOVE the now-DRAFT event from search promptly.
            search: ctx.multiSearch ?? undefined,
            reportError: ctx.reportError ?? undefined,
          },
          { ...input, actorHumanId },
        );
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  completeEvent: authedProcedure
    .input(completeEventInput)
    .output(completeEventOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await completeEvent(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  archiveEvent: authedProcedure
    .input(archiveEventInput)
    .output(archiveEventOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        return await archiveEvent(
          {
            repos: ctx.repos,
            authz: ctx.authz,
            clock: ctx.clock,
            logger: ctx.logger,
          },
          { ...input, actorHumanId },
        );
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  deleteEvent: authedProcedure
    .input(deleteEventInput)
    .output(deleteEventOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      try {
        const openCallNotices = makeOpenCallNotifier(ctx);
        return await deleteEvent(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            // Best-effort reconciliation: getById → null → REMOVE any drift.
            search: ctx.multiSearch ?? undefined,
            reportError: ctx.reportError ?? undefined,
            // Open calls FR-022: a posted call on the draft is pulled, and
            // every notice its applicants are owed settled, before the
            // cascade. The ledger is the notifier's own store.
            notifyOpenCallPulled: openCallNotices.notifyOpenCallPulled,
            notifyOpenCallNotThisTime: openCallNotices.notifyOpenCallNotThisTime,
            openCallNoticeLedger: ctx.idempotency,
          },
          { ...input, actorHumanId },
        );
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
  getEventSeo: optionalProcedure
    .input(getEventSeoInputSchema.omit({ viewerHumanId: true }))
    .output(getEventSeoOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        // N3 FIRST: a page that was never public is NOT_FOUND to anyone
        // without edit rights — before the gate check, which would otherwise
        // answer a gated draft with `event_password_required`.
        await ensureEventReadableBySlug(ctx.repos, {
          slug: input.slug,
          viewerHumanId: ctx.actorHumanId ?? null,
        }, ctx.authz);
        await ensureFullEventReadAccessBySlug(ctx, input.slug);
        const deps = {
          repos: ctx.repos,
          clock: ctx.clock,
          logger: ctx.logger,
          authz: ctx.authz,
          // arrival-areas FR-009 / FR-017: an act on the bill sees the exact
          // address beside their load-in shapes, only while the
          // `arrivalAreas` gate is on. A dep, never client input. Read only
          // for a signed-in viewer: an anonymous read has no act to unlock,
          // so the public page pays no settings read for it.
          actAddressEnabled: ctx.actorHumanId
            ? (
                await getFeatureGates({
                  platformSettings: ctx.repos.platformSettings,
                  reportError: ctx.reportError ?? undefined,
                })
              ).arrivalAreas === true
            : false,
        } satisfies Parameters<typeof getEventSeo>[0];
        return await getEventSeo(deps, {
          ...input,
          ...(ctx.actorHumanId ? { viewerHumanId: ctx.actorHumanId } : {}),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  getPublicEventBody: optionalProcedure
    .input(getPublicEventBodyInputSchema.omit({ viewerHumanId: true }))
    .output(getPublicEventBodyOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        authz: ctx.authz,
      } satisfies Parameters<typeof getPublicEventBody>[0];
      const viewerHumanId = ctx.actorHumanId ?? null;

      try {
        // N3 FIRST, as in `getEventSeo`: the gate check below would answer a
        // gated draft with `event_password_required`.
        await ensureEventReadableBySlug(ctx.repos, {
          slug: input.slug,
          viewerHumanId,
        }, ctx.authz);
        await ensureFullEventReadAccessBySlug(ctx, input.slug);
        return await getPublicEventBody(deps, { ...input, viewerHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  listEventTicketTypes: optionalProcedure
    .input(listEventTicketTypesInput)
    .output(listEventTicketTypesOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof listEventTicketTypes>[0];

      try {
        await ensureFullEventReadAccessByEventId(ctx, input.eventId);
        return await listEventTicketTypes(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  getCheckoutFeeRates: optionalProcedure
    .input(getCheckoutFeeRatesInputSchema)
    .output(getCheckoutFeeRatesOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // A venue with no cached tax rate is looked up ONCE and cached there
        // (owner ruling 2026-10-06); a failed lookup refuses the quote with
        // TAX_RATE_UNAVAILABLE instead of quoting 0%.
        taxLookup: taxLookupFor(ctx),
      } satisfies Parameters<typeof getCheckoutFeeRates>[0];

      try {
        await ensureFullEventReadAccessByEventId(ctx, input.eventId);
        return await getCheckoutFeeRates(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  ticketTiersForCard: optionalProcedure
    .input(ticketTiersForCardInputSchema)
    .output(ticketTiersForCardOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof ticketTiersForCard>[0];

      try {
        // A gate-failing viewer gets an EMPTY answer here, not the FORBIDDEN
        // every sibling read gives. This is a hover teaser on a card that
        // cannot know its event is gated, so a refusal is a console error on
        // every hover. Nothing is revealed: the same gate decision runs and a
        // viewer who fails it gets no tier data at all. The event page is the
        // place that explains the gate. Not a catch: a failed gate read still
        // throws.
        if (!(await hasFullEventReadAccessByEventId(ctx, input.eventId))) {
          return { tiers: [] };
        }
        return await ticketTiersForCard(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  estimateCheckoutTax: optionalProcedure
    .input(estimateCheckoutTaxInputSchema)
    .output(estimateCheckoutTaxOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // A venue with no cached tax rate is looked up ONCE and cached there
        // (owner ruling 2026-10-06); a failed lookup refuses the quote with
        // TAX_RATE_UNAVAILABLE instead of quoting 0%.
        taxLookup: taxLookupFor(ctx),
      } satisfies Parameters<typeof estimateCheckoutTax>[0];

      try {
        await ensureFullEventReadAccessByEventId(ctx, input.eventId);
        return await estimateCheckoutTax(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  listEventSeatAvailability: optionalProcedure
    .input(listEventSeatAvailabilityInputSchema)
    .output(listEventSeatAvailabilityOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: throttledPublicReadReporter(ctx.reportError),
      } satisfies Parameters<typeof listEventSeatAvailability>[0];

      try {
        await ensureFullEventReadAccessByEventId(ctx, input.eventId);
        return await listEventSeatAvailability(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  listEventSitemapEntries: publicProcedure
    .input(listEventSitemapEntriesInputSchema)
    .output(listEventSitemapEntriesOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listEventSitemapEntries>[0];

      try {
        return await listEventSitemapEntries(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  getRandomEvent: publicProcedure
    .input(getRandomEventInput)
    .output(randomEventDto)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getRandomEvent>[0];

      try {
        return await getRandomEvent(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  localEvents: publicProcedure
    .input(localEventsProcedureInput)
    .output(z.object({ events: z.array(eventSummaryDtoSchema) }))
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof listEventsByLocation>[0];

      try {
        const { regionCode: explicitRegion, ...rest } = input;
        const result = await listEventsByLocation(deps, {
          ...rest,
          regionCode: resolveRegionCode(
            explicitRegion,
            ctx.viewerLocation?.regionCode ?? null,
          ),
        });
        return { events: localEventsToDto(result.events) };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  countryEvents: publicProcedure
    .input(countryEventsProcedureInput)
    .output(z.object({ events: z.array(eventSummaryDtoSchema) }))
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        // Required now that this query loads the tier rollup — the price on
        // every card it produces is resolved at `now` (FR-003).
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
        // Anonymous requests only — see `isAnonymousRequest`.
        cache: publicDiscoveryCacheFor(ctx),
      } satisfies Parameters<typeof listEventsByCountry>[0];

      try {
        const { countryCode: explicitCountry, ...rest } = input;
        const result = await listEventsByCountry(deps, {
          ...rest,
          countryCode: resolveCountryCode(
            explicitCountry,
            ctx.viewerLocation?.countryCode ?? null,
          ),
        });
        return { events: countryEventsToDto(result.events) };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  nearbyEvents: publicProcedure
    .input(listEventsNearCoordinateInputSchema)
    .output(z.object({ events: z.array(eventSummaryDtoSchema) }))
    .query(async ({ ctx, input }) => {
      const deps = {
        geo: ctx.geo,
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listEventsNearCoordinate>[0];

      try {
        const result = await listEventsNearCoordinate(deps, input);
        return { events: nearbyEventsToDto(result.events) };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  /**
   * Geo×category SEO landing page data — upcoming published events in a
   * category filtered by a canonical city segment (e.g. "nashville-tn").
   * Community/ownerless listings are included. Public.
   */
  geoCategoryEvents: publicProcedure
    .input(listEventsByCategoryAndCityInputSchema)
    .output(
      z.object({
        events: z.array(eventSummaryDtoSchema),
        total: z.number().int(),
        /** Ungated matches: the page's robots threshold counts these only. */
        indexableTotal: z.number().int(),
        categoryName: z.string(),
        /** The category's names in every language (`{ en, es? }`). */
        names: categoryNamesSchema,
        cityLabel: z.string(),
        regionCode: z.string().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        const result = await listEventsByCategoryAndCity(
          {
            repos: ctx.repos,
            clock: ctx.clock,
            logger: ctx.logger,
            reportError: ctx.reportError ?? undefined,
          },
          input,
        );
        // Pricing-aware mapper: derives "Free" / "$X" card labels from each
        // summary's `pricing` rollup (same path as events.localEvents).
        return {
          events: localEventsToDto(result.events),
          total: result.total,
          indexableTotal: result.indexableTotal,
          categoryName: result.categoryName,
          names: result.names,
          cityLabel: result.cityLabel,
          regionCode: result.regionCode,
        };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  /** Lightweight coordinate list for map markers — reuses nearby-events use case. */
  nearbyEventsForMap: publicProcedure
    .input(listEventsNearCoordinateInputSchema)
    .output(z.object({ events: z.array(mapEventDtoSchema) }))
    .query(async ({ ctx, input }) => {
      const deps = {
        geo: ctx.geo,
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listEventsNearCoordinate>[0];

      // Hero map only shows events happening within the next 7 days
      const now = new Date();
      const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const enrichedInput = {
        ...input,
        startsAfter: input.startsAfter ?? now,
        startsBefore: input.startsBefore ?? weekFromNow,
      };

      try {
        const result = await listEventsNearCoordinate(deps, enrichedInput);
        return { events: nearbyEventsToMapDto(result.events) };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  /**
   * Overview map endpoint — returns all geocoded events within the continental US
   * bounding box so the homepage map shows pins without needing user location.
   */
  eventsForMapOverview: publicProcedure
    .input(listEventsForMapOverviewInputSchema)
    .output(z.object({ events: z.array(mapEventDtoSchema) }))
    .query(async ({ ctx, input }) => {
      const deps = {
        geo: ctx.geo,
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listEventsForMapOverview>[0];

      // Hero map only shows events happening within the next 7 days
      const now = new Date();
      const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const enrichedInput = {
        ...input,
        startsAfter: input.startsAfter ?? now,
        startsBefore: input.startsBefore ?? weekFromNow,
      };

      try {
        const result = await listEventsForMapOverview(deps, enrichedInput);
        return { events: nearbyEventsToMapDto(result.events) };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  /** Public discovery list — returns published events enriched with distance and tags. */
  discoverPublic: publicProcedure
    .input(discoverPublicEventsInputSchema)
    .output(
      z.object({ events: z.array(eventSummaryDtoSchema), total: z.number() }),
    )
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof discoverPublicEvents>[0];

      try {
        const result = await discoverPublicEvents(deps, input);
        return {
          events: discoverEventsToDto(result.events),
          total: result.total,
        };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  /**
   * Public "city by city" marquee — distinct cities with upcoming published,
   * public events, ordered most-active first. Cached, unauthenticated.
   */
  discoverActiveCities: publicProcedure
    .input(discoverActiveCitiesInputSchema)
    .output(discoverActiveCitiesOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof discoverActiveCities>[0];

      try {
        return await discoverActiveCities(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  searchPublishedEvents: publicProcedure
    .input(searchPublishedEventsInputSchema)
    .output(searchPublishedEventsOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        search: ctx.multiSearch,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof searchPublishedEvents>[0];

      try {
        return await searchPublishedEvents(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  // optionalProcedure, not public: a history-slug REDIRECT is only answered
  // for a viewer who may read the event (N3), and an editor of a draft is
  // one. The viewer comes from the session, never from the input.
  resolveEventBySlug: optionalProcedure
    .input(resolveEventBySlugInputSchema.omit({ viewerHumanId: true }))
    .output(resolveEventBySlugOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        authz: ctx.authz,
      } satisfies Parameters<typeof resolveEventBySlug>[0];

      try {
        return await resolveEventBySlug(deps, {
          ...input,
          viewerHumanId: ctx.actorHumanId ?? null,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  // `/e/<shortId>` short links. publicProcedure, not optional: the answer
  // depends on the event alone (publicly readable or not), never on who is
  // looking — so no viewer is resolved at all.
  resolveEventShortLink: publicProcedure
    .input(resolveEventShortLinkInputSchema)
    .output(resolveEventShortLinkOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof resolveEventShortLink>[0];

      try {
        return await resolveEventShortLink(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  // Owner ruling (ban-that-sticks): a TICKET HOLDER keeps a banned owner's
  // event page. Asked only by the web 404's one uncached re-check
  // (`POST /api/events/holder-view`); the viewer comes from the session.
  // Every "no" is the same null.
  getBannedOwnerHolderAccess: optionalProcedure
    .input(getBannedOwnerHolderAccessInputSchema.omit({ viewerHumanId: true }))
    .output(getBannedOwnerHolderAccessOutputSchema)
    .query(async ({ ctx, input }) => {
      try {
        return await getBannedOwnerHolderAccess(
          { repos: ctx.repos, logger: ctx.logger },
          { ...input, viewerHumanId: ctx.actorHumanId ?? null },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  joinEventWaitlist: optionalProcedure
    .input(joinEventWaitlistInput)
    // Per-IP per-event (F8, 2026-09-29): the join is anonymous and each new
    // address can trigger an organiser-written confirmation email. Chained
    // AFTER `.input()` because the key reads `input.eventId`. The per-event
    // and per-recipient EMAIL caps live in the use case, post-Turnstile.
    .use(
      rateLimit<{ eventId: string }>({
        key: (ctx, input) =>
          `events:joinWaitlist:${ctx.clientIp ?? "no-ip"}:${input.eventId}`,
        // Generous for a shared NAT (a venue's wifi at a show); the email
        // caps in the use case are the real ceiling.
        maxRequests: 30,
        windowSeconds: 60 * 60,
        message: "joining this waitlist",
      }),
    )
    .output(joinEventWaitlistOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ensureWaitlistsEnabled(ctx);

      // No mailer is wired here, so the confirmation email does not send
      // today; turnstile + rateLimit are threaded so the caps are already in
      // force the day it is.
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        turnstile: ctx.turnstile ?? null,
        rateLimit: ctx.rateLimit,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof joinEventWaitlist>[0];

      try {
        return await joinEventWaitlist(deps, {
          ...input,
          viewerHumanId: ctx.actorHumanId ?? undefined,
          requestIp: ctx.clientIp,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  createEventForOrg: authedProcedure
    .input(saveEventForOrgInput)
    .output(saveEventWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.enableCreateEvents === false) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Event creation is currently disabled",
        });
      }

      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        taxRateLookup: ctx.taxRateLookup ?? null,
        // Freeform-address events derive their zone from the typed address's
        // coordinates and cache it on the SavedLocation (venue-hierarchy
        // FR-004) — the placeless mirror of `Place.timezone`.
        timezoneLookup: ctx.timezoneLookup ?? null,
        // Reports the deliberate swallow when that lookup throws.
        reportError: ctx.reportError ?? undefined,
        // W1 manager stamp + N2 own-withheld-place guard.
        authz: ctx.authz,
        // Fail-closed search scrub when an edit withholds the location.
        search: ctx.multiSearch ?? undefined,
      } satisfies Parameters<typeof saveEventForOrg>[0];

      // FR-018: a PUBLISHED event moved onto a held date owes notifications;
      // dispatched post-commit, never on the wire.
      const notifyHoldIntents = makeEventHoldIntentsNotifier(ctx);
      // Event-first (venue-confirmation spec): a third-party save at a place
      // + calendar created the booking request in-tx; its claim invite /
      // venue notice is dispatched here, post-commit, stripped from the wire.
      const notifyBookingRequestIntents = makeBookingRequestIntentsNotifier(ctx);
      let result;
      try {
        result = await saveEventForOrg(
          deps,
          buildOrgUseCaseInput(input, actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyHoldIntents({ output: result, actorHumanId });
      await notifyBookingRequestIntents({
        output: {
          notificationIntents: result.bookingRequestNotificationIntents ?? [],
        },
        context: { eventId: result.eventId, orgId: input.orgId },
      });
      return saveEventWireOutputSchema.parse(result);
    }),
  createEventForHuman: authedProcedure
    .input(createHumanEventInput)
    .output(saveEventWireOutputSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.enableCreateEvents === false) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Event creation is currently disabled",
        });
      }

      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        taxRateLookup: ctx.taxRateLookup ?? null,
        // Same freeform-address timezone derivation as the org path.
        timezoneLookup: ctx.timezoneLookup ?? null,
        reportError: ctx.reportError ?? undefined,
        // W1 manager stamp + N2 own-withheld-place guard.
        authz: ctx.authz,
        // Fail-closed search scrub when an edit withholds the location.
        search: ctx.multiSearch ?? undefined,
      } satisfies Parameters<typeof saveEventForHuman>[0];

      const notifyHoldIntents = makeEventHoldIntentsNotifier(ctx);
      const notifyBookingRequestIntents = makeBookingRequestIntentsNotifier(ctx);
      let result;
      try {
        result = await saveEventForHuman(
          deps,
          buildHumanUseCaseInput(input, actorHumanId),
        );
      } catch (err) {
        throw toTrpcError(err);
      }
      await notifyHoldIntents({ output: result, actorHumanId });
      await notifyBookingRequestIntents({
        output: {
          notificationIntents: result.bookingRequestNotificationIntents ?? [],
        },
        context: { eventId: result.eventId, humanId: actorHumanId },
      });
      return saveEventWireOutputSchema.parse(result);
    }),
  regenerateEventSlug: authedProcedure
    .input(regenerateEventSlugInput)
    .output(regenerateEventSlugOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof regenerateEventSlug>[0];

      try {
        return await regenerateEventSlug(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  featureEvent: authedProcedure
    .input(featureEventInput)
    .output(featureEventOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        authz: ctx.authz,
      } satisfies Parameters<typeof featureEvent>[0];

      try {
        return await featureEvent(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  setEventListingPriority: authedProcedure
    .input(setEventListingPriorityInput)
    .output(setEventListingPriorityOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof setEventListingPriority>[0];

      try {
        return await setEventListingPriority(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  listEventApplicationSubmissions: authedProcedure
    .input(listEventApplicationSubmissionsInput)
    .output(listEventApplicationSubmissionsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof listEventApplicationSubmissions>[0];

      try {
        return await listEventApplicationSubmissions(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  reviewEventApplicationSubmission: authedProcedure
    .input(reviewEventApplicationSubmissionInput)
    .output(reviewEventApplicationSubmissionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        // `notifyWithEmail` binds the mailer so the decision email legs
        // (approval + rejection) actually send inline — plain `notify`
        // (no mailer → email skips with port_unavailable) is the fallback.
        // Same composition as `createBookingInquiry` / `submitApplication`.
        notify: ctx.notifyWithEmail ?? ctx.notify,
        mailer: ctx.mailer ?? undefined,
        appBaseUrl: ctx.publicAppUrl ?? undefined,
        reportError: ctx.reportError ?? undefined,
        logger: ctx.logger,
      } satisfies Parameters<typeof reviewEventApplicationSubmission>[0];

      try {
        return await reviewEventApplicationSubmission(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
  rescindEventApplicationDecision: authedProcedure
    .input(rescindEventApplicationDecisionInput)
    .output(rescindEventApplicationDecisionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        // Rescinding an APPROVED decision sends the applicant the
        // "back in review" email — same composition as the review route
        // above so the signed-in (notify) and guest (mailer) legs send.
        notify: ctx.notifyWithEmail ?? ctx.notify,
        mailer: ctx.mailer ?? undefined,
        appBaseUrl: ctx.publicAppUrl ?? undefined,
        reportError: ctx.reportError ?? undefined,
        logger: ctx.logger,
      } satisfies Parameters<typeof rescindEventApplicationDecision>[0];

      try {
        return await rescindEventApplicationDecision(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Applicant withdraws their OWN pending application (spec Phase 2).
   * Authed-only: identity is the signed-in human — a PENDING submission
   * carries no approval token, so there is no anonymous credential to
   * authenticate a guest withdraw against.
   */
  withdrawApplication: authedProcedure
    .input(withdrawEventApplicationInput)
    .output(withdrawEventApplicationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Missing actor human id",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof withdrawEventApplication>[0];

      try {
        return await withdrawEventApplication(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Image Upload
  // ─────────────────────────────────────────────────────────────────────────────

  requestImageUpload: authedProcedure
    .input(requestEventImageUploadInput)
    // One per-actor bucket with the entity-page upload requests
    // (entity-pages.ts `imageRequestRateLimit`): each writes an outbox row.
    .use(
      rateLimit({
        key: (ctx) => `images:request:${ctx.actorHumanId}`,
        maxRequests: 20,
        windowSeconds: 60,
        message: "requesting image uploads",
      }),
    )
    .output(requestEventImageUploadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        fileStorage: ctx.fileStorage,
        logger: ctx.logger,
      } satisfies Parameters<typeof requestEventImageUpload>[0];

      try {
        return await requestEventImageUpload(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  finalizeImageUpload: authedProcedure
    .input(finalizeEventImageUploadInput)
    // Per actor. Each finalize may read, strip and rewrite an upload of up to
    // 25 MB; the use case bounds the memory with process-wide strip slots and
    // collapses repeats for one image, and this caps how much queueing one
    // account can cause. 20/min leaves room for dropping a handful of body
    // images into the editor at once.
    .use(
      rateLimit({
        key: (ctx) => `images:finalize:${ctx.actorHumanId}`,
        maxRequests: 20,
        windowSeconds: 60,
        message: "finalizing image uploads",
      }),
    )
    .output(finalizeEventImageUploadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        fileStorage: ctx.fileStorage,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof finalizeEventImageUpload>[0];

      try {
        return await finalizeEventImageUpload(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  resolveImages: publicProcedure
    .input(resolveEventImagesInput)
    .output(resolveEventImagesOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof resolveEventImages>[0];

      try {
        return await resolveEventImages(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Audio Upload
  // ─────────────────────────────────────────────────────────────────────────────

  requestAudioUpload: authedProcedure
    .input(requestEventAudioUploadInput)
    .output(requestEventAudioUploadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        fileStorage: ctx.fileStorage,
        logger: ctx.logger,
        warmTranscoder: () => warmTranscoder({ logger: ctx.logger }),
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof requestEventAudioUpload>[0];

      try {
        return await requestEventAudioUpload(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  finalizeAudioUpload: authedProcedure
    .input(finalizeEventAudioUploadInput)
    .output(finalizeEventAudioUploadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const enqueueTranscodeJob: EnqueueTranscodeJob = async (payload) => {
        await dispatchTranscodeJob(
          {
            audioUploadId: payload.audioUploadId,
            sourceKey: payload.sourceKey,
            outputPrefix: payload.outputPrefix,
            eventId: payload.eventId,
            deleteSourceOnSuccess: payload.deleteSourceOnSuccess,
          },
          {
            logger: ctx.logger,
            markTranscoding: (i) => ctx.repos.audioUploads.markTranscoding(i),
            markFailed: (i) => ctx.repos.audioUploads.markFailed(i),
          },
        );
      };

      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        fileStorage: ctx.fileStorage,
        logger: ctx.logger,
        enqueueTranscodeJob,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof finalizeEventAudioUpload>[0];

      try {
        return await finalizeEventAudioUpload(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // `optionalProcedure`, not `publicProcedure`: unpublished events require
  // edit permission, so the use case needs to know who is asking. Anonymous
  // callers still reach it (published events stay publicly readable).
  resolveAudio: optionalProcedure
    .input(resolveEventAudioInput)
    .output(resolveEventAudioOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        // Source-audio URLs are presigned and short-lived, so they are minted
        // here on every read rather than read from the row.
        fileStorage: ctx.fileStorage,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof resolveEventAudio>[0];

      try {
        // The SAME gate every other public event read applies (see
        // event-read-access.ts). A PUBLISHED event can still be password- or
        // application-gated, and its audio is gated content — the raw master,
        // no less. This MUST live at the transport, not in the use case: only
        // here can we see the anonymous `th_eu_<eventId>` unlock cookie that
        // lets a visitor who entered the password through.
        //
        // The use case's own status/canEditEvent check stays as defence in
        // depth; the two are complementary (this one covers gates + anonymous
        // unlocks, that one covers unpublished events).
        await ensureFullEventReadAccessByEventId(ctx, input.eventId);
        return await resolveEventAudio(deps, {
          ...input,
          viewerHumanId: ctx.actorHumanId ?? null,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Gate (password / application access checks)
  // ─────────────────────────────────────────────────────────────────────────────

  /** Returns gate state for an event – whether password/application is required, etc. */
  getGateState: optionalProcedure
    .input(getEventGateStateInput)
    .output(getEventGateStateOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
        authz: ctx.authz,
      } satisfies Parameters<typeof getEventGateState>[0];

      try {
        return await getEventGateState(deps, {
          ...input,
          viewerHumanId: ctx.actorHumanId ?? null,
          // Reaches here only when the web forwards the viewer's cookies (the
          // identity SSR client, uncacheable routes). Core decides whether
          // the grant still holds.
          applicationGrant: readEventApplicationGrantCookie(
            ctx,
            input.eventId,
          ),
          inviteGrant: readEventInviteGrantCookie(ctx, input.eventId),
          // The gated page shows this answer, so it may say why a removed
          // guest is locked out. Access checks never ask.
          explainRemoval: true,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Validates password for a password-gated event. Throws if invalid. */
  // `.input(schema)` runs BEFORE any middleware declared after it, but
  // middlewares declared *before* `.input()` see raw/unparsed input — so
  // referencing `input.eventId` in the rate-limit key would crash with
  // `Cannot read properties of undefined`. Parse first, then rate-limit.
  validatePassword: optionalProcedure
    .input(validateEventPasswordInput)
    // Per-(IP, event): tight, catches the obvious brute-force loop on
    // a single event.
    .use(
      rateLimit({
        key: (ctx, input: { eventId: string }) =>
          `event:validatePassword:${input.eventId}:${eventPasswordRateLimitActorKey(ctx)}:${eventPasswordRateLimitIpKey(ctx)}`,
        maxRequests: 5,
        windowSeconds: 60,
        message: "validating event passwords",
      }),
    )
    // Per-IP across all events: catches the "rotate eventId to dodge the
    // per-event cap" pattern. Looser cap so a legitimate user trying
    // multiple gated events in a session isn't punished.
    .use(
      rateLimit({
        key: (ctx) =>
          `event:validatePassword:${eventPasswordRateLimitIpKey(ctx)}`,
        maxRequests: 20,
        windowSeconds: 60,
        message: "validating event passwords",
      }),
    )
    .output(validateEventPasswordOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        // Wrong-password counters behind the Turnstile challenge gate.
        attemptCounter: ctx.rateLimit,
        turnstile: ctx.turnstile ?? null,
        reportError: ctx.reportError ?? undefined,
        authz: ctx.authz,
      } satisfies Parameters<typeof validateEventPassword>[0];

      try {
        return await validateEventPassword(deps, {
          ...input,
          viewerHumanId: ctx.actorHumanId ?? null,
          requestIp: ctx.clientIp,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Persists a web-verified password unlock cookie for a signed-in viewer. */
  recordSignedPasswordUnlock: authedProcedure
    .input(recordSignedPasswordUnlockInput)
    .output(recordVerifiedEventPasswordUnlockOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      if (!verifyEventUnlockCookie(ctx, input.eventId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "event_password_required",
        });
      }

      try {
        return await recordVerifiedEventPasswordUnlock(
          { repos: ctx.repos, logger: ctx.logger },
          { eventId: input.eventId, humanId: actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Persists a web-verified APPLICATION grant for a signed-in buyer — the
   * application twin of `recordSignedPasswordUnlock`, called by the web
   * `sync-unlock` route before checkout (the buyer's own API calls cannot
   * carry the web-host cookie). Core persists only for the submission's
   * subject and only while it is APPROVED; anything else returns
   * `persisted: false`, and checkout's gate then refuses cleanly.
   * Same limiter posture as its sibling: authed, plus the default rate-limit
   * floor every procedure gets (`defaultRateLimit`, init.ts). No new limits.
   */
  recordSignedApplicationUnlock: authedProcedure
    .input(recordSignedApplicationUnlockInput)
    .output(recordApplicationGrantUnlockOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      const grant = readEventApplicationGrantCookie(ctx, input.eventId);
      if (!grant) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "event_application_required",
        });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        // Guest→account attach is a deliberate swallow (ReporterPort).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof recordApplicationGrantUnlock>[0];

      try {
        return await recordApplicationGrantUnlock(deps, {
          eventId: input.eventId,
          submissionId: grant.submissionId,
          approvedAtMs: grant.approvedAtMs,
          humanId: actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Persists a web-verified INVITE grant (`th_ei_<eventId>`) for a signed-in
   * viewer: the invite twin of `recordSignedApplicationUnlock`, called by the
   * web `sync-unlock` route beside it (gated-event invite links R3). Core
   * applies the cookie's rule and the signed-in redeem path; a grant that no
   * longer holds returns `persisted: false`, and checkout then refuses.
   * No grant cookie at all → FORBIDDEN, as the application twin does.
   */
  recordSignedInviteUnlock: authedProcedure
    .input(recordSignedInviteUnlockInput)
    .output(recordInviteGrantUnlockOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      const inviteGrant = readEventInviteGrantCookie(ctx, input.eventId);
      if (!inviteGrant) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "event_invite_grant_required",
        });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof recordInviteGrantUnlock>[0];

      try {
        return await recordInviteGrantUnlock(deps, {
          eventId: input.eventId,
          viewerHumanId: actorHumanId,
          inviteGrant,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Returns minimal preview data (name + hero image + the date, never the
   * place) for gated events. Identity-free: it feeds an edge-cached document.
   */
  getGatedPreview: publicProcedure
    .input(getEventGatedPreviewInput)
    .output(getEventGatedPreviewOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // The recurring listing's next-date read degrades to null; keep the
        // swallow visible in Sentry (ReporterPort convention).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof getEventGatedPreview>[0];

      try {
        return await getEventGatedPreview(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * PUBLIC read of an application form's DEFINITION for a PUBLISHED,
   * APPLICATION-gated event (spec Phase 3 item 1 / D5).
   *
   * Deliberately a NEW, NARROW procedure rather than widening
   * `getApplicationForm`: that one is the BUILDER's read and carries
   * organizer-only fields (`defaults`, `maxSubmissions`, `autoApprove`,
   * `updatedAt`). Widening it to `publicProcedure` would publish all of them
   * and leave no seam to add organizer-only fields later without re-auditing
   * every consumer. Two procedures, two audiences, one field list each.
   *
   * Rate-limited on the same (IP, event) + per-IP shape as the other
   * anonymous-reachable event endpoints (`validatePassword`,
   * `submitApplication`, `redeemApplicationToken`), with a read-sized budget:
   * a legitimate gate render fires this once, an enumeration sweep fires it
   * in a loop. Keys are IP-only — an authed viewer reading a public form has
   * no more claim on the budget than a guest.
   */
  getPublicApplicationForm: publicProcedure
    // Parse first, then rate-limit: middlewares declared BEFORE `.input()`
    // see raw input (see the ordering note on `validatePassword`).
    .input(getPublicEventApplicationFormInput)
    .use(
      rateLimit({
        key: (ctx, input: { eventId: string }) =>
          `event:getPublicApplicationForm:${input.eventId}:${eventPasswordRateLimitIpKey(ctx)}`,
        maxRequests: 30,
        windowSeconds: 60,
        message: "loading application forms",
      }),
    )
    // Per-IP across all events: catches "rotate eventId to sweep the corpus".
    .use(
      rateLimit({
        key: (ctx) =>
          `event:getPublicApplicationForm:${eventPasswordRateLimitIpKey(ctx)}`,
        maxRequests: 60,
        windowSeconds: 60,
        message: "loading application forms",
      }),
    )
    .output(getPublicEventApplicationFormOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof getPublicEventApplicationForm>[0];

      try {
        return await getPublicEventApplicationForm(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Submit an application for an application-gated event.
   *
   * Abuse guardrails (spec Phase 1 item 4):
   * - Rate-limited with the same budget/mechanism as `redeemApplicationToken`
   *   below: per-(IP, event) 10/60s + per-IP-across-events 30/60s. Parse
   *   first, then rate-limit — middlewares declared before `.input()` see
   *   raw input (see the ordering note on `validatePassword`).
   * - Turnstile is enforced INSIDE the use case, and only for
   *   unauthenticated submitters (inert prep for the anonymous phase —
   *   authed applicants skip it entirely).
   *
   * The post-commit notification fan-out (applicant ack + organizer notify,
   * spec Phase 1 item 2) is composed here exactly as `createBookingInquiry`
   * does (deps assembly only — no business logic): `notifyWithEmail` binds
   * the mailer so the email leg actually sends inline; plain `notify` (no
   * mailer → email skips) is the fallback. The use case swallows notifier
   * failures and reports them via `reportError`.
   */
  submitApplication: optionalProcedure
    .input(submitEventApplicationInput)
    // Per-event tight limiter, keyed on (actor, IP) like validatePassword:
    // authed submitters get per-ACTOR buckets (a venue's shared NAT wifi
    // must not throttle the 11th signed-in applicant in a minute), while
    // anonymous submitters collapse to "anonymous:<ip>" — effectively
    // per-IP, which is the right bot budget.
    .use(
      rateLimit({
        key: (ctx, input: { eventId: string }) =>
          `event:submitApplication:${input.eventId}:${eventPasswordRateLimitActorKey(ctx)}:${eventPasswordRateLimitIpKey(ctx)}`,
        maxRequests: 10,
        windowSeconds: 60,
        message: "submitting applications",
      }),
    )
    // Per-IP across all events: catches "rotate eventId to dodge the cap".
    .use(
      rateLimit({
        key: (ctx) =>
          `event:submitApplication:${eventPasswordRateLimitIpKey(ctx)}`,
        maxRequests: 30,
        windowSeconds: 60,
        message: "submitting applications",
      }),
    )
    .output(submitEventApplicationOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        turnstile: ctx.turnstile,
        notifyApplicationReceived: (args: NotifyEventApplicationReceivedArgs) =>
          notifyEventApplicationReceived(
            {
              repos: ctx.repos,
              notify: ctx.notifyWithEmail ?? ctx.notify,
              mailer: ctx.mailer ?? undefined,
              logger: ctx.logger,
              reportError: ctx.reportError ?? undefined,
              publicAppUrl: ctx.publicAppUrl ?? null,
            },
            args,
          ),
        // Auto-approve (form.autoApprove) sends the APPROVAL email through
        // the same pipeline reviewApplicationSubmission uses — notify with
        // the mailer bound so the email leg actually sends inline, direct
        // mailer for anonymous claim links, base URL for the claim link.
        notify: ctx.notifyWithEmail ?? ctx.notify,
        mailer: ctx.mailer ?? undefined,
        appBaseUrl: ctx.publicAppUrl ?? undefined,
        reportError: ctx.reportError ?? undefined,
        logger: ctx.logger,
      } satisfies Parameters<typeof submitEventApplication>[0];

      try {
        return await submitEventApplication(deps, {
          ...input,
          viewerHumanId: ctx.actorHumanId ?? null,
          requestIp: ctx.clientIp,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Redeems an application approval token (from the organizer's approval
   * email) to unlock an APPLICATION-gated event. Anonymous-allowed: a
   * signed-in clicker gets a persisted humanId unlock; a guest relies on the
   * signed cookie the web claim route sets. Non-consuming.
   */
  redeemApplicationToken: optionalProcedure
    .input(redeemApplicationApprovalTokenInput)
    // Per-(IP, event): tight, catches a brute-force loop on one event.
    .use(
      rateLimit({
        key: (ctx, input: { eventId: string }) =>
          `event:redeemApplicationToken:${input.eventId}:${eventPasswordRateLimitIpKey(ctx)}`,
        maxRequests: 10,
        windowSeconds: 60,
        message: "redeeming application links",
      }),
    )
    // Per-IP across all events: catches "rotate eventId to dodge the cap".
    .use(
      rateLimit({
        key: (ctx) =>
          `event:redeemApplicationToken:${eventPasswordRateLimitIpKey(ctx)}`,
        maxRequests: 30,
        windowSeconds: 60,
        message: "redeeming application links",
      }),
    )
    .output(redeemApplicationApprovalTokenOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // Best-effort guest→account attach swallows its failures; keep the
        // branch visible in Sentry (ReporterPort convention).
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof redeemApplicationApprovalToken>[0];

      try {
        return await redeemApplicationApprovalToken(deps, {
          ...input,
          viewerHumanId: ctx.actorHumanId ?? null,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ─────────────────────────────────────────────────────────────────────────────
  // Gated-event invite links (docs/specs/2026-10-02/completed/gated-event-invite-links.spec.yaml)
  // Organizer procedures: the use cases run `ensureActorCanEditEvent` (and,
  // for sends, the verified-email check), so the transport only injects the
  // session actor. Link builders need the derived token key + web origin.
  // ─────────────────────────────────────────────────────────────────────────────

  /** Turn the SHARED invite link on, reset it, or turn it off (FR-001, R5). */
  setSharedInvite: authedProcedure
    .input(setSharedInviteInput)
    .output(setEventSharedInviteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // RESET_AND_REMOVE's per-approval rescind failures are swallowed and
        // reported.
        reportError: ctx.reportError ?? undefined,
        inviteTokenSecret: ctx.inviteTokenSecret ?? "",
        appBaseUrl: ctx.publicAppUrl ?? null,
      } satisfies Parameters<typeof setEventSharedInvite>[0];

      try {
        return await setEventSharedInvite(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Create PERSONAL invites for hand-added guests or a contact list and email
   * each its link (FR-002, FR-003, R13). Per-actor + event cap on top of the
   * use case's 500-recipient cap: each call can send mail.
   */
  createGuestInvites: authedProcedure
    .input(createGuestInvitesInput)
    .use(
      rateLimit({
        key: (ctx, input: { eventId: string }) =>
          `event:createGuestInvites:${ctx.actorHumanId ?? "anon"}:${input.eventId}`,
        maxRequests: 30,
        windowSeconds: 300,
        message: "sending event invites",
      }),
    )
    // Per ACTOR across every event (review W1): an editor of many events
    // otherwise gets a fresh bucket per event. Modelled on the lineup
    // invite's actor cap (20/hour). These two count CALLS; the use case
    // counts RECIPIENTS (50 or 1,000 per rolling 24h, per actor AND per
    // event owner: invites/invite-allowance.ts), which is the real bound.
    .use(
      rateLimit({
        key: (ctx) => `event:createGuestInvites:actor:${ctx.actorHumanId ?? "anon"}`,
        maxRequests: 20,
        windowSeconds: 3600,
        message: "sending event invites",
      }),
    )
    .output(createEventGuestInvitesOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        mailer: ctx.mailer ?? undefined,
        logger: ctx.logger,
        // Mail failures are swallowed per recipient (invite stays, unsent).
        reportError: ctx.reportError ?? undefined,
        inviteTokenSecret: ctx.inviteTokenSecret ?? "",
        inviteOptOutSecret: ctx.inviteOptOutSecret ?? null,
        appBaseUrl: ctx.publicAppUrl ?? null,
        // The rolling 24h RECIPIENT allowance (actor + event owner); the two
        // call-count limits above stay as they are.
        rateLimit: ctx.rateLimit,
      } satisfies Parameters<typeof createEventGuestInvites>[0];

      try {
        return await createEventGuestInvites(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** The Resend action on one guest row (FR-002). */
  resendGuestInvite: authedProcedure
    .input(resendGuestInviteInput)
    .use(
      rateLimit({
        key: (ctx, input: { eventId: string }) =>
          `event:resendGuestInvite:${ctx.actorHumanId ?? "anon"}:${input.eventId}`,
        maxRequests: 20,
        windowSeconds: 300,
        message: "resending event invites",
      }),
    )
    // Per ACTOR across every event (review W1). One mail per call, so a
    // looser cap than createGuestInvites: 60/hour.
    .use(
      rateLimit({
        key: (ctx) => `event:resendGuestInvite:actor:${ctx.actorHumanId ?? "anon"}`,
        maxRequests: 60,
        windowSeconds: 3600,
        message: "resending event invites",
      }),
    )
    .output(resendEventGuestInviteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        mailer: ctx.mailer ?? undefined,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
        inviteTokenSecret: ctx.inviteTokenSecret ?? "",
        inviteOptOutSecret: ctx.inviteOptOutSecret ?? null,
        appBaseUrl: ctx.publicAppUrl ?? null,
        // Each resend counts against the recipient allowance too.
        rateLimit: ctx.rateLimit,
      } satisfies Parameters<typeof resendEventGuestInvite>[0];

      try {
        return await resendEventGuestInvite(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Revoke a PERSONAL invite and remove everyone it let in (FR-006, R9). */
  revokeGuestInvite: authedProcedure
    .input(revokeGuestInviteInput)
    .output(revokeEventGuestInviteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // Per-submission rescind failures are swallowed and reported.
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof revokeEventGuestInvite>[0];

      try {
        return await revokeEventGuestInvite(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /** Organizer view: the live SHARED link and the guest list. */
  listInvites: authedProcedure
    .input(listInvitesInput)
    .output(listEventInvitesOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        inviteTokenSecret: ctx.inviteTokenSecret ?? "",
        appBaseUrl: ctx.publicAppUrl ?? null,
      } satisfies Parameters<typeof listEventInvites>[0];

      try {
        return await listEventInvites(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Redeem an invite link (FR-004, FR-005, FR-010). Anonymous-allowed: the
   * token is the credential. Called server-to-server by the web redeem route
   * (`POST /api/events/[eventId]/invite`), which sets the cookie this output
   * names. A dead link is `{ ok: false, reason }`, never a throw.
   *
   * Rate limited per IP like `validatePassword` (NFR-003); the input has no
   * event id, so there is no per-event bucket. A guessed token is infeasible
   * regardless (256-bit MAC, NFR-001).
   */
  redeemInvite: optionalProcedure
    .input(redeemInviteInput)
    .use(
      rateLimit({
        key: (ctx) => `event:redeemInvite:${eventPasswordRateLimitIpKey(ctx)}`,
        maxRequests: 20,
        windowSeconds: 60,
        message: "redeeming invite links",
      }),
    )
    .output(redeemInviteOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        inviteTokenSecret: ctx.inviteTokenSecret ?? "",
      } satisfies Parameters<typeof redeemEventInvite>[0];

      // A re-redeem by a browser that already holds this invite's verified
      // grant is a no-op in core (no second count). Structural parse only;
      // core verifies the token's MAC.
      const tokenInviteId = parseInviteToken(input.token)?.inviteId ?? null;
      const currentInviteGrantId = tokenInviteId
        ? findHeldEventInviteGrantId(ctx, tokenInviteId)
        : null;

      try {
        const result = await redeemEventInvite(deps, {
          token: input.token,
          viewerHumanId: ctx.actorHumanId ?? null,
          currentInviteGrantId,
          ...(input.expectedEventId
            ? { expectedEventId: input.expectedEventId }
            : {}),
        });
        if (!result.ok) {
          return {
            ok: false as const,
            reason: result.reason,
            eventId: result.eventId,
            slug: result.slug,
          };
        }
        return {
          ok: true as const,
          eventId: result.eventId,
          slug: result.slug,
          grant: result.grant,
          inviteId: result.inviteId,
          submissionId: result.submissionId,
          approvedAtMs: result.approvedAtMs,
          expiresAtMs: result.expiresAt.getTime(),
          created: result.created,
        };
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * READ-ONLY look at an invite link for the guest landing, before they tap
   * "Open the event" (FR-010): who it is for, from whom, or why it is dead.
   * Same verdict as `redeemInvite`, no writes, no count. Identity-free: the
   * session is not read. Fires on every `?invite=` landing, so its own,
   * looser per-IP bucket. Never echoes the token or the invitee's email.
   */
  peekInvite: optionalProcedure
    .input(peekEventInviteInputSchema)
    .use(
      rateLimit({
        key: (ctx) => `event:peekInvite:${eventPasswordRateLimitIpKey(ctx)}`,
        maxRequests: 60,
        windowSeconds: 60,
        message: "checking invite links",
      }),
    )
    .output(peekEventInviteOutputSchema)
    // A MUTATION although it writes nothing: a tRPC query carries its input
    // in the URL, which would put the token in access logs and caches.
    .mutation(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        inviteTokenSecret: ctx.inviteTokenSecret ?? "",
      } satisfies Parameters<typeof peekEventInvite>[0];

      try {
        return await peekEventInvite(deps, {
          token: input.token,
          ...(input.expectedEventId
            ? { expectedEventId: input.expectedEventId }
            : {}),
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * READ-ONLY look at a "Stop invites from this organiser" link, for the
   * confirmation page: the organiser's name, or INVALID. A mutation although
   * it writes nothing: the token must not ride in a URL to access logs.
   * Never echoes the address. Only INVALID outcomes are rate-limited per IP
   * (fix round 1); a valid token is never throttled beyond the default
   * floor. Forgery is prevented by the token's HMAC, not by the limit: the
   * limit only caps how much work a stream of bad tokens can cost.
   */
  peekInviteOptOut: optionalProcedure
    .input(inviteOptOutInputSchema)
    .output(inviteOptOutOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        inviteOptOutSecret: ctx.inviteOptOutSecret ?? "",
      } satisfies Parameters<typeof peekInviteOptOut>[0];
      let out: Awaited<ReturnType<typeof peekInviteOptOut>>;
      try {
        out = await peekInviteOptOut(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
      if (!out.ok) {
        await chargeFailedAttempt(ctx, {
          key: inviteOptOutInvalidKey(ctx),
          maxRequests: INVITE_OPT_OUT_INVALID_PER_MINUTE,
          windowSeconds: 60,
          message: "checking invite opt-out links",
        });
      }
      return out;
    }),

  /**
   * Record "Stop invites from this organiser" (idempotent). Called by the
   * confirmation page's button and, server-to-server, by the web's RFC 8058
   * one-click route (`POST /api/invites/stop`), which mail providers hit
   * from their own servers: one provider IP carries many recipients'
   * opt-outs. So a VALID token is never throttled per IP beyond the default
   * floor (an opt-out must not be dropped). Only INVALID outcomes are
   * rate-limited per IP. Forgery is prevented by the token's HMAC, not by the
   * limit.
   */
  stopOrganiserInvites: optionalProcedure
    .input(inviteOptOutInputSchema)
    .output(inviteOptOutOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        inviteOptOutSecret: ctx.inviteOptOutSecret ?? "",
      } satisfies Parameters<typeof optOutOfOrganiserInvites>[0];
      let out: Awaited<ReturnType<typeof optOutOfOrganiserInvites>>;
      try {
        out = await optOutOfOrganiserInvites(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
      if (!out.ok) {
        await chargeFailedAttempt(ctx, {
          key: inviteOptOutInvalidKey(ctx),
          maxRequests: INVITE_OPT_OUT_INVALID_PER_MINUTE,
          windowSeconds: 60,
          message: "stopping invites",
        });
      }
      return out;
    }),

  /**
   * Record "Stop all event invites" (owner ruling 3(b), 2026-10-06; the
   * stop page's second, smaller choice; idempotent; no account). Same token
   * and posture as `stopOrganiserInvites`: public, a valid token is never
   * throttled beyond the default floor, and only INVALID outcomes are
   * charged per IP. The RFC 8058 one-click route does NOT call this: a mail
   * client's Unsubscribe button means "this sender", so it stays
   * organiser-scoped.
   */
  stopAllInvites: optionalProcedure
    .input(inviteOptOutInputSchema)
    .output(inviteOptOutOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
        inviteOptOutSecret: ctx.inviteOptOutSecret ?? "",
      } satisfies Parameters<typeof optOutOfAllInvites>[0];
      let out: Awaited<ReturnType<typeof optOutOfAllInvites>>;
      try {
        out = await optOutOfAllInvites(deps, input);
      } catch (err) {
        throw toTrpcError(err);
      }
      if (!out.ok) {
        await chargeFailedAttempt(ctx, {
          key: inviteOptOutInvalidKey(ctx),
          maxRequests: INVITE_OPT_OUT_INVALID_PER_MINUTE,
          windowSeconds: 60,
          message: "stopping invites",
        });
      }
      return out;
    }),

  /**
   * Get the viewer's own application status for an event (if any), including
   * the organizer's decline note on a REJECTED submission. Session-keyed —
   * see `getViewerApplicationStatus` for why there is no guest equivalent.
   */
  getViewerApplicationStatus: optionalProcedure
    .input(z.object({ eventId: z.string().uuid() }))
    .output(getViewerApplicationStatusOutputSchema)
    .query(async ({ ctx, input }) => {
      const deps = {
        repos: ctx.repos,
      } satisfies Parameters<typeof getViewerApplicationStatus>[0];

      try {
        return await getViewerApplicationStatus(deps, {
          eventId: input.eventId,
          viewerHumanId: ctx.actorHumanId ?? null,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Access Controls & Application Forms
  // ─────────────────────────────────────────────────────────────────────────────

  updateAccessControls: authedProcedure
    .input(updateEventAccessControlsInput)
    .output(updateEventAccessControlsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        // Fail-closed search scrub when a gate is added or visibility leaves PUBLIC.
        search: ctx.multiSearch ?? undefined,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof updateEventAccessControls>[0];

      try {
        return await updateEventAccessControls(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateSettings: authedProcedure
    .input(updateEventSettingsInput)
    .output(updateEventSettingsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        taxRateLookup: ctx.taxRateLookup ?? null,
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof updateEventSettings>[0];

      try {
        return await updateEventSettings(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  /**
   * Enter the event's sales-tax rate by hand when the tax provider cannot
   * answer at the door (owner ruling R5, spec 2026-10-07 FR-007). Owner,
   * Admin or Editor of the event's org; `rateBps` in basis points (9.25% =
   * 925), 0–2500. Allowed only while the tax lookup is failing (one live
   * attempt first). Charged everywhere the event is sold until a successful
   * lookup replaces it; reported to the platform on entry.
   */
  setManualTaxRate: authedProcedure
    .input(setManualEventTaxRateInputSchema.omit({ actorHumanId: true }))
    .output(setManualEventTaxRateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
        reportError: ctx.reportError ?? undefined,
        taxRateLookup: ctx.taxRateLookup ?? null,
      } satisfies Parameters<typeof setManualEventTaxRate>[0];

      try {
        return await setManualEventTaxRate(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getApplicationForm: authedProcedure
    .input(z.object({ eventId: z.string().uuid() }))
    .output(
      z.object({
        form: z
          .object({
            id: z.string().uuid(),
            eventId: z.string().uuid(),
            introText: z.string().nullable(),
            defaults: z.object({
              includeName: z.boolean(),
              includeReason: z.boolean(),
              includeSocialLinks: z.boolean(),
            }),
            /** Application window start (spec Phase 2). Null = open now. */
            opensAt: z.date().nullable(),
            /** Application window end. Null = never closes. */
            closesAt: z.date().nullable(),
            /** Submission cap. Null = uncapped. */
            maxSubmissions: z.number().int().nullable(),
            /** Instant-approval ("registration with questions") mode. */
            autoApprove: z.boolean(),
            updatedAt: z.date(),
          })
          .nullable(),
        questions: z.array(
          z.object({
            id: z.string().uuid(),
            formId: z.string().uuid(),
            type: z.enum([
              "SHORT_TEXT",
              "LONG_TEXT",
              "MULTI_CHOICE",
              "SINGLE_CHOICE",
            ]),
            label: z.string(),
            description: z.string().nullable(),
            options: z.any().nullable(),
            isRequired: z.boolean(),
            order: z.number().int(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        logger: ctx.logger,
      } satisfies Parameters<typeof getEventApplicationForm>[0];

      try {
        return await getEventApplicationForm(deps, {
          eventId: input.eventId,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  upsertApplicationForm: authedProcedure
    .input(upsertEventApplicationFormInput)
    .output(upsertEventApplicationFormOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof upsertEventApplicationForm>[0];

      try {
        return await upsertEventApplicationForm(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  upsertApplicationQuestion: authedProcedure
    .input(upsertEventApplicationQuestionInput)
    .output(upsertEventApplicationQuestionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof upsertEventApplicationQuestion>[0];

      try {
        return await upsertEventApplicationQuestion(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  deleteApplicationQuestion: authedProcedure
    .input(deleteEventApplicationQuestionInput)
    .output(deleteEventApplicationQuestionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }

      const deps = {
        repos: ctx.repos,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof deleteEventApplicationQuestion>[0];

      try {
        return await deleteEventApplicationQuestion(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  inviteLineupHumanToRegister: authedProcedure
    .input(inviteLineupHumanToRegisterInput)
    // Per actor: every call can mint a shadow account and mail an address
    // the actor typed. Mirrors `orgs:invite:actor` (20/hour).
    .use(
      rateLimit({
        key: (ctx) => `events:inviteLineup:actor:${ctx.actorHumanId}`,
        maxRequests: 20,
        windowSeconds: 3600,
        message: "sending lineup invites",
      }),
    )
    .output(inviteLineupHumanToRegisterOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }
      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
        // The payout invite email the builder's "Invite sent" toast promises,
        // plus the person's lineup notice.
        lineupNotices: makeLineupNoticeNotifier(ctx),
        reportError: ctx.reportError ?? undefined,
      } satisfies Parameters<typeof inviteLineupHumanToRegister>[0];
      try {
        return await inviteLineupHumanToRegister(deps, {
          ...input,
          actorHumanId,
        });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  getEventSplits: authedProcedure
    .input(getEventSplitsInput)
    .output(getEventSplitsOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }
      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        clock: ctx.clock,
        logger: ctx.logger,
      } satisfies Parameters<typeof getEventSplits>[0];
      try {
        return await getEventSplits(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),

  updateEventSplits: authedProcedure
    .input(updateEventSplitsInput)
    .output(updateEventSplitsOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Missing actor human id",
        });
      }
      const deps = {
        repos: ctx.repos,
        authz: ctx.authz,
        idempotency: ctx.idempotency,
        clock: ctx.clock,
        logger: ctx.logger,
        // A frozen change notifies every payee (freeze-the-deal FR-006).
        ...dealChangeNoticeDeps(ctx),
      } satisfies Parameters<typeof updateEventSplits>[0];
      try {
        return await updateEventSplits(deps, { ...input, actorHumanId });
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};

/**
 * One report per tag set per window from the quote path's tax lookups: quotes
 * fire per page view, so an outage would otherwise file one Sentry event per
 * view. Checkout's refusals report through the unthrottled reporter.
 */
const QUOTE_TAX_REPORT_THROTTLE_MS = 5 * 60_000;

/**
 * Memoized per process, the same way context.ts and guard.ts memoize their
 * throttled reporters: keyed on the long-lived objects the composition root
 * builds once (the reporter, the provider adapter), so the throttle window and
 * the negative cache survive across requests.
 */
const quoteTaxReporters = new WeakMap<
  NonNullable<Ctx["reportError"]>,
  NonNullable<Ctx["reportError"]>
>();
const quoteTaxCooldowns = new WeakMap<
  NonNullable<Ctx["taxRateLookup"]>,
  QuoteTaxLookupCooldown
>();

/**
 * The quote-time tax-rate lookup (`QuoteTaxRateLookupDeps`) for the public fee
 * quotes and the builder's fee preview: the provider, the root repos the venue
 * cache is filled on, the search port the venue's other events are re-indexed
 * with after a fill, a throttled reporter, and a per-venue negative cache
 * (a venue whose lookup just failed is not looked up again for 60s).
 */
function taxLookupFor(ctx: {
  repos: Ctx["repos"];
  taxRateLookup?: Ctx["taxRateLookup"];
  multiSearch?: Ctx["multiSearch"];
  reportError?: Ctx["reportError"];
}) {
  const provider = ctx.taxRateLookup ?? null;
  let cooldown: QuoteTaxLookupCooldown | undefined;
  if (provider) {
    cooldown = quoteTaxCooldowns.get(provider);
    if (!cooldown) {
      cooldown = createQuoteTaxLookupCooldown();
      quoteTaxCooldowns.set(provider, cooldown);
    }
  }
  let reportError: NonNullable<Ctx["reportError"]> | undefined;
  if (ctx.reportError) {
    reportError = quoteTaxReporters.get(ctx.reportError);
    if (!reportError) {
      reportError = createThrottledReporter(
        ctx.reportError,
        QUOTE_TAX_REPORT_THROTTLE_MS,
      );
      quoteTaxReporters.set(ctx.reportError, reportError);
    }
  }
  return {
    taxRateLookup: provider,
    repos: ctx.repos,
    ...(ctx.multiSearch ? { search: ctx.multiSearch } : {}),
    ...(reportError ? { reportError } : {}),
    ...(cooldown ? { cooldown } : {}),
  };
}

export const eventsRouter = {
  ...baseEventsRouter,

  getCalendarInfo: authedProcedure
    .input(z.object({ eventIds: z.array(z.string().uuid()).min(1).max(50) }))
    .output(getEventCalendarInfoOutputSchema)
    .query(async ({ ctx, input }) => {
      const actorHumanId = ctx.actorHumanId;
      if (!actorHumanId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      // Scoped to events the actor may read (F16) — see the use case.
      try {
        return await getEventCalendarInfo(
          { repos: ctx.repos, authz: ctx.authz },
          { eventIds: input.eventIds, actorHumanId },
        );
      } catch (err) {
        throw toTrpcError(err);
      }
    }),
};
