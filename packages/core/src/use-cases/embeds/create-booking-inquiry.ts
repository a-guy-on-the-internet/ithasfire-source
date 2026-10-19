import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { RateLimitPort, RateLimitResult } from "@th/ports/rate-limit";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { CreateBookingRequestActInput } from "@th/ports/repos/booking-requests";
import type { TurnstilePort } from "@th/ports/turnstile";

import { parseInput } from "../../lib/io";
import { plainTextRequired } from "../../lib/sanitize-plain-text";
import {
  assertPlaceTakesRequests,
  BOOKING_REQUEST_TTL_DAYS,
} from "../booking-requests/create-booking-request";
import {
  BOOKING_FEE_DEFAULT_CURRENCY,
  DAY_MS,
} from "../booking-requests/constants";
import {
  bookingPitchFieldsSchema,
  FEE_ASK_REFINE_PARAMS,
  hasConsistentFeeAsk,
} from "../booking-requests/_shared/pitch-schema";
import { appendBookingSystemEntry } from "../booking-requests/messages/_shared/system-entries";
import {
  anonymousBookingBillSchema,
  type AnonymousBookingBillInput,
} from "../booking-requests/_shared/bill-schema";
import { assertEmbedOriginAllowed } from "./_shared/assert-embed-origin-allowed";
import type { NotifyBookingRequestReceivedFn } from "../booking-requests/notify-booking-request-received";
import { fail } from "@th/errors";

import { findUnavailableBookingDates } from "../booking-requests/_shared/validate-booking-dates";
import { assertBookingStandardsMet } from "../booking-standards/enforce-booking-standards";
import { calendarRequestIntents } from "../booking-standards/load-effective-booking-standards";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pre-refine base object. The transport router derives its public input from
 * this (server-injecting `requestIp`/`requestUserAgent`, mirroring
 * `createEmbedGuestCheckout`), so the field list lives in one place. The use
 * case re-validates the full schema (refine included).
 *
 * The pitch-field rules are the shared `bookingPitchFieldsSchema` fragment —
 * the same validation as the signed-in `createBookingRequest` path (NFR-002:
 * same sanitizer, same bounds), with actName/genre tightened to the
 * sanitizing helper (see the field docs below).
 */
export const createBookingInquiryBaseSchema = bookingPitchFieldsSchema
  .extend({
    embedId: z.uuid(),
    /**
     * Origin of the page hosting the widget iframe, computed client-side.
     * Enforced against the embed's domain allowlist — null fails closed.
     */
    hostOrigin: z.string().url().nullable(),
    /** Cloudflare Turnstile token for bot protection. Required when Turnstile is enabled. */
    turnstileToken: z.string().min(1).max(4096).optional(),
    /** Server-observed client IP, supplied by trusted transports only. */
    requestIp: z.string().trim().min(1).max(128).nullable().optional(),
    /**
     * Server-observed user agent, supplied by trusted transports only.
     * Unused by this step; kept in the schema for symmetry with
     * `createEmbedGuestCheckout` so the transport (step 6) injects both
     * observability fields and step 4 (abuse forensics on the notification
     * path) doesn't need a schema change.
     */
    requestUserAgent: z.string().max(1024).nullable().optional(),
    /** Sanitized short free text — the submitter's own name. */
    contactName: plainTextRequired(120),
    /**
     * Lowercased + trimmed at the boundary; the anonymous dedupe index
     * matches on `lower(contactEmail)` and the column is lowercased at rest.
     */
    contactEmail: z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.string().email().max(320)),
    /**
     * REQUIRED here — an anonymous inquiry has no sender profile to name it.
     * Anonymous free text is fully untrusted (NFR-002), so this path
     * OVERRIDES the shared trim-only actName/genre rules with the sanitizing
     * helper (sanitize-then-min ordering). The signed-in path keeps its
     * pre-existing trim-only rules — a separate follow-up, not this change.
     */
    actName: plainTextRequired(120),
    genre: plainTextRequired(120).optional(),
    /**
     * More acts on the bill (lineup-booking-requests v2, FR-005): FREE TEXT
     * ONLY. `actName` above is always the bill's first row; these follow in
     * order. An anonymous submitter can never tag a platform human — a
     * `tagged` entry or a `humanId` anywhere is a strict-schema 400, so this
     * form is no way to probe who exists on the platform.
     */
    bill: anonymousBookingBillSchema.optional(),
  })
  .strict();

