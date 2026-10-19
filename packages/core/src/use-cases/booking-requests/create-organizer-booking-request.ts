import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

import {
  BOOKING_SET_LENGTH_PRESETS,
  BOOKING_FEE_AMOUNT_MAX_CENTS,
  BOOKING_FEE_DEFAULT_CURRENCY,
  DAY_MS,
} from "./constants";
import { BOOKING_REQUEST_TTL_DAYS } from "./create-booking-request";
import { parseInput } from "../../lib/io";
import { isPerformerEnabled } from "../../lib/performer-mode";
import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";
import { ORG_EDIT_ROLES, requireOrgMembership } from "../../lib/rbac";
import { toPerformerOwnerType } from "../performers/set-performer-mode";
import { fail } from "@th/errors";
import {
  FEE_ASK_REFINE_PARAMS,
  hasConsistentFeeAsk,
} from "./_shared/pitch-schema";
import { appendBookingSystemEntry } from "./messages/_shared/system-entries";
import type { NotifyOrganizerBookingRequestReceivedFn } from "./notify-organizer-booking-request-received";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-refine base object (transport derives its wire input via
 * `.omit({ actorHumanId: true })` — `.omit()` can't be applied after the
 * cross-field `.refine()` below; the use case re-validates the full schema).
 *
 * Deliberately a SUBSET of the performer pitch: an organizer states what they
 * want (message, dates, optional offer / set length / event attach) — the
 * act-description fields (expectedDraw, genre, links, tech needs, …) belong
 * to the performer→venue direction only (FR-003).
 *
 * NO `calendarId` in this direction (venue-hierarchy FR-008): calendars
 * route VENUE inboxes; an organizer→act request has no venue anchor to route
 * within. `.strict()` rejects a smuggled calendarId at the boundary, the
 * repo's `createToPerformer` input has no such field, and the typed record
 * (`ToPerformerBookingRequestRecord.calendarId: null`) pins it at rest.
 */
export const createOrganizerBookingRequestBaseSchema = z
  .object({
    actorHumanId: z.uuid(),
    organizerOrgId: z.uuid(),
    performerOwnerType: z.enum(["human", "org"]),
    performerOwnerId: z.uuid(),
    // Sanitized multi-line free text (NFR-003) — sanitize BEFORE the length
    // floor, matching the shared pitch-schema posture.
    message: plainTextMultilineRequired(2000).pipe(z.string().min(10)),
    /** ISO `YYYY-MM-DD` date strings — 1–3 per FR-003. */
    preferredDates: z.array(z.iso.date()).min(1).max(3),
    setLengthMinutes: z
      .number()
      .int()
      .refine(
        (v) => (BOOKING_SET_LENGTH_PRESETS as readonly number[]).includes(v),
        { message: "set_length_not_a_preset" },
      )
      .optional(),
    feeType: z.enum(["GUARANTEE", "DOOR_SPLIT", "NEGOTIABLE"]).optional(),
    feeAmountCents: z
      .number()
      .int()
      .positive()
      .max(BOOKING_FEE_AMOUNT_MAX_CENTS)
      .optional(),
    /** Optional own-event attach — ownership verified below (FR-003). */
    attachedEventId: z.uuid().optional(),
  })
  .strict();

export const createOrganizerBookingRequestInputSchema =
  createOrganizerBookingRequestBaseSchema.refine(
    hasConsistentFeeAsk,
    FEE_ASK_REFINE_PARAMS,
  );

export const createOrganizerBookingRequestOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
  })
  .strict();

export type CreateOrganizerBookingRequestInput = z.infer<
  typeof createOrganizerBookingRequestInputSchema