export const createBookingInquiryInputSchema =
  createBookingInquiryBaseSchema.refine(
    hasConsistentFeeAsk,
    FEE_ASK_REFINE_PARAMS,
  );

export const createBookingInquiryOutputSchema = z
  .object({
    bookingRequestId: z.uuid(),
  })
  .strict();

export type CreateBookingInquiryInput = z.infer<
  typeof createBookingInquiryInputSchema
>;
export type CreateBookingInquiryOutput = z.infer<
  typeof createBookingInquiryOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Per-place daily flood cap (security-review follow-up, 2026-07-13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Max anonymous inquiries a single place can receive per fixed window.
 *
 * The per-IP transport limit (5/60s) is trivially dodged by IP rotation, and
 * the open-inquiry dedupe is keyed on attacker-controlled emails — so without
 * a per-PLACE ceiling an attacker can flood a venue's inbox + push
 * notifications indefinitely. 30/day is deliberately generous-but-protective:
 * a real venue receiving 30 distinct anonymous booking requests in one day is
 * already extraordinary (most see a handful per week), while 30 caps the
 * notification fan-out blast radius at nuisance level.
 */
export const BOOKING_INQUIRY_PLACE_DAILY_MAX = 30;
export const BOOKING_INQUIRY_PLACE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Redis bucket key for the per-place daily cap. Keyed by PLACE (not embed):
 * one place can legitimately hold several embeds, and the thing being
 * protected is the venue's inbox, not the widget instance.
 */
export function bookingInquiryPlaceDailyKey(placeId: string): string {
  return `embed:bookingInquiry:place:${placeId}:daily`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type CreateBookingInquiryDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "embeds"
    | "places"
    | "bookingRequests"
    | "audit"
    // Consumed inside the submit tx to open the booking timeline.
    | "bookingRequestMessages"
    // The availability gate reads calendar-scoped rules + calendar spaces
    // (venue-hierarchy FR-007); `placeAvailability` is no longer touched.
    | "calendars"
    | "events"
    // The venue's booking standards for the routed calendar (venue-booking-
    // standards spec, FR-006) — read once, before the flood cap and the write.
    | "bookingStandards"
  >;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Turnstile adapter for bot protection. When enabled, a valid token is required. */
  turnstile?: TurnstilePort | null;
  /**
   * Optional per-place daily flood cap (see BOOKING_INQUIRY_PLACE_DAILY_MAX).
   * Consumed INSIDE the use case — after Turnstile + the place gates and as
   * close to the row write as possible — rather than at the transport
   * middleware layer, so Turnstile-failing bot traffic cannot burn a venue's
   * daily budget and turn the cap itself into a cheap widget DoS. Optional so
   * existing callers/tests keep working; when absent the cap is skipped
   * (the transport threads `ctx.rateLimit`).
   */
  rateLimit?: Pick<RateLimitPort, "consume"> | null;
  /** Base URL of our own web app; its origin is always allowed to host embeds. */
  publicAppUrl?: string | null;
  /**
   * Optional post-commit venue notification (booking-request-embed-button
   * FR-008): in-app + email + push to the place's owners via
   * `notifyBookingRequestReceived`, composed by the transport/composition
   * layer (step 6 threads it from ctx). Optional so existing callers/tests
   * keep working; when present it runs AFTER the transaction committed and is
   * a deliberate swallow (NFR-004) — a throwing notifier never fails the
   * submission.
   */
  notifyBookingRequestReceived?: NotifyBookingRequestReceivedFn;
  /**
   * Best-effort reporter for the notification swallow branch (ReporterPort
   * convention) — without it a broken notifier would be invisible in prod.
   * Also the standards read's degrade branch (a failed read fails OPEN).
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Anonymous booking inquiry via the "Request to book" embed widget
 * (spec 2026-07-13 booking-request-embed-button FR-004/FR-005, NFR-001/002).
 *
 * Checks, in order (fail-closed before any side effect):
 * 1. Embed exists + ACTIVE (a REVOKED embed is indistinguishable from a
 *    missing one).
 * 2. Origin allowlist — `assertEmbedOriginAllowed`; null/unparseable or
 *    non-allowlisted hostOrigin rejects before anything else is read.
 * 3. Subject type must be "place".
 * 4. Turnstile (when enabled): missing token / failed verification reject
 *    before any write.
 * 5. Place gate — exists, CLAIMED (PLACE_NOT_TAKING_REQUESTS otherwise;
 *    amendment 2026-09-25, the same `isClaimedPlace` the signed-in paths
 *    use), VERIFIED, `acceptsBookingRequests` (re-checked server-side
 *    regardless of what the widget rendered). Before the standards, the
 *    bill write and any notification.
 * 6. One open anonymous inquiry per (place, contactEmail) — best-effort
 *    pre-check; the partial unique index `BookingRequest_open_anon_pair_key`
 *    is the authoritative race guard and the adapter's `duplicate_open_request`
 *    is re-surfaced as the same DUPLICATE_OPEN_REQUEST typed error.
 * 6b. The venue's booking standards (venue-booking-standards spec, FR-006)
 *    for the place's DEFAULT calendar — the one this inquiry routes to — and
 *    PERFORM: unmet REQUIRED items → STANDARDS_UNMET, the same list the
 *    signed-in path enforces. Fails OPEN when the read degrades.
 * 7. Per-place daily flood cap (30/day, `deps.rateLimit`) — attacker-
 *    controlled emails dodge the dedupe and IP rotation dodges the transport
 *    per-IP limit, so the venue's inbox needs its own ceiling. Consumed here
 *    (post-Turnstile, pre-write) rather than in middleware so unverified bots
 *    can't burn the budget; fails open on limiter-backend errors.
 *
 * The row is written with a null performer-owner pair (source EMBED, contact
 * fields as the sender identity) and the same TTL as owned requests. Its
 * bill (lineup v2, FR-005) is written in the same transaction: `actName` as
 * row 0 plus any extra free-text acts — never a tagged platform human.
 * Notifications to the venue land in step 4 of the build plan — keep the
 * post-transaction section clean for a `deps.notify` hook.
 */
export async function createBookingInquiry(
  deps: CreateBookingInquiryDeps,
  rawInput: unknown,
): Promise<CreateBookingInquiryOutput> {
  const logger = deps.logger?.child({ useCase: "createBookingInquiry" });

  const execute = async () => {
    const input = parseInput(createBookingInquiryInputSchema, rawInput);

    // ── 1-2. Embed + host origin (fail closed, before any other read) ──────
    const embed = await deps.repos.embeds.getById(input.embedId);
    if (!embed || embed.status !== "ACTIVE") {
      throw fail("EMBED_NOT_FOUND");
    }

    assertEmbedOriginAllowed({
      embed,
      hostOrigin: input.hostOrigin,
      publicAppUrl: deps.publicAppUrl,
      logger,
    });

    // ── 3. Only "place" embeds accept booking inquiries ────────────────────
    if (embed.subjectType !== "place") {
      throw fail("UNSUPPORTED_SUBJECT_TYPE");
    }

    // ── 4. Turnstile (bot protection) ───────────────────────────────────────
    if (deps.turnstile?.enabled) {
      if (!input.turnstileToken) {
        throw fail("TURNSTILE_TOKEN_REQUIRED");
      }
      const valid = await deps.turnstile.verify(
        input.turnstileToken,
        input.requestIp ?? undefined,
      );
      if (!valid) {
        logger?.warn("createBookingInquiry.turnstileFailed", {
          embedId: input.embedId,
        });
        throw fail("TURNSTILE_VERIFICATION_FAILED");
      }
      logger?.info("createBookingInquiry.turnstilePassed", {
        embedId: input.embedId,
      });
    }

    // ── 5. Place gate (same rules as the signed-in create path) ────────────
    // An unclaimed venue takes no requests (amendment 2026-09-25) — the same
    // helper, and so the same predicate, as `createBookingRequest`.
    const place = assertPlaceTakesRequests(
      await deps.repos.places.getById(embed.subjectId),
    );
    if (place.verificationStatus !== "VERIFIED") {
      throw fail("PLACE_NOT_VERIFIED");
    }
    if (!place.acceptsBookingRequests) {
      throw fail("PLACE_NOT_ACCEPTING_REQUESTS");
    }

    // Availability-onboarding FR-005 (docs/specs/2026-08-31): an unconfigured
    // place (zero CalendarAvailability rows) is publicly "not taking requests
    // right now" — the embed must fail closed exactly like the main-site
    // create path, or it becomes the hole this closes. Same house code as the
    // paused-venue refusal, distinct machine message for the widget copy.
    const availabilityRowCount =
      await deps.repos.calendars.countAvailabilityForPlace(place.id);
    if (availabilityRowCount === 0) {
      throw fail("PLACE_NOT_ACCEPTING_REQUESTS", {
        message: "booking_requests_unconfigured",
        meta: { placeId: place.id },
      });
    }

    // Same availability gate as the signed-in path: the embed widget is the
    // LEAST trusted entrance, so it must not be the one that skips the check.
    const unavailable = await findUnavailableBookingDates(
      { repos: deps.repos, logger: deps.logger, now: () => deps.clock.now() },
      { placeId: place.id, dates: input.preferredDates },
    );
    if (unavailable.length > 0) {
      throw fail("BOOKING_DATE_UNAVAILABLE", {
        meta: {
          dates: unavailable.map((p) => p.value),
          reasons: unavailable.map((p) => p.reason),
        },
      });
    }

    // ── 6. One open UNCLAIMED inquiry per (place, contactEmail) ────────────
    // This pre-check carries more weight than it used to. Its DB backstop,
    // "BookingRequest_open_anon_pair_key", is predicated on `performerOwnerId
    // IS NULL` — and since booking-inquirer-outreach an inquiry the venue has
    // replied to carries a SHADOW owner pair, which drops out of that index
    // with nothing keyed on the address taking over. The finder is scoped by
    // CLAIM STATE (not a null owner) precisely so this rule still holds across
    // that window; see its port doc.
    const open = await deps.repos.bookingRequests.findOpenByContactEmailAndPlace(
      { placeId: place.id, contactEmail: input.contactEmail },
    );
    if (open) {
      throw fail("DUPLICATE_OPEN_REQUEST");
    }

    // ── 6b. The venue's booking standards (FR-006) ──────────────────────────
    // Same enforcement as the signed-in pitch, on the calendar this inquiry
    // routes to: the embed never names one, so it is the place's DEFAULT —
    // read ONCE here and reused for the routing inside the transaction below.
    // Read before the flood cap, so a refused inquiry never spends the
    // venue's daily budget. The widget's inquiry is a PERFORM pitch; its bill
    // is `actName` (row 0) + `bill.acts`, so a REQUIRED bill is met only by
    // ≥ 1 extra act — the same "besides the sender" rule.
    //
    // A default calendar that no longer takes PERFORM resolves as NO calendar
    // (place → platform): its leftover PERFORM rows are ones the options read
    // never serves and the calendar editor no longer shows, so the venue could
    // neither see nor clear what would be blocking here.
    const routedCalendar = await deps.repos.calendars.findDefaultForPlace(
      place.id,
    );
    await assertBookingStandardsMet(
      { repos: deps.repos, logger, reportError: deps.reportError },
      {
        place,
        calendarId:
          routedCalendar &&
          calendarRequestIntents(routedCalendar).includes("PERFORM")
            ? routedCalendar.id
            : null,
        intent: "PERFORM",
        payload: input,
      },
    );

    // ── 7. Per-place daily flood cap ────────────────────────────────────────
    // Deliberately LAST before the write: requests failing Turnstile, the
    // place gates, or the dedupe above never burn the venue's budget — only a
    // request that would otherwise create a row (and fan out notifications)
    // consumes a token. Race losers against the unique index below do burn a
    // token (fixed-window, no refunds), which is fine at this budget.
    if (deps.rateLimit) {
      let capResult: RateLimitResult | null = null;
      try {
        capResult = await deps.rateLimit.consume(
          bookingInquiryPlaceDailyKey(place.id),
          BOOKING_INQUIRY_PLACE_DAILY_MAX,
          BOOKING_INQUIRY_PLACE_DAILY_WINDOW_SECONDS,
        );
      } catch (error) {
        // Fail open, matching the transport limiter's stance: an abuse cap
        // must never take down legitimate submissions because a Redis counter
        // couldn't be incremented. Deliberate swallow → log AND report
        // (ReporterPort convention) so a broken limiter stays visible.
        logger?.error("booking_requests.place_daily_cap_consume_failed", {
          placeId: place.id,
          embedId: input.embedId,
          err: error,
        });
        try {
          deps.reportError?.(error, {
            tags: { useCase: "createBookingInquiry" },
            extra: { placeId: place.id, embedId: input.embedId },
          });
        } catch {
          // Reporting is best-effort — a throwing reporter must never turn
          // the fail-open allow into a thrown error.
        }
      }
      if (capResult && !capResult.allowed) {
        logger?.warn("booking_requests.place_daily_cap_exceeded", {
          placeId: place.id,
          embedId: input.embedId,
          retryAfterSeconds: capResult.retryAfterSeconds,
        });
        // RATE_LIMITED → TOO_MANY_REQUESTS at the tRPC boundary — the widget
        // already renders an inline message for that code. The message makes
        // the "venue is full for today" case distinguishable from the per-IP
        // limit without minting a new error code.
        throw fail("RATE_LIMITED", {
          message:
            "This place has reached today's booking request limit. Please try again tomorrow.",
          meta: {
            scope: "booking_inquiry_place_daily",
            retryAfterSeconds: capResult.retryAfterSeconds,
          },
        });
      }
    }

    const now = deps.clock.now();
    const expiresAt = new Date(
      now.getTime() + BOOKING_REQUEST_TTL_DAYS * DAY_MS,
    );

    // Snapshot the fee currency at create time (same convention as the
    // signed-in path): only meaningful when an amount is present.
    const feeCurrency =
      input.feeAmountCents !== undefined ? BOOKING_FEE_DEFAULT_CURRENCY : null;

    let created;
    try {
      created = await deps.repos.tx(async (tx) => {
        // ── Calendar routing (FR-008), mirroring the signed-in path ─────────
        // The embed widget never names a calendar, so this routes to the
        // place's default — which is ALSO the calendar the availability gate
        // above answered against. Leaving it null would put the request on an
        // unrouted row the venue sees on no calendar, while its dates had been
        // judged against the default's hours and spaces: the gate and the
        // inbox disagreeing about which stream the ask was for. Null stays
        // valid for a place with no calendars at all. (The default was read
        // once, at the standards gate above.)
        const calendarId = routedCalendar?.id ?? null;

        const request = await tx.bookingRequests.create({
          placeId: place.id,
          calendarId,
          contactName: input.contactName,
          // Already lowercased by the schema; the adapter lowercases
          // defensively too.
          contactEmail: input.contactEmail,
          source: "EMBED",
          embedId: input.embedId,
          message: input.message,
          preferredDates: input.preferredDates,
          expectedDraw: input.expectedDraw ?? null,
          genre: input.genre ?? null,
          actName: input.actName,
          lineupSize: input.lineupSize ?? null,
          setLengthMinutes: input.setLengthMinutes ?? null,
          techNeeds: input.techNeeds ?? null,
          feeType: input.feeType ?? null,
          feeAmountCents: input.feeAmountCents ?? null,
          feeCurrency,
          linkMusic: input.linkMusic ?? null,
          linkVideo: input.linkVideo ?? null,
          linkSocial: input.linkSocial ?? null,
          linkEpk: input.linkEpk ?? null,
          // Lineup v3 L12: an inquiry always records a bill (its `actName`
          // is row 0, below), so the mint never treats it as pre-bill.
          billRecorded: true,
          expiresAt,
        });

        // The bill (lineup v2, FR-005), same tx: the inquiry's own act is
        // row 0 and every extra is free text. An anonymous inquiry has no
        // sender pair, so never a SELF row (the adapter would refuse one).
        await tx.bookingRequests.addActs(
          request.id,
          buildAnonymousBillRows(input.actName, input.bill),
        );

        // Opens the LEDGER (booking timeline step 2). This is the ONLY
        // producer of `source: "EMBED"`, and an anonymous inquiry has no
        // signed-in actor — hence the null `actorHumanId` (machine/guest
        // caused). Same tx as the create.
        await appendBookingSystemEntry(tx, {
          bookingRequestId: request.id,
          kind: "booking_request.opened",
          data: { direction: "TO_VENUE", source: "EMBED" },
          actorHumanId: null,
        });

        await tx.audit.log({
          entity: "booking_request",
          entityId: request.id,
          action: "booking_request.created",
          data: {
            placeId: place.id,
            // The stream this ask was routed to — and the same one the
            // availability gate above judged its dates against. Logged for the
            // same reason the signed-in path logs it: "which calendar was this
            // for" is the question the audit trail gets asked.
            calendarId: request.calendarId,
            source: "embed",
            embedId: input.embedId,
            contactEmail: input.contactEmail,
            expiresAt,
          },
          at: now,
        });

        return request;
      });
    } catch (error) {
      // Race loser against the partial unique index: the adapter maps the
      // P2002 to `duplicate_open_request`; surface it as the SAME typed error
      // as the pre-check above so the widget shows one consistent message.
      if (isAdapterDuplicateOpenRequest(error)) {
        throw fail("DUPLICATE_OPEN_REQUEST", { cause: error });
      }
      throw error;
    }

    // ── Venue notification (FR-008) — post-commit, best-effort (NFR-004) ────
    // The inquiry is durably committed above; a notification failure must
    // never fail the submission. Deliberate swallow → keep the log AND report
    // via ReporterPort so the branch stays visible in Sentry.
    if (deps.notifyBookingRequestReceived) {
      try {
        await deps.notifyBookingRequestReceived({
          bookingRequest: created,
          place,
        });
      } catch (error) {
        logger?.error("booking_requests.notify_received_failed", {
          bookingRequestId: created.id,
          placeId: place.id,
          embedId: input.embedId,
          err: error,
        });
        try {
          deps.reportError?.(error, {
            tags: { useCase: "createBookingInquiry" },
            extra: {
              bookingRequestId: created.id,
              placeId: place.id,
              embedId: input.embedId,
            },
          });
        } catch {
          // Reporting is best-effort — a throwing reporter must never fail
          // the committed submission.
        }
      }
    }

    logger?.info("booking_requests.inquiry_created", {
      bookingRequestId: created.id,
      placeId: place.id,
      embedId: input.embedId,
      source: "EMBED",
    });

    return createBookingInquiryOutputSchema.parse({
      bookingRequestId: created.id,
    });
  };

  if (logger) {
    return logger.withTime("createBookingInquiry", execute);
  }
  return execute();
}

/**
 * An anonymous inquiry's bill rows: the submitted `actName` at sortOrder 0,
 * then the extra free-text acts in order — distinct sortOrders, all
 * EXTERNAL (confirmed at insert: free text has nobody to ask).
 */
function buildAnonymousBillRows(
  actName: string,
  bill: AnonymousBookingBillInput | undefined,
): CreateBookingRequestActInput[] {
  const rows: CreateBookingRequestActInput[] = [
    {
      source: "EXTERNAL",
      externalName: actName,
      sortOrder: 0,
      role: "PERFORMER",
    },
  ];
  for (const act of bill?.acts ?? []) {
    rows.push({
      source: "EXTERNAL",
      externalName: act.name,
      externalUrl: act.url ?? null,
      sortOrder: rows.length,
      role: "PERFORMER",
    });
  }
  return rows;
}

/** Narrow the prisma adapter's mapped open-pair unique violation. */
function isAdapterDuplicateOpenRequest(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "duplicate_open_request"
  );
}