>;
export type CreateOrganizerBookingRequestOutput = z.infer<
  typeof createOrganizerBookingRequestOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type CreateOrganizerBookingRequestDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "bookingRequests"
    | "performerProfiles"
    | "events"
    | "authz"
    | "audit"
    // Consumed inside the create tx to open the booking timeline.
    | "bookingRequestMessages"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /**
   * Optional post-commit act notification (FR-006), composed by the
   * transport layer. Runs AFTER the transaction committed; a throwing
   * notifier never fails the submission (deliberate swallow + reportError).
   */
  notifyOrganizerBookingRequestReceived?: NotifyOrganizerBookingRequestReceivedFn;
  /** Best-effort reporter for the notification swallow branch. */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An organizer ORG requests an act (organizer-booking-requests FR-003) — the
 * inverse of `createBookingRequest`. Checks, in order:
 *
 * 1. Sender control — actor holds ORG_EDIT_ROLES in the sender org.
 * 2. Target opt-in gate — the act must be performer-enabled AND accepting
 *    (`PerformerProfile.acceptsBookingRequests`); both failures surface as
 *    PERFORMER_NOT_ACCEPTING_REQUESTS (performer mode alone is not enough,
 *    and we don't leak WHICH gate failed).
 * 3. Attached event (optional) — must exist and be owned by the sender org.
 * 4. One open (PENDING | VIEWED) request per (organizer org, act) pair —
 *    pre-check here, SQL partial unique index as the race backstop.
 *
 * Expiry is stamped at `now + BOOKING_REQUEST_TTL_DAYS` (same 14-day TTL;
 * the existing daily expiry job covers both directions unchanged).
 */
export async function createOrganizerBookingRequest(
  deps: CreateOrganizerBookingRequestDeps,
  rawInput: unknown,
): Promise<CreateOrganizerBookingRequestOutput> {
  const input = parseInput(createOrganizerBookingRequestInputSchema, rawInput);

  const ownerType = toPerformerOwnerType(input.performerOwnerType);

  // 1. Sender control.
  await requireOrgMembership({
    repos: deps.repos,
    orgId: input.organizerOrgId,
    actorHumanId: input.actorHumanId,
    roles: ORG_EDIT_ROLES,
  });

  // 1b. Same-party guard: an org can't send a booking request to ITSELF as
  // the act — the mint on accept would produce a self-dealing Agreement
  // (proposer === counterparty). Booking your own band for your own show is
  // just event lineup, not a request.
  if (
    ownerType === "organization" &&
    input.performerOwnerId === input.organizerOrgId
  ) {
    throw fail("CANNOT_BOOK_OWN_ACT");
  }

  // 2. Target opt-in gate (consent-first: default-off).
  const profile = await deps.repos.performerProfiles.getByOwner({
    ownerType,
    ownerId: input.performerOwnerId,
  });
  if (!isPerformerEnabled(profile) || !profile?.acceptsBookingRequests) {
    throw fail("PERFORMER_NOT_ACCEPTING_REQUESTS");
  }

  // 3. Attached event must be the sender org's own.
  if (input.attachedEventId) {
    const event = await deps.repos.events.getById(input.attachedEventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }
    if (event.orgId !== input.organizerOrgId) {
      throw fail("NOT_RESOURCE_OWNER", { meta: { entity: "event" } });
    }
  }

  // 4. One open request per (organizer org, act).
  const open = await deps.repos.bookingRequests.findOpenByOrganizerAndPerformer(
    {
      organizerOrgId: input.organizerOrgId,
      ownerType,
      ownerId: input.performerOwnerId,
    },
  );
  if (open) {
    throw fail("DUPLICATE_OPEN_REQUEST");
  }

  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + BOOKING_REQUEST_TTL_DAYS * DAY_MS);

  // Snapshot the fee currency at create time (platform base — mirrors
  // create-booking-request; only meaningful when an amount is present).
  const feeCurrency =
    input.feeAmountCents !== undefined ? BOOKING_FEE_DEFAULT_CURRENCY : null;

  const created = await deps.repos.tx(async (tx) => {
    const request = await tx.bookingRequests.createToPerformer({
      organizerOrgId: input.organizerOrgId,
      performerOwnerType: ownerType,
      performerOwnerId: input.performerOwnerId,
      message: input.message,
      preferredDates: input.preferredDates,
      setLengthMinutes: input.setLengthMinutes ?? null,
      feeType: input.feeType ?? null,
      feeAmountCents: input.feeAmountCents ?? null,
      feeCurrency,
      attachedEventId: input.attachedEventId ?? null,
      expiresAt,
    });

    // Opens the LEDGER (booking timeline step 2) — same tx as the create.
    await appendBookingSystemEntry(tx, {
      bookingRequestId: request.id,
      kind: "booking_request.opened",
      data: { direction: "TO_PERFORMER", source: "PLATFORM" },
      actorHumanId: input.actorHumanId,
    });

    await tx.audit.log({
      entity: "booking_request",
      entityId: request.id,
      action: "booking_request.created",
      data: {
        direction: "TO_PERFORMER",
        organizerOrgId: input.organizerOrgId,
        performerOwnerType: ownerType,
        performerOwnerId: input.performerOwnerId,
        attachedEventId: input.attachedEventId ?? null,
        actorHumanId: input.actorHumanId,
        expiresAt,
      },
      at: now,
    });

    return request;
  });

  // ── Act notification (FR-006) — post-commit, best-effort ─────────────────
  // The request is durably committed above; a notification failure must never
  // fail the submission. Deliberate swallow → keep the log AND report via
  // ReporterPort so the branch stays visible in Sentry.
  if (deps.notifyOrganizerBookingRequestReceived) {
    try {
      await deps.notifyOrganizerBookingRequestReceived({
        bookingRequest: created,
      });
    } catch (error) {
      deps.logger?.error("booking_requests.notify_organizer_received_failed", {
        bookingRequestId: created.id,
        organizerOrgId: input.organizerOrgId,
        err: error,
      });
      try {
        deps.reportError?.(error, {
          tags: { useCase: "createOrganizerBookingRequest" },
          extra: {
            bookingRequestId: created.id,
            organizerOrgId: input.organizerOrgId,
          },
        });
      } catch {
        // Reporting is best-effort — a throwing reporter must never fail the
        // committed submission.
      }
    }
  }

  deps.logger?.info("booking_requests.created", {
    bookingRequestId: created.id,
    direction: "TO_PERFORMER",
    organizerOrgId: input.organizerOrgId,
    performerOwnerType: ownerType,
    performerOwnerId: input.performerOwnerId,
    actorHumanId: input.actorHumanId,
  });

  return createOrganizerBookingRequestOutputSchema.parse({
    bookingRequestId: created.id,
  });
}
